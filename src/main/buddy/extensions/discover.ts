import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  AssignBlock,
  ConfigLocation,
  DiscoveredInstance,
  ResolvedTarget,
  ScanProblem,
  ScanStatus,
  TargetScan
} from '../../../shared/extensions'
import { mcpServersFromJson, mcpServersFromToml, readSkillFrontmatter, type McpEntry } from './parse'

const MAX_VISITS = 400
const MAX_SKILLS = 200
const MAX_SKILL_BYTES = 256 * 1024
const MAX_MCP_BYTES = 2 * 1024 * 1024
const SKIP = new Set(['node_modules', '.git', 'dist'])

export function aggregateScanStatus(problems: ScanProblem[], instanceCount: number): ScanStatus {
  const hard = problems.some((problem) => problem.code !== 'uninitialized')
  const uninitialized = problems.some((problem) => problem.code === 'uninitialized')
  if (hard && instanceCount === 0) return 'read_failed'
  if (hard) return 'partial'
  if (uninitialized && instanceCount === 0) return 'uninitialized'
  if (uninitialized) return 'partial'
  if (instanceCount === 0) return 'empty'
  return 'ok'
}

export async function scanTarget(target: ResolvedTarget, kind: 'skill' | 'mcp'): Promise<TargetScan> {
  if (target.resolution === 'unrecognized') return emptyScan(target, 'unrecognized', 'none', 'not_applicable', kind)
  if (target.discovery !== 'filesystem') return emptyScan(target, 'unsupported', 'none', 'not_applicable', kind)

  const problems: ScanProblem[] = []
  const instances: DiscoveredInstance[] = []
  const seen = new Set<string>()
  for (const location of target.locations) {
    if (location.kind !== (kind === 'skill' ? 'skills' : 'mcp')) continue
    if (location.error || location.missingMeans === 'read_failed') {
      problems.push({ code: location.error ?? 'read_failed', path: location.path })
      continue
    }
    if (!location.scan) {
      if (location.missingMeans === 'uninitialized') problems.push({ code: 'uninitialized', path: location.path })
      continue
    }
    if (kind === 'skill') await readSkillRoot(target, location, instances, problems, seen)
    else await readMcpFile(target, location, instances, problems, seen)
  }

  return {
    actor: target.actor,
    adapter: target.adapter,
    fingerprint: target.fingerprint,
    status: aggregateScanStatus(problems, instances.length),
    method: 'filesystem_fallback',
    completeness: 'filesystem_partial',
    problems,
    instances,
    notes: target.notes,
    assignBlock: assignBlockFor(target, kind)
  }
}

export function assignBlockFor(
  target: ResolvedTarget,
  kind: 'skill' | 'mcp' | 'instruction' | 'subagent' | 'hook'
): AssignBlock {
  if (target.resolution === 'unrecognized') return 'unrecognized'
  if (target.resolution === 'unsupported' || target.discovery !== 'filesystem') return 'unsupported'
  if (!target.writesNativeConfig) return 'unsupported'
  const locationKind =
    kind === 'skill' ? 'skills'
      : kind === 'mcp' ? 'mcp'
        : kind === 'instruction' ? 'instructions'
          : kind === 'subagent' ? 'subagents'
            : 'hooks'
  const location = target.locations.find((item) => item.kind === locationKind && item.scope === 'user')
  if (!location) return 'unsupported'
  if (location.missingMeans === 'uninitialized' || location.note === 'acp_private_uninitialized') return 'uninitialized'
  if (location.error || location.missingMeans === 'read_failed') return 'read_failed'
  return 'none'
}

