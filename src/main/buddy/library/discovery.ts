import { readdir, readFile, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DiscoveredMcpServer,
  DiscoveredSkill,
  LibraryMcpServer,
  LibrarySkillRecord,
  LibraryTarget,
  McpTransport
} from '../../../shared/library'
import { listMcpServersFromJsonc, readJsoncObject } from './edit/jsonc'
import { getMcpServerTable, listMcpServerTables, readTomlText } from './edit/toml'
import { isGitRoot } from './store'

function transportOf(raw: Record<string, unknown>): McpTransport {
  const t = String(raw.type || raw.transport || '').toLowerCase()
  if (t === 'http' || t === 'streamable-http' || t === 'streamable_http') return 'http'
  if (t === 'sse') return 'sse'
  if (raw.command) return 'stdio'
  if (raw.url) return t === 'sse' ? 'sse' : 'http'
  return 'unknown'
}

function summaryOf(raw: Record<string, unknown>): string {
  if (typeof raw.command === 'string') {
    const args = Array.isArray(raw.args) ? raw.args.map(String).join(' ') : ''
    return args ? `${raw.command} ${args}` : raw.command
  }
  if (typeof raw.url === 'string') return raw.url
  return transportOf(raw)
}

async function readSkillMeta(dir: string): Promise<{ name: string; description?: string } | undefined> {
  try {
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim()
      || /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
      || dir.split(/[/\\]/).filter(Boolean).pop()
      || 'skill'
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim()
      || undefined
    return { name, description }
  } catch {
    return undefined
  }
}

export async function discoverSkills(
  targets: LibraryTarget[],
  librarySkills: LibrarySkillRecord[]
): Promise<DiscoveredSkill[]> {
  const importedKeys = new Set(
    librarySkills.flatMap((s) => [s.libraryPath, s.originPath].filter(Boolean) as string[])
  )
  const out: DiscoveredSkill[] = []
  const seen = new Set<string>()

  for (const target of targets) {
    if (!target.skillsDir || target.pendingInit || !target.capabilities.readSkills) continue
    let entries
    try {
      entries = await readdir(target.skillsDir, { withFileTypes: true })
    } catch (error) {
      // Keep other targets; caller surfaces aggregate errors separately.
      continue
    }
    for (const entry of entries) {
      // Match Magpie's user skill directory names; skip hidden and namespaced entries.
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.name)) continue
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(target.skillsDir, entry.name)
      const physicalKey = await realpath(path).catch(() => undefined)
      if (!physicalKey || seen.has(physicalKey)) continue
      if (physicalKey.split('/').includes('.system') || /\/plugins\/(cache|marketplaces)\//.test(physicalKey)) continue
      const meta = await readSkillMeta(path)
      if (!meta) continue
      seen.add(physicalKey)
      const link = await lstat(path).then((s) => s.isSymbolicLink()).catch(() => false)
      const git = await isGitRoot(path)
      const alreadyImported = importedKeys.has(physicalKey) || librarySkills.some((s) => s.name === meta.name && s.managed)
      out.push({
        discoveryId: physicalKey,
        name: meta.name,
        description: meta.description,
        path,
        physicalKey,
        targetId: target.targetId,
        agentId: target.agentId,
        scope: target.scope,
        isSymlink: link,
        isGitRoot: git,
        alreadyImported,
        importBlockedReason: git ? 'git-root' : link ? 'symlink' : undefined
      })
    }
  }
  return out
}

async function readServersFromTarget(target: LibraryTarget): Promise<Array<{ name: string; raw: Record<string, unknown>; path: string; physicalKey: string }>> {
  if (!target.mcpPath || target.pendingInit || !target.capabilities.readMcp) return []
  if (target.mcpFormat === 'jsonc-mcpServers') {
    try {
      const { value } = await readJsoncObject(target.mcpPath)
      // OpenCode may use top-level mcp instead of mcpServers.
      const servers = {
        ...listMcpServersFromJsonc(value),
        ...(value.mcp && typeof value.mcp === 'object' && !Array.isArray(value.mcp)
          ? Object.fromEntries(
              Object.entries(value.mcp as Record<string, unknown>)
                .filter(([, v]) => v && typeof v === 'object')
                .map(([k, v]) => [k, v as Record<string, unknown>])
            )
          : {})
      }
      return Object.entries(servers).map(([name, raw]) => ({
        name,
        raw,
        path: target.mcpPath!,
        physicalKey: target.mcpPhysicalKey || target.mcpPath!
      }))
    } catch {
      return []
    }
  }
  if (target.mcpFormat === 'toml-mcp_servers') {
    try {
      const text = await readTomlText(target.mcpPath)
      return listMcpServerTables(text).map((name) => ({
        name,
        raw: getMcpServerTable(text, name) || {},
        path: target.mcpPath!,
        physicalKey: target.mcpPhysicalKey || target.mcpPath!
      }))
    } catch {
      return []
    }
  }
  return []
}

export async function discoverMcpServers(
  targets: LibraryTarget[],
  libraryServers: LibraryMcpServer[]
): Promise<DiscoveredMcpServer[]> {
  const out: DiscoveredMcpServer[] = []
  for (const target of targets) {
    const entries = await readServersFromTarget(target)
    for (const entry of entries) {
      const alreadyImported = libraryServers.some(
        (s) => s.name === entry.name && (s.sourceTargetId === target.targetId || s.assignedTargetIds.includes(target.targetId))
      )
      out.push({
        discoveryId: `${target.targetId}:${entry.name}:${entry.physicalKey}`,
        name: entry.name,
        transport: transportOf(entry.raw),
        summary: summaryOf(entry.raw),
        targetId: target.targetId,
        agentId: target.agentId,
        scope: target.scope,
        path: entry.path,
        physicalKey: entry.physicalKey,
        alreadyImported,
        raw: entry.raw
      })
    }
  }
  return out
}

export { transportOf, summaryOf }
