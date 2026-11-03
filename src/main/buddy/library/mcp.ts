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
import { summaryOf, transportOf } from './discovery'
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
    raw: toStoredRaw(input.raw),
    sourceTargetId: input.sourceTargetId,
    scope: 'user',
    assignedTargetIds: input.assignedTargetIds,
    managed: true
  }
}

export async function importDiscoveredServer(
  store: LibraryStore,
  discovered: DiscoveredMcpServer
): Promise<LibraryOpResult> {
  const meta = await store.readMeta()
  if (meta.servers.some((s) => s.name === discovered.name && s.sourceTargetId === discovered.targetId)) {
    return { status: 'exists', name: discovered.name }
  }
  const record = serverRecord({
    name: discovered.name,
    raw: discovered.raw,
    sourceTargetId: discovered.targetId,
    assignedTargetIds: [discovered.targetId]
  })
  await store.writeMeta(upsertServer(meta, record))
  return { status: 'ok', id: record.id, name: record.name }
}

async function writeServerToTarget(target: LibraryTarget, name: string, raw: Record<string, unknown>): Promise<void> {
  if (!target.mcpPath) throw new Error('target has no MCP path')
  if (target.mcpFormat === 'unsupported') throw new Error(target.capabilities.reason || 'unsupported MCP format')
  const encoded = convertMcpRawForTarget(raw, target.mcpFormat)
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
    if (enabled) {
      await writeServerToTarget(resolved, server.name, server.raw)
      server.assignedTargetIds = [...new Set([...server.assignedTargetIds, resolved.targetId])]
    } else {
      await removeServerFromTarget(resolved, server.name)
      server.assignedTargetIds = server.assignedTargetIds.filter((id) => id !== resolved.targetId)
    }
    meta.applied[`${resolved.targetId}:mcp:${server.name}`] = {
      kind: 'mcp',
      fingerprint: JSON.stringify(server.raw),
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