export async function describeLocalSkill(skillDir: string): Promise<{ ok: true; instance: DiscoveredInstance } | { ok: false; code: 'not_found' | 'unsupported' | 'not_directory' | 'missing_skill' }> {
  let info
  try {
    info = await lstat(skillDir)
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unsupported' }
  }
  if (info.isSymbolicLink()) {
    const followed = await stat(skillDir).catch(() => null)
    if (!followed?.isDirectory()) return { ok: false, code: 'not_directory' }
  } else if (!info.isDirectory()) {
    return { ok: false, code: 'not_directory' }
  }
  const skillFile = join(skillDir, 'SKILL.md')
  try {
    const skillInfo = await lstat(skillFile)
    if (!skillInfo.isFile() && !skillInfo.isSymbolicLink()) return { ok: false, code: 'missing_skill' }
  } catch (error) {
    return { ok: false, code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_skill' : 'unsupported' }
  }
  const problems: ScanProblem[] = []
  const instance = await skillInstance(localTarget(), localLocation(), skillDir, problems)
  if (!instance) return { ok: false, code: 'missing_skill' }
  return { ok: true, instance }
}

function localTarget(): ResolvedTarget {
  return {
    actor: '',
    protocol: 'cli',
    adapter: 'unrecognized',
    command: '',
    args: [],
    cwd: '',
    fingerprint: '',
    resolution: 'ready',
    discovery: 'filesystem',
    envKeys: [],
    versionStatus: 'not_probed',
    writesNativeConfig: false,
    locations: [],
    notes: []
  }
}

function localLocation(): ConfigLocation {
  return {
    id: 'local',
    path: '',
    kind: 'skills',
    scope: 'user',
    exists: true,
    isDirectory: true,
    linkSource: null,
    scan: false,
    missingMeans: 'empty'
  }
}

async function readSkillRoot(
  target: ResolvedTarget,
  location: ConfigLocation,
  instances: DiscoveredInstance[],
  problems: ScanProblem[],
  seen: Set<string>
): Promise<void> {
  const found: string[] = []
  const visits = { count: 0, truncated: false }
  await walkSkills(location.path, location.scope === 'plugin' ? 8 : 3, found, problems, visits, new Set<string>())
  if (visits.truncated) problems.push({ code: 'truncated', path: location.path })
  for (const skillDir of found) {
    if (instances.length >= MAX_SKILLS) {
      problems.push({ code: 'truncated', path: skillDir })
      break
    }
    const instance = await skillInstance(target, location, skillDir, problems)
    if (!instance) continue
    const key = `${instance.realpath}\0${instance.nativeKey ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    instances.push(instance)
  }
}

async function walkSkills(
  directory: string,
  depth: number,
  found: string[],
  problems: ScanProblem[],
  visits: { count: number; truncated: boolean },
  seenDirs: Set<string>
): Promise<void> {
  if (visits.count >= MAX_VISITS || found.length >= MAX_SKILLS) {
    visits.truncated = true
    return
  }
  visits.count += 1
  let real: string
  try {
    real = await realpath(directory)
  } catch (error) {
    problems.push({ code: errnoCode(error), path: directory })
    return
  }
  if (seenDirs.has(real)) return
  seenDirs.add(real)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    problems.push({ code: errnoCode(error), path: directory })
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
    const path = join(directory, entry.name)
    let linked = false
    try {
      const lst = await lstat(path)
      linked = lst.isSymbolicLink()
      if (!lst.isDirectory() && !lst.isSymbolicLink()) continue
    } catch (error) {
      problems.push({ code: errnoCode(error), path })
      continue
    }
    if (linked) {
      try {
        const followed = await stat(path)
        if (!followed.isDirectory()) continue
      } catch (error) {
        problems.push({ code: errnoCode(error), path })
        continue
      }
    }
    const skillFile = join(path, 'SKILL.md')
    try {
      const skillStat = await lstat(skillFile)
      if (skillStat.isFile() || skillStat.isSymbolicLink()) {
        found.push(path)
        continue
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') problems.push({ code: errnoCode(error), path: skillFile })
    }
    if (depth > 1) await walkSkills(path, depth - 1, found, problems, visits, seenDirs)
  }
}

async function skillInstance(
  target: ResolvedTarget,
  location: ConfigLocation,
  skillDir: string,
  problems: ScanProblem[]
): Promise<DiscoveredInstance | null> {
  const skillFile = join(skillDir, 'SKILL.md')
  let physical = skillDir
  try {
    physical = await realpath(skillDir)
  } catch (error) {
    problems.push({ code: errnoCode(error), path: skillDir })
    return null
  }
  let linkSource = location.linkSource
  try {
    const lst = await lstat(skillDir)
    if (lst.isSymbolicLink()) linkSource = await readlinkSafe(skillDir)
  } catch {
    linkSource = location.linkSource
  }
  let text = ''
  let contentHash: string | null = null
  try {
    const info = await stat(skillFile)
    if (!info.isFile()) {
      problems.push({ code: 'not_directory', path: skillFile })
      return baseInstance(target, location, skillDir, physical, linkSource, basename(skillDir), '', null)
    }
    if (info.size > MAX_SKILL_BYTES) {
      problems.push({ code: 'too_large', path: skillFile })
      return baseInstance(target, location, skillDir, physical, linkSource, basename(skillDir), '', null)
    }
    text = await readFile(skillFile, 'utf8')
    contentHash = digest(text)
  } catch (error) {
    problems.push({ code: errnoCode(error), path: skillFile })
    return baseInstance(target, location, skillDir, physical, linkSource, basename(skillDir), '', null)
  }
  const frontmatter = readSkillFrontmatter(text)
  return baseInstance(
    target,
    location,
    skillDir,
    physical,
    linkSource,
    frontmatter.name || basename(skillDir),
    frontmatter.description ?? '',
    contentHash
  )
}

function baseInstance(
  target: ResolvedTarget,
  location: ConfigLocation,
  path: string,
  physical: string,
  linkSource: string | null,
  name: string,
  description: string,
  contentHash: string | null,
  nativeKey: string | null = null,
  envKeys: string[] = []
): DiscoveredInstance {
  const ownership = location.scope === 'plugin' ? 'plugin' : location.scope === 'shared' ? 'shared' : 'user'
  return {
    id: digest([target.actor, 'skill', location.scope, path, nativeKey ?? ''].join('\0')),
    shareKey: digest(['skill', physical, nativeKey ?? ''].join('\0')),
    kind: nativeKey ? 'mcp' : 'skill',
    name,
    description,
    actor: target.actor,
    scope: location.scope,
    path,
    realpath: physical,
    linkSource,
    nativeKey,
    ownership,
    readOnly: ownership === 'plugin',
    contentHash,
    envKeys,
    sharedWith: []
  }
}

async function readMcpFile(
  target: ResolvedTarget,
  location: ConfigLocation,
  instances: DiscoveredInstance[],
  problems: ScanProblem[],
  seen: Set<string>
): Promise<void> {
  let info
  try {
    info = await stat(location.path)
  } catch (error) {
    problems.push({ code: errnoCode(error), path: location.path })
    return
  }
  if (info.size > MAX_MCP_BYTES) {
    problems.push({ code: 'too_large', path: location.path })
    return
  }
  let text = ''
  try {
    text = await readFile(location.path, 'utf8')
  } catch (error) {
    problems.push({ code: errnoCode(error), path: location.path })
    return
  }
  if (!text.trim()) return
  const parsed = location.path.endsWith('.toml')
    ? mcpServersFromToml(text)
    : mcpServersFromJson(
      text,
      location.path.endsWith('opencode.json')
        ? ['mcp', 'mcpServers']
        : location.path.endsWith('mcp_config.json') || location.path.endsWith('mcp.json')
          ? ['mcpServers', 'mcp']
          : ['mcpServers']
    )
  if (parsed.invalid) problems.push({ code: 'parse_failed', path: location.path })
  if (parsed.invalid && parsed.entries.length === 0) return
  let physical = location.path
  try {
    physical = await realpath(location.path)
  } catch (error) {
    problems.push({ code: errnoCode(error), path: location.path })
    return
  }
  for (const entry of parsed.entries) pushMcp(target, location, physical, entry, instances, seen)
}

function pushMcp(
  target: ResolvedTarget,
  location: ConfigLocation,
  physical: string,
  entry: McpEntry,
  instances: DiscoveredInstance[],
  seen: Set<string>
): void {
  const shareKey = digest(['mcp', physical, entry.name].join('\0'))
  if (seen.has(`${target.actor}\0${shareKey}`)) return
  seen.add(`${target.actor}\0${shareKey}`)
  const description = [entry.command, entry.url].filter(Boolean).join(' ')
  instances.push({
    ...baseInstance(target, location, location.path, physical, location.linkSource, entry.name, description, digest(description), entry.name, entry.envKeys),
    id: digest([target.actor, 'mcp', location.scope, physical, entry.name].join('\0')),
    shareKey,
    kind: 'mcp'
  })
}

function emptyScan(
  target: ResolvedTarget,
  status: ScanStatus,
  method: TargetScan['method'],
  completeness: TargetScan['completeness'],
  kind: 'skill' | 'mcp'
): TargetScan {
  return {
    actor: target.actor,
    adapter: target.adapter,
    fingerprint: target.fingerprint,
    status,
    method,
    completeness,
    problems: [],
    instances: [],
    notes: target.notes,
    assignBlock: assignBlockFor(target, kind)
  }
}

function errnoCode(error: unknown): ScanProblem['code'] {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return 'broken_link'
  if (code === 'EACCES' || code === 'EPERM') return 'read_failed'
  if (code === 'ENOTDIR') return 'not_directory'
  return 'read_failed'
}

async function readlinkSafe(path: string): Promise<string | null> {
  try {
    return await readlink(path)
  } catch {
    return null
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}
