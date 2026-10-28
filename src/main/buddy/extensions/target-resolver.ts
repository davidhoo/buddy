import { createHash } from 'node:crypto'
import { lstat, readlink, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Launcher } from '../../../shared/types'
import type {
  ConfigLocation,
  ExtensionAdapter,
  LocationKind,
  LocationNote,
  MissingMeans,
  ResolvedTarget,
  ScanProblemCode,
  TargetNote
} from '../../../shared/extensions'
import { commandKindFor, splitCommand, type LauncherCommandKind } from '../launchers'
import { redactSensitiveText } from '../redact'

const SAFE_ACTOR = /^[a-zA-Z0-9._-]{1,64}$/

export interface ResolveTargetInput {
  actor: string
  launcher: Launcher
  cwd?: string
  homeDir: string
  dataRoot: string
  /** Test seam. The service passes process.env; tests pass an explicit map. */
  processEnv?: Record<string, string | undefined>
}

interface DirectoryState {
  exists: boolean
  isDirectory: boolean
  linkSource: string | null
  error?: ScanProblemCode
}

export async function resolveExtensionTarget(input: ResolveTargetInput): Promise<ResolvedTarget> {
  const launcher = input.launcher
  const env = launcher.env ?? {}
  const processEnv = input.processEnv ?? {}
  const home = firstText(env.HOME, processEnv.HOME, input.homeDir)
  const protocol = launcher.protocol === 'acp' ? 'acp' : 'cli'
  const program = detectProgram(input.actor, launcher)
  const safeActor = SAFE_ACTOR.test(input.actor)
  const isolatesCodex =
    protocol === 'acp' &&
    (input.actor === 'codex' || input.actor === 'wecode_codex') &&
    !env.CODEX_HOME &&
    safeActor
  const sourceCodex = firstText(env.CODEX_HOME, processEnv.CODEX_HOME, join(home, '.codex'))
  const codexHome = env.CODEX_HOME ? env.CODEX_HOME : isolatesCodex ? join(input.dataRoot, 'acp', input.actor, 'codex-home') : sourceCodex
  const claudeConfig = firstText(env.CLAUDE_CONFIG_DIR, processEnv.CLAUDE_CONFIG_DIR, join(home, '.claude'))
  const xdg = firstText(env.XDG_CONFIG_HOME, processEnv.XDG_CONFIG_HOME, join(home, '.config'))
  const opencodeConfig = join(xdg, 'opencode')
  const cursorHome = join(home, '.cursor')
  const geminiHome = firstText(env.GEMINI_HOME, processEnv.GEMINI_HOME, join(home, '.gemini'))
  const kimiHome = firstText(env.KIMI_CODE_HOME, processEnv.KIMI_CODE_HOME, join(home, '.kimi-code'))
  const dshHome = firstText(env.DSH_HOME, processEnv.DSH_HOME, join(home, '.dsh'))
  const projectCwd = await usableCwd(input.cwd)

  const notes: TargetNote[] = ['assign_not_ready']
  if (input.actor.startsWith('wecode_') && program.recognized) notes.push('wecode_family_unverified')
  if (program.recognized && expectedAdapter(input.actor) && expectedAdapter(input.actor) !== program.adapter) {
    notes.push('program_differs_from_actor')
  }
  if (isolatesCodex) notes.push('acp_codex_home')
  if (isolatesCodex && program.adapter === 'codex') notes.push('desktop_skills_not_attributed')

  const locations = await locationsFor({
    adapter: program.adapter,
    recognized: program.recognized,
    home,
    claudeConfig,
    codexHome,
    sourceCodex,
    isolatesCodex,
    opencodeConfig,
    cursorHome,
    geminiHome,
    kimiHome,
    dshHome,
    projectCwd,
    privateCodex: isolatesCodex ? join(input.dataRoot, 'acp', input.actor, 'codex-home') : null
  })
  if (isolatesCodex && program.adapter !== 'codex') {
    locations.push(await planned(
      'codex-acp-home',
      join(input.dataRoot, 'acp', input.actor, 'codex-home'),
      'execution_env',
      'user',
      'ignore',
      undefined,
      'execution_env_not_scanned'
    ))
  }

  const discovery = !program.recognized
    ? 'none'
    : FILESYSTEM_ADAPTERS.has(program.adapter)
      ? 'filesystem'
      : 'unsupported'
  const writesNativeConfig = program.recognized && WRITE_READY_ADAPTERS.has(program.adapter)
  const resolution = !program.recognized ? 'unrecognized' : discovery === 'unsupported' ? 'unsupported' : 'ready'
  const fingerprint = digest(JSON.stringify({
    actor: input.actor,
    protocol,
    adapter: program.adapter,
    command: launcher.command,
    args: launcher.args ?? [],
    env: Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
    cwd: projectCwd,
    dataRoot: input.dataRoot,
    home,
    claudeConfig,
    codexHome,
    opencodeConfig,
    cursorHome,
    geminiHome,
    kimiHome,
    dshHome
  }))

  return {
    actor: input.actor,
    protocol,
    adapter: program.adapter,
    command: redactSensitiveText(launcher.command ?? ''),
    args: (launcher.args ?? []).map((arg) => redactSensitiveText(arg)),
    cwd: projectCwd,
    fingerprint,
    resolution,
    discovery,
    envKeys: Object.keys(env).sort(),
    versionStatus: 'not_probed',
    writesNativeConfig,
    locations: discovery === 'filesystem' ? locations : executionOnly(locations),
    notes
  }
}

