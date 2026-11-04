import { writeDshServer } from './edit/dsh'
import { randomUUID } from 'node:crypto'
import type {
  DiscoveredMcpServer,
  LibraryMcpServer,
  LibraryOpResult,
  LibraryTarget,
  McpTransport
} from '../../../shared/library'
import { convertMcpRawForTarget } from './convert'
import { removeMcpServerJsonc, writeMcpServerJsonc } from './edit/jsonc'
import { deleteMcpServerToml, setMcpServerToml } from './edit/toml'
import { LibraryStore, upsertServer } from './store'
import { discoverMcpServers, mcpConfigKey, sameLocalMcpLauncher, summaryOf, transportOf } from './discovery'
import { splitCommand } from '../launchers'
import { ensureCodexAcpHome } from './ensure-codex-acp-home'

function toStoredRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  delete out.__buddy
  return out
}

function serverRecord(input: {
  name: string
  raw: Record<string, unknown>
  sourceTargetId?: string
  assignedTargetIds: string[]
}): LibraryMcpServer {
  const transport = transportOf(input.raw)
  return {
    id: randomUUID(),
    name: input.name,
    transport,
    command: typeof input.raw.command === 'string' ? input.raw.command : undefined,
    args: Array.isArray(input.raw.args) ? input.raw.args.map(String) : undefined,
    url: typeof input.raw.url === 'string' ? input.raw.url : undefined,
    summary: summaryOf(input.raw),
    note: typeof input.raw.note === 'string' ? input.raw.note : undefined,
    raw: toStoredRaw(input.raw),
    sourceTargetId: input.sourceTargetId,
    scope: 'user',
    assignedTargetIds: input.assignedTargetIds,
    managed: true
  }
}

export async function addServer(
  store: LibraryStore,
  name: string,
  raw: Record<string, unknown>
): Promise<LibraryOpResult> {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    return { status: 'rejected', message: 'Use 1–64 letters, digits, hyphens or underscores for the name.' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'rejected', message: 'Expected an MCP configuration object.' }
  }
  const { type, env, url, headers, note, startup_timeout_sec } = raw
  const [command, ...args] = typeof raw.commandLine === 'string'
    ? splitCommand(raw.commandLine.trim())
    : [raw.command, ...(Array.isArray(raw.args) ? raw.args : [])]
  if ((raw.args !== undefined && !Array.isArray(raw.args)) ||
      (startup_timeout_sec !== undefined && (typeof startup_timeout_sec !== 'number' ||
        !Number.isSafeInteger(startup_timeout_sec) || startup_timeout_sec < 1))) {
    return { status: 'rejected', message: 'Enter valid arguments and a positive startup timeout in seconds.' }
  }
  const isStringMap = (value: unknown) => value === undefined ||
    (!!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.values(value).every((entry) => typeof entry === 'string'))

  let config: Record<string, unknown>
  if (type === 'stdio') {
    if (typeof command !== 'string' || !command.trim() ||
        (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))) ||
        !isStringMap(env)) {
      return { status: 'rejected', message: 'Enter a command, an array of string arguments, and string environment values.' }
    }
    config = { type, command: command.trim(), args, env }
  } else if (type === 'http' || type === 'sse') {
    const address = typeof url === 'string' && URL.canParse(url.trim()) ? new URL(url.trim()) : null
    if (!address || !['http:', 'https:'].includes(address.protocol) || !isStringMap(headers)) {
      return { status: 'rejected', message: 'Enter an HTTP(S) URL and string header values.' }
    }
    config = { type, url: address.href, headers }
  } else {
    return { status: 'rejected', message: 'Choose Command, HTTP or SSE.' }
  }

  const meta = await store.readMeta()
  if (meta.servers.some((server) => server.name === name)) {
    return { status: 'exists', message: 'A server with this name already exists in the library.' }
  }
  if (typeof note === 'string' && note.trim()) config.note = note.trim().slice(0, 500)
  if (startup_timeout_sec !== undefined) config.startup_timeout_sec = startup_timeout_sec
  const record = serverRecord({ name, raw: config, assignedTargetIds: [] })
  await store.writeMeta(upsertServer(meta, record))
  return { status: 'ok', id: record.id, name }
}

export async function importDiscoveredServer(
  store: LibraryStore,
  discovered: DiscoveredMcpServer
): Promise<LibraryOpResult> {
  const meta = await store.readMeta()
  if (meta.servers.some((s) => s.name === discovered.name)) {
    return { status: 'exists', name: discovered.name }
  }
  const record = serverRecord({
    name: discovered.name,
    raw: discovered.raw,
    sourceTargetId: discovered.targetId,
    assignedTargetIds: [...new Set(discovered.sources?.map((s) => s.targetId) || [discovered.targetId])]
  })
  await store.writeMeta(upsertServer(meta, record))
  return { status: 'ok', id: record.id, name: record.name }
}

