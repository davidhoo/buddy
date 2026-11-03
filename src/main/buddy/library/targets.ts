import { access, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LocalAgent } from '../../../shared/agents'
import type { LibraryCapabilities, LibraryConfigContext, LibraryTarget } from '../../../shared/library'

export type McpFormat = LibraryTarget['mcpFormat']

interface TargetSpec {
  agentId: string
  displayName: string
  configContext: LibraryConfigContext
  skillsDir?: string
  mcpPath?: string
  mcpFormat: McpFormat
  capabilities: LibraryCapabilities
  pendingInit?: boolean
  usedByTasks?: boolean
}

const HOME = () => process.env.HOME || homedir()

function claudeHome(env: Record<string, string> = {}): string {
  return env.CLAUDE_CONFIG_DIR || join(HOME(), '.claude')
}

function codexHome(env: Record<string, string> = {}): string {
  return env.CODEX_HOME || join(HOME(), '.codex')
}

function cursorHome(): string {
  return join(HOME(), '.cursor')
}

function opencodeHome(): string {
  return process.env.OPENCODE_CONFIG_DIR || join(HOME(), '.config', 'opencode')
}

function kimiHome(): string {
  return join(HOME(), '.kimi')
}

function agyHome(): string {
  return join(HOME(), '.gemini')
}

function envOf(agent: LocalAgent): Record<string, string> {
  return { ...(agent.cli?.env || {}), ...(agent.acp?.env || {}) }
}

async function exists(path?: string): Promise<boolean> {
  if (!path) return false
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function physical(path?: string): Promise<string | undefined> {
  if (!path) return undefined
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

function caps(partial: Partial<LibraryCapabilities> & Pick<LibraryCapabilities, 'readSkills' | 'readMcp'>): LibraryCapabilities {
  return {
    writeSkills: partial.writeSkills ?? partial.readSkills,
    writeMcp: partial.writeMcp ?? partial.readMcp,
    authProbe: partial.authProbe ?? false,
    diagnose: partial.diagnose ?? false,
    reason: partial.reason,
    readSkills: partial.readSkills,
    readMcp: partial.readMcp
  }
}

function buddyAcpCodexHome(dataRoot: string, actor: string): string {
  return join(dataRoot, 'acp', actor, 'codex-home')
}

/** Build library targets from Buddy agent inventory + known native paths. */
export async function resolveLibraryTargets(
  agents: LocalAgent[],
  dataRoot: string
): Promise<LibraryTarget[]> {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const specs: TargetSpec[] = []

  const addNative = (agentId: string, displayName: string, make: (agent?: LocalAgent) => Omit<TargetSpec, 'agentId' | 'displayName' | 'configContext'>) => {
    const agent = byId.get(agentId)
    // Resource management does not require task-enabled; inventory presence or known path is enough.
    const base = make(agent)
    specs.push({
      agentId,
      displayName,
      configContext: 'native',
      usedByTasks: !!agent?.enabled,
      ...base
    })
  }

  addNative('claude', 'Claude Code', (agent) => {
    const home = claudeHome(envOf(agent || ({ cli: { env: {} } } as LocalAgent)))
    return {
      skillsDir: join(home, 'skills'),
      mcpPath: join(HOME(), '.claude.json'),
      mcpFormat: 'jsonc-mcpServers',
      capabilities: caps({ readSkills: true, readMcp: true, authProbe: true })
    }
  })

  addNative('codex', 'Codex', (agent) => {
    const home = codexHome(envOf(agent || ({ cli: { env: {} } } as LocalAgent)))
    return {
      skillsDir: join(home, 'skills'),
      mcpPath: join(home, 'config.toml'),
      mcpFormat: 'toml-mcp_servers',
      capabilities: caps({ readSkills: true, readMcp: true })
    }
  })

  addNative('cursor', 'Cursor', () => ({
    skillsDir: join(cursorHome(), 'skills'),
    mcpPath: join(cursorHome(), 'mcp.json'),
    mcpFormat: 'jsonc-mcpServers',
    capabilities: caps({ readSkills: true, readMcp: true })
  }))

  addNative('opencode', 'OpenCode', () => ({
    skillsDir: join(opencodeHome(), 'skills'),
    mcpPath: join(opencodeHome(), 'opencode.json'),
    mcpFormat: 'jsonc-mcpServers',
    capabilities: caps({
      readSkills: true,
      readMcp: true,
      reason: 'OpenCode MCP key may be mcp or mcpServers depending on version'
    })
  }))

  addNative('agy', 'Antigravity', () => ({
    skillsDir: join(agyHome(), 'skills'),
    mcpPath: join(agyHome(), 'mcp_config.json'),
    mcpFormat: 'jsonc-mcpServers',
    capabilities: caps({ readSkills: true, readMcp: true })
  }))

  addNative('kimi', 'Kimi Code', () => ({
    skillsDir: join(kimiHome(), 'skills'),
    mcpPath: join(kimiHome(), 'mcp.json'),
    mcpFormat: 'jsonc-mcpServers',
    capabilities: caps({ readSkills: true, readMcp: true })
  }))

  // Codex ACP / WeCode Codex — MCP independent; skills usually share native dir via symlink.
  for (const actor of ['codex', 'wecode_codex'] as const) {
    const agent = byId.get(actor)
    if (!agent && actor === 'wecode_codex') continue
    const home = buddyAcpCodexHome(dataRoot, actor)
    const ready = await exists(home)
    specs.push({
      agentId: actor,
      displayName: actor === 'codex' ? 'Codex ACP' : 'WeCode Codex ACP',
      configContext: actor.startsWith('wecode') ? 'wecode' : 'buddy-acp',
      skillsDir: join(home, 'skills'),
      mcpPath: join(home, 'config.toml'),
      mcpFormat: 'toml-mcp_servers',
      pendingInit: !ready,
      usedByTasks: !!agent?.enabled && (agent.selectedProtocol === 'acp' || !agent.cli),
      capabilities: caps({
        readSkills: ready,
        writeSkills: ready,
        readMcp: ready,
        writeMcp: true,
        reason: ready ? undefined : 'Buddy ACP home not initialized yet'
      })
    })
  }

  const targets: LibraryTarget[] = []
  for (const spec of specs) {
    const skillsPhysicalKey = await physical(spec.skillsDir)
    const mcpPhysicalKey = await physical(spec.mcpPath)
    const targetId = [
      spec.agentId,
      spec.configContext,
      'user'
    ].join(':')
    targets.push({
      targetId,
      agentId: spec.agentId,
      displayName: spec.displayName,
      configContext: spec.configContext,
      scope: 'user',
      skillsDir: spec.skillsDir,
      skillsPhysicalKey,
      mcpPath: spec.mcpPath,
      mcpPhysicalKey,
      mcpFormat: spec.mcpFormat,
      capabilities: spec.capabilities,
      pendingInit: spec.pendingInit,
      usedByTasks: spec.usedByTasks
    })
  }

  // Link skill targets that share a physical directory.
  const bySkills = new Map<string, string[]>()
  for (const t of targets) {
    if (!t.skillsPhysicalKey) continue
    const list = bySkills.get(t.skillsPhysicalKey) || []
    list.push(t.targetId)
    bySkills.set(t.skillsPhysicalKey, list)
  }
  for (const t of targets) {
    if (!t.skillsPhysicalKey) continue
    const linked = (bySkills.get(t.skillsPhysicalKey) || []).filter((id) => id !== t.targetId)
    if (linked.length) t.linkedSkillTargetIds = linked
  }

  return targets
}

export { buddyAcpCodexHome, codexHome, claudeHome }