const FILESYSTEM_ADAPTERS = new Set<ExtensionAdapter>(['claude', 'codex', 'opencode', 'cursor', 'agy', 'kimi', 'dsh'])
const WRITE_READY_ADAPTERS = new Set<ExtensionAdapter>(['claude', 'codex', 'opencode'])

function executionOnly(locations: ConfigLocation[]): ConfigLocation[] {
  return locations.filter((location) => location.kind === 'execution_env')
}

async function locationsFor(input: {
  adapter: ExtensionAdapter
  recognized: boolean
  home: string
  claudeConfig: string
  codexHome: string
  sourceCodex: string
  isolatesCodex: boolean
  opencodeConfig: string
  cursorHome: string
  geminiHome: string
  kimiHome: string
  dshHome: string
  projectCwd: string
  privateCodex: string | null
}): Promise<ConfigLocation[]> {
  if (!input.recognized) return []
  if (input.adapter === 'claude') return claudeLocations(input)
  if (input.adapter === 'codex') return codexLocations(input)
  if (input.adapter === 'opencode') return opencodeLocations(input)
  if (input.adapter === 'cursor') return cursorLocations(input)
  if (input.adapter === 'agy') return agyLocations(input)
  if (input.adapter === 'kimi') return kimiLocations(input)
  if (input.adapter === 'dsh') return dshLocations(input)
  return []
}

async function claudeLocations(input: { claudeConfig: string; home: string; projectCwd: string }): Promise<ConfigLocation[]> {
  const homeState = await directoryState(input.claudeConfig)
  const locations: ConfigLocation[] = []
  if (!homeState.exists || homeState.error) {
    locations.push(await planned('claude-skills', join(input.claudeConfig, 'skills'), 'skills', 'user', 'uninitialized', homeState.error, undefined))
    locations.push(await planned('claude-instructions', join(input.claudeConfig, 'CLAUDE.md'), 'instructions', 'user', 'uninitialized', homeState.error, undefined))
    locations.push(await planned('claude-subagents', join(input.claudeConfig, 'agents'), 'subagents', 'user', 'uninitialized', homeState.error, undefined))
    locations.push(await planned('claude-hooks', join(input.claudeConfig, 'settings.json'), 'hooks', 'user', 'uninitialized', homeState.error, undefined))
  } else {
    locations.push(await existingDir('claude-skills', join(input.claudeConfig, 'skills'), 'skills', 'user', 'empty'))
    locations.push(await existingDir('claude-plugins', join(input.claudeConfig, 'plugins'), 'skills', 'plugin', 'ignore'))
    locations.push(await fileLocation('claude-instructions', join(input.claudeConfig, 'CLAUDE.md'), 'instructions', 'user', 'empty'))
    locations.push(await existingDir('claude-subagents', join(input.claudeConfig, 'agents'), 'subagents', 'user', 'empty'))
    locations.push(await fileLocation('claude-hooks', join(input.claudeConfig, 'settings.json'), 'hooks', 'user', 'empty'))
  }
  locations.push(await fileLocation('claude-json', join(input.home, '.claude.json'), 'mcp', 'user', homeState.exists ? 'ignore' : 'uninitialized'))
  if (input.projectCwd) {
    locations.push(await existingDir('claude-project-skills', join(input.projectCwd, '.claude', 'skills'), 'skills', 'project', 'ignore'))
    locations.push(await fileLocation('claude-project-mcp', join(input.projectCwd, '.mcp.json'), 'mcp', 'project', 'ignore'))
    locations.push(await fileLocation('claude-project-instructions', join(input.projectCwd, 'CLAUDE.md'), 'instructions', 'project', 'ignore'))
  }
  return locations
}