async function writeServerToTarget(target: LibraryTarget, name: string, raw: Record<string, unknown>): Promise<void> {
  if (!target.mcpPath) throw new Error('target has no MCP path')
  if (target.mcpFormat === 'unsupported') throw new Error(target.capabilities.reason || 'unsupported MCP format')
  if (target.mcpFormat === 'dsh-patch') return writeDshServer(target.mcpPath, name, raw)
  const encoded = convertMcpRawForTarget(raw, target.mcpFormat)
  if (target.mcpFormat === 'toml-mcp_servers' && typeof raw.startup_timeout_sec === 'number') {
    encoded.startup_timeout_sec = raw.startup_timeout_sec
  }
  if (target.mcpFormat === 'jsonc-mcpServers') {
    await writeMcpServerJsonc(target.mcpPath, name, encoded)
    return
  }
  if (target.mcpFormat === 'toml-mcp_servers') {
    await setMcpServerToml(target.mcpPath, name, encoded)
    return
  }
  throw new Error('unsupported MCP format')
}

async function removeServerFromTarget(target: LibraryTarget, name: string): Promise<void> {
  if (!target.mcpPath) return
  if (target.mcpFormat === 'dsh-patch') return writeDshServer(target.mcpPath, name)
  if (target.mcpFormat === 'jsonc-mcpServers') {
    await removeMcpServerJsonc(target.mcpPath, name)
    return
  }
  if (target.mcpFormat === 'toml-mcp_servers') {
    await deleteMcpServerToml(target.mcpPath, name)
  }
}

export async function assignServerToTarget(
  store: LibraryStore,
  dataRoot: string,
  serverId: string,
  target: LibraryTarget,
  enabled: boolean
): Promise<LibraryOpResult> {
  if (!target.capabilities.writeMcp && !target.pendingInit) {
    return { status: 'rejected', message: target.capabilities.reason || 'MCP write unsupported' }
  }
  let resolved = target
  if (target.pendingInit && (target.configContext === 'buddy-acp' || target.configContext === 'wecode')) {
    const ensured = await ensureCodexAcpHome(dataRoot, target.agentId)
    resolved = {
      ...target,
      pendingInit: false,
      mcpPath: ensured.mcpPath,
      skillsDir: ensured.skillsDir,
      capabilities: { ...target.capabilities, readMcp: true, writeMcp: true, readSkills: true, writeSkills: true, reason: undefined }
    }
  }
  if (!resolved.mcpPath) return { status: 'rejected', message: 'no MCP path' }

  const meta = await store.readMeta()
  const server = meta.servers.find((s) => s.id === serverId)
  if (!server) return { status: 'failed', message: 'server not found' }

  try {
    let appliedRaw = server.raw
    if (enabled) {
      const existing = await discoverMcpServers([resolved], [])
      const current = existing.find((entry) => entry.name === server.name)
      if (current && mcpConfigKey(current.name, current.raw) !== mcpConfigKey(server.name, server.raw) &&
          !sameLocalMcpLauncher(current.raw, server.raw)) {
        return { status: 'conflict', message: 'This Agent already has a server with the same name.' }
      }
      appliedRaw = { ...(current?.raw || server.raw), enabled: true }
      if (current && resolved.mcpFormat === 'toml-mcp_servers') {
        await setMcpServerToml(resolved.mcpPath!, server.name, appliedRaw)
      } else if (current && resolved.mcpFormat === 'jsonc-mcpServers') {
        await writeMcpServerJsonc(resolved.mcpPath!, server.name, appliedRaw)
      } else await writeServerToTarget(resolved, server.name, appliedRaw)
      server.assignedTargetIds = [...new Set([...server.assignedTargetIds, resolved.targetId])]
    } else {
      await removeServerFromTarget(resolved, server.name)
      server.assignedTargetIds = server.assignedTargetIds.filter((id) => id !== resolved.targetId)
    }
    meta.applied[`${resolved.targetId}:mcp:${server.name}`] = {
      kind: 'mcp',
      fingerprint: JSON.stringify(appliedRaw),
      path: resolved.mcpPath,
      at: new Date().toISOString()
    }
    await store.writeMeta(upsertServer(meta, server))
    return {
      status: 'ok',
      id: server.id,
      name: server.name,
      affectedTargetIds: [resolved.targetId],
      message: target.pendingInit ? 'initialized Codex ACP home (config subset) then wrote MCP entry' : undefined
    }
  } catch (error) {
    return { status: 'failed', name: server.name, message: (error as Error).message }
  }
}

export function normalizeTransport(value: McpTransport): McpTransport {
  return value
}