async function codexLocations(input: {
  codexHome: string
  sourceCodex: string
  isolatesCodex: boolean
  home: string
  projectCwd: string
  privateCodex: string | null
}): Promise<ConfigLocation[]> {
  const homeState = await directoryState(input.codexHome)
  const locations: ConfigLocation[] = []
  const uninitialized = input.isolatesCodex && (!homeState.exists || Boolean(homeState.error))
  if (uninitialized) {
    locations.push(await planned(
      'codex-skills',
      join(input.codexHome, 'skills'),
      'skills',
      'user',
      'uninitialized',
      homeState.error,
      'acp_private_uninitialized'
    ))
    locations.push(await planned(
      'codex-config',
      join(input.codexHome, 'config.toml'),
      'mcp',
      'user',
      'uninitialized',
      homeState.error,
      'desktop_skills_not_attributed'
    ))
    locations.push(await planned(
      'codex-instructions',
      join(input.codexHome, 'AGENTS.md'),
      'instructions',
      'user',
      'uninitialized',
      homeState.error,
      'acp_private_uninitialized'
    ))
    locations.push(await planned(
      'codex-subagents',
      join(input.codexHome, 'agents'),
      'subagents',
      'user',
      'uninitialized',
      homeState.error,
      'acp_private_uninitialized'
    ))
    locations.push(await planned(
      'codex-hooks',
      join(input.codexHome, 'hooks.json'),
      'hooks',
      'user',
      'uninitialized',
      homeState.error,
      'acp_private_uninitialized'
    ))
  } else if (homeState.error || !homeState.exists) {
    locations.push(await planned('codex-skills', join(input.codexHome, 'skills'), 'skills', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('codex-config', join(input.codexHome, 'config.toml'), 'mcp', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('codex-instructions', join(input.codexHome, 'AGENTS.md'), 'instructions', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('codex-subagents', join(input.codexHome, 'agents'), 'subagents', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('codex-hooks', join(input.codexHome, 'hooks.json'), 'hooks', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
  } else {
    locations.push(await existingDir('codex-skills', join(input.codexHome, 'skills'), 'skills', 'user', 'empty'))
    locations.push(await fileLocation('codex-config', join(input.codexHome, 'config.toml'), 'mcp', 'user', 'ignore'))
    locations.push(await fileLocation('codex-instructions', join(input.codexHome, 'AGENTS.md'), 'instructions', 'user', 'empty'))
    locations.push(await existingDir('codex-subagents', join(input.codexHome, 'agents'), 'subagents', 'user', 'empty'))
    locations.push(await fileLocation('codex-hooks', join(input.codexHome, 'hooks.json'), 'hooks', 'user', 'empty'))
    locations.push(await existingDir('agents-skills', join(input.home, '.agents', 'skills'), 'skills', 'shared', 'ignore'))
  }
  if (input.isolatesCodex && input.privateCodex && input.sourceCodex !== input.privateCodex) {
    locations.push(await planned('codex-source', input.sourceCodex, 'execution_env', 'user', 'ignore', undefined, 'desktop_skills_not_attributed'))
  }
  if (input.projectCwd) {
    locations.push(await existingDir('codex-project-skills', join(input.projectCwd, '.agents', 'skills'), 'skills', 'project', 'ignore'))
    locations.push(await fileLocation('codex-project-mcp', join(input.projectCwd, '.codex', 'config.toml'), 'mcp', 'project', 'ignore'))
    locations.push(await fileLocation('codex-project-instructions', join(input.projectCwd, 'AGENTS.md'), 'instructions', 'project', 'ignore'))
  }
  return locations
}

async function opencodeLocations(input: { opencodeConfig: string; home: string; projectCwd: string }): Promise<ConfigLocation[]> {
  const homeState = await directoryState(input.opencodeConfig)
  const locations: ConfigLocation[] = []
  if (!homeState.exists || homeState.error) {
    locations.push(await planned('opencode-skills', join(input.opencodeConfig, 'skills'), 'skills', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('opencode-config', join(input.opencodeConfig, 'opencode.json'), 'mcp', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('opencode-instructions', join(input.opencodeConfig, 'AGENTS.md'), 'instructions', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('opencode-subagents', join(input.opencodeConfig, 'agents'), 'subagents', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
  } else {
    locations.push(await existingDir('opencode-skills', join(input.opencodeConfig, 'skills'), 'skills', 'user', 'empty'))
    locations.push(await fileLocation('opencode-config', join(input.opencodeConfig, 'opencode.json'), 'mcp', 'user', 'ignore'))
    locations.push(await fileLocation('opencode-instructions', join(input.opencodeConfig, 'AGENTS.md'), 'instructions', 'user', 'empty'))
    locations.push(await existingDir('opencode-subagents', join(input.opencodeConfig, 'agents'), 'subagents', 'user', 'empty'))
    locations.push(await existingDir('agents-skills', join(input.home, '.agents', 'skills'), 'skills', 'shared', 'ignore'))
  }
  if (input.projectCwd) {
    locations.push(await existingDir('opencode-project-skills', join(input.projectCwd, '.opencode', 'skills'), 'skills', 'project', 'ignore'))
    locations.push(await existingDir('opencode-project-agents-skills', join(input.projectCwd, '.agents', 'skills'), 'skills', 'project', 'ignore'))
    locations.push(await fileLocation('opencode-project-mcp', join(input.projectCwd, 'opencode.json'), 'mcp', 'project', 'ignore'))
    locations.push(await fileLocation('opencode-project-instructions', join(input.projectCwd, 'AGENTS.md'), 'instructions', 'project', 'ignore'))
  }
  return locations
}

async function cursorLocations(input: { cursorHome: string; projectCwd: string }): Promise<ConfigLocation[]> {
  const homeState = await directoryState(input.cursorHome)
  const locations: ConfigLocation[] = []
  if (!homeState.exists || homeState.error) {
    locations.push(await planned('cursor-skills', join(input.cursorHome, 'skills'), 'skills', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('cursor-mcp', join(input.cursorHome, 'mcp.json'), 'mcp', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
  } else {
    locations.push(await existingDir('cursor-skills', join(input.cursorHome, 'skills'), 'skills', 'user', 'empty'))
    locations.push(await existingDir('cursor-skills-product', join(input.cursorHome, 'skills-cursor'), 'skills', 'plugin', 'ignore'))
    locations.push(await fileLocation('cursor-mcp', join(input.cursorHome, 'mcp.json'), 'mcp', 'user', 'ignore'))
  }
  if (input.projectCwd) {
    locations.push(await existingDir('cursor-project-skills', join(input.projectCwd, '.cursor', 'skills'), 'skills', 'project', 'ignore'))
    locations.push(await fileLocation('cursor-project-mcp', join(input.projectCwd, '.cursor', 'mcp.json'), 'mcp', 'project', 'ignore'))
  }
  return locations
}

async function agyLocations(input: { geminiHome: string; projectCwd: string }): Promise<ConfigLocation[]> {
  const homeState = await directoryState(input.geminiHome)
  const locations: ConfigLocation[] = []
  if (!homeState.exists || homeState.error) {
    locations.push(await planned('agy-skills', join(input.geminiHome, 'config', 'skills'), 'skills', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('agy-mcp', join(input.geminiHome, 'config', 'mcp_config.json'), 'mcp', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
  } else {
    locations.push(await existingDir('agy-skills', join(input.geminiHome, 'config', 'skills'), 'skills', 'user', 'empty'))
    locations.push(await existingDir('agy-builtin-skills', join(input.geminiHome, 'antigravity-cli', 'builtin', 'skills'), 'skills', 'plugin', 'ignore'))
    locations.push(await fileLocation('agy-mcp', join(input.geminiHome, 'config', 'mcp_config.json'), 'mcp', 'user', 'ignore'))
  }
  if (input.projectCwd) {
    locations.push(await existingDir('agy-project-gemini-skills', join(input.projectCwd, '.gemini', 'skills'), 'skills', 'project', 'ignore'))
    locations.push(await existingDir('agy-project-agent-skills', join(input.projectCwd, '.agent', 'skills'), 'skills', 'project', 'ignore'))
  }
  return locations
}

async function kimiLocations(input: { kimiHome: string; home: string; projectCwd: string }): Promise<ConfigLocation[]> {
  const homeState = await directoryState(input.kimiHome)
  const locations: ConfigLocation[] = []
  if (!homeState.exists || homeState.error) {
    locations.push(await planned('kimi-skills', join(input.kimiHome, 'skills'), 'skills', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
    locations.push(await planned('kimi-mcp', join(input.kimiHome, 'mcp.json'), 'mcp', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error))
  } else {
    locations.push(await existingDir('kimi-skills', join(input.kimiHome, 'skills'), 'skills', 'user', 'empty'))
    locations.push(await fileLocation('kimi-mcp', join(input.kimiHome, 'mcp.json'), 'mcp', 'user', 'ignore'))
    locations.push(await existingDir('agents-skills', join(input.home, '.agents', 'skills'), 'skills', 'shared', 'ignore'))
  }
  if (input.projectCwd) {
    locations.push(await existingDir('kimi-project-skills', join(input.projectCwd, '.kimi-code', 'skills'), 'skills', 'project', 'ignore'))
    locations.push(await existingDir('kimi-project-agents-skills', join(input.projectCwd, '.agents', 'skills'), 'skills', 'project', 'ignore'))
    locations.push(await fileLocation('kimi-project-mcp', join(input.projectCwd, '.kimi-code', 'mcp.json'), 'mcp', 'project', 'ignore'))
  }
  return locations
}

async function dshLocations(input: { dshHome: string }): Promise<ConfigLocation[]> {
  const homeState = await directoryState(input.dshHome)
  const profiles = join(input.dshHome, 'profiles')
  if (!homeState.exists || homeState.error) {
    return [await planned('dsh-profiles', profiles, 'execution_env', 'user', homeState.error ? 'read_failed' : 'uninitialized', homeState.error, 'execution_env_not_scanned')]
  }
  return [await planned('dsh-profiles', profiles, 'execution_env', 'user', 'ignore', undefined, 'execution_env_not_scanned')]
}

async function planned(
  id: string,
  path: string,
  kind: LocationKind,
  scope: ConfigLocation['scope'],
  missingMeans: MissingMeans,
  error?: ScanProblemCode,
  note?: LocationNote
): Promise<ConfigLocation> {
  const state = await directoryState(path)
  return {
    id,
    path,
    kind,
    scope,
    exists: state.exists,
    isDirectory: state.isDirectory,
    linkSource: state.linkSource,
    scan: false,
    missingMeans: error ? 'read_failed' : missingMeans,
    error: error ?? state.error,
    note
  }
}

async function existingDir(
  id: string,
  path: string,
  kind: LocationKind,
  scope: ConfigLocation['scope'],
  whenMissing: MissingMeans
): Promise<ConfigLocation> {
  const state = await directoryState(path)
  const blocked = Boolean(state.error) || (state.exists && !state.isDirectory)
  return {
    id,
    path,
    kind,
    scope,
    exists: state.exists,
    isDirectory: state.isDirectory,
    linkSource: state.linkSource,
    scan: state.exists && state.isDirectory && !state.error,
    missingMeans: blocked ? 'read_failed' : state.exists ? 'empty' : whenMissing,
    error: state.error ?? (state.exists && !state.isDirectory ? 'not_directory' : undefined)
  }
}

async function fileLocation(
  id: string,
  path: string,
  kind: LocationKind,
  scope: ConfigLocation['scope'],
  whenMissing: MissingMeans
): Promise<ConfigLocation> {
  const state = await directoryState(path)
  const isFile = state.exists && !state.isDirectory && !state.error
  return {
    id,
    path,
    kind,
    scope,
    exists: state.exists,
    isDirectory: state.isDirectory,
    linkSource: state.linkSource,
    scan: isFile,
    missingMeans: state.error ? 'read_failed' : state.exists && state.isDirectory ? 'read_failed' : state.exists ? 'empty' : whenMissing,
    error: state.error ?? (state.exists && state.isDirectory ? 'not_directory' : undefined)
  }
}

async function usableCwd(cwd: string | undefined): Promise<string> {
  if (!cwd || !isAbsolute(cwd) || cwd.includes('\0')) return ''
  const state = await directoryState(cwd)
  return state.exists && state.isDirectory ? resolve(cwd) : ''
}

async function directoryState(path: string): Promise<DirectoryState> {
  try {
    const linked = await lstat(path)
    if (linked.isSymbolicLink()) {
      const linkSource = await readlink(path)
      try {
        const followed = await stat(path)
        return { exists: true, isDirectory: followed.isDirectory(), linkSource }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return { exists: false, isDirectory: false, linkSource, error: code === 'ENOENT' ? 'broken_link' : 'stat_failed' }
      }
    }
    return { exists: true, isDirectory: linked.isDirectory(), linkSource: null }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { exists: false, isDirectory: false, linkSource: null }
    return { exists: false, isDirectory: false, linkSource: null, error: 'stat_failed' }
  }
}

function detectProgram(actor: string, launcher: Launcher): { adapter: ExtensionAdapter; recognized: boolean } {
  const parts = [...splitCommand(launcher.command || ''), ...(launcher.args ?? [])].filter(Boolean)
  const executable = basename(parts[0] ?? '')
  const text = parts.join(' ')
  if (executable === 'codex-acp') return { adapter: 'codex', recognized: true }
  if (executable === 'claude-agent-acp' || executable === 'claude-acp') return { adapter: 'claude', recognized: true }
  if (executable === 'npx' || executable === 'bunx') {
    if (text.includes('@agentclientprotocol/codex-acp') || /(?:^|[\s/])codex-acp(?:@|\s|$)/.test(text)) {
      return { adapter: 'codex', recognized: true }
    }
    if (text.includes('claude-agent-acp') || text.includes('claude-acp')) return { adapter: 'claude', recognized: true }
    return { adapter: 'unrecognized', recognized: false }
  }
  const kind = commandKindFor(actor, parts.length ? parts : launcher.command || '')
  const byProgram = commandKindFor('contract-probe', parts.length ? parts : launcher.command || '')
  if (kind === 'contract' || byProgram === 'contract') return { adapter: 'unrecognized', recognized: false }
  return { adapter: adapterForKind(kind), recognized: true }
}

function adapterForKind(kind: LauncherCommandKind): ExtensionAdapter {
  if (kind === 'native_claude') return 'claude'
  if (kind === 'native_codex') return 'codex'
  if (kind === 'native_opencode') return 'opencode'
  if (kind === 'native_cursor') return 'cursor'
  if (kind === 'native_agy') return 'agy'
  if (kind === 'native_kimi') return 'kimi'
  if (kind === 'native_dsh') return 'dsh'
  return 'unrecognized'
}

function expectedAdapter(actor: string): ExtensionAdapter | null {
  if (actor === 'wecode_claude') return 'claude'
  if (actor === 'wecode_codex') return 'codex'
  if (actor === 'wecode_opencode') return 'opencode'
  if (actor === 'claude' || actor === 'codex' || actor === 'opencode' || actor === 'cursor' || actor === 'agy' || actor === 'kimi' || actor === 'dsh') {
    return actor
  }
  return null
}

function firstText(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}
