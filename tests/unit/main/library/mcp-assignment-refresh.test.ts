import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { LibraryService } from '../../../../src/main/buddy/library/service'
import { LibraryStore } from '../../../../src/main/buddy/library/store'
import { mcpConfigKey } from '../../../../src/main/buddy/library/discovery'
import { groupMcpTargets } from '../../../../src/shared/library'
import type { AgentManagementService } from '../../../../src/main/buddy/agents/service'

it('keeps Codex assigned after writing converted computer-use config and refreshing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-mcp-refresh-'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('CODEX_HOME', join(root, '.codex'))
  try {
    const dataRoot = join(root, 'buddy')
    const service = new LibraryService(dataRoot, { getInventory: async () => ({ agents: [] }) } as unknown as AgentManagementService)
    const store = new LibraryStore(dataRoot)
    await store.writeMeta({ schemaVersion: 1, skills: [], applied: {}, servers: [{
      id: 'computer', name: 'computer-use', transport: 'stdio', summary: '/bin/example',
      raw: { type: 'stdio', command: '/bin/example', args: [], env: {}, cwd: root, enabled: false, env_vars: ['PIPE'], startup_timeout_sec: 60 },
      scope: 'user', managed: true, assignedTargetIds: []
    }] })
    const before = await service.getSnapshot(true)
    const codex = groupMcpTargets(before.targets).find((target) => target.agentId === 'codex')!
    expect((await service.setServerAssignment('computer', codex.targetId, true)).status).toBe('ok')
    const after = await service.getSnapshot(true)
    expect(after.servers[0].assignedTargetIds).toContain(codex.targetId)
    const cursor = groupMcpTargets(after.targets).find((target) => target.agentId === 'cursor')!
    expect((await service.setServerAssignment('computer', cursor.targetId, true)).status).toBe('ok')
    const jsonRefresh = await service.getSnapshot(true)
    expect(jsonRefresh.servers[0].assignedTargetIds).toContain(cursor.targetId)
    expect(jsonRefresh.discoveredServers.filter((entry) => entry.name === 'computer-use')).toHaveLength(0)
    expect(after.discoveredServers.filter((entry) => entry.name === 'computer-use')).toHaveLength(0)
    expect((await service.setServerAssignment('computer', codex.targetId, false)).status).toBe('ok')
    expect((await service.getSnapshot(true)).servers[0].assignedTargetIds).not.toContain(codex.targetId)
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it('compares native connection semantics while preserving credential differences', () => {
  expect(mcpConfigKey('x', { command: 'node', args: [], env: {} })).toBe(
    mcpConfigKey('x', { type: 'stdio', command: 'node' }))
  expect(mcpConfigKey('x', { url: 'https://example.com', http_headers: { A: 'b' } })).toBe(
    mcpConfigKey('x', { type: 'http', url: 'https://example.com', headers: { A: 'b' } }))
  expect(mcpConfigKey('x', { command: 'node', env: { TOKEN: 'one' } })).not.toBe(
    mcpConfigKey('x', { command: 'node', env: { TOKEN: 'two' } }))
})

it('recognizes JSON assignments of native env_vars and groups disabled/default-cwd variants', async () => {
  expect(mcpConfigKey('node_repl', { command: '/bin/node', args: [], env_vars: ['PIPE'] }))
    .toBe(mcpConfigKey('node_repl', { command: '/bin/node' }))
  expect(mcpConfigKey('computer-use', { command: '/bin/cua', cwd: '.', enabled: false }))
    .toBe(mcpConfigKey('computer-use', { command: '/bin/cua', enabled: true }))
  expect(mcpConfigKey('computer-use', { command: '/bin/cua', cwd: '/other' }))
    .not.toBe(mcpConfigKey('computer-use', { command: '/bin/cua' }))
})

it('assigns HTTP servers with authentication headers to Codex and retains selection on refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-http-refresh-'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('CODEX_HOME', join(root, '.codex'))
  try {
    const service = new LibraryService(join(root, 'buddy'), { getInventory: async () => ({ agents: [] }) } as unknown as AgentManagementService)
    const result = await service.addServer('remote', { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer test-only' } })
    const snapshot = await service.getSnapshot(true)
    const codex = groupMcpTargets(snapshot.targets).find((target) => target.agentId === 'codex')!
    expect((await service.setServerAssignment(result.id!, codex.targetId, true)).status).toBe('ok')
    const refreshed = await service.getSnapshot(true)
    expect(refreshed.servers[0].assignedTargetIds).toContain(codex.targetId)
    expect(refreshed.discoveredServers).toHaveLength(0)
    expect((await service.setServerAssignment(result.id!, codex.targetId, true)).status).toBe('ok')
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it('adopts Codex node_repl with its native environment and keeps that binding after refresh', async () => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { getMcpServerTable } = await import('../../../../src/main/buddy/library/edit/toml')
  const root = await mkdtemp(join(tmpdir(), 'buddy-native-node-repl-'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('CODEX_HOME', join(root, '.codex'))
  try {
    const path = join(root, '.codex', 'config.toml')
    await mkdir(join(root, '.codex'))
    await writeFile(path, '[mcp_servers.node_repl]\ncommand = "/bin/node_repl"\nenabled = false\nenv_vars = ["PIPE"]\n[mcp_servers.node_repl.env]\nCODEX_HOME = "native-home"\nNODE_REPL_NODE_PATH = "/native/node"\n')
    const service = new LibraryService(join(root, 'buddy'), { getInventory: async () => ({ agents: [] }) } as unknown as AgentManagementService)
    const added = await service.addServer('node_repl', { type: 'stdio', command: '/bin/node_repl' })
    const before = await service.getSnapshot(true)
    const codex = groupMcpTargets(before.targets).find((target) => target.agentId === 'codex')!
    expect(before.servers[0].assignedTargetIds).not.toContain(codex.targetId)
    expect((await service.setServerAssignment(added.id!, codex.targetId, true)).status).toBe('ok')
    const raw = getMcpServerTable(await readFile(path, 'utf8'), 'node_repl')!
    expect(raw).toMatchObject({ enabled: true, env_vars: ['PIPE'], env: { CODEX_HOME: 'native-home', NODE_REPL_NODE_PATH: '/native/node' } })
    const after = await service.getSnapshot(true)
    expect(after.servers[0].assignedTargetIds).toContain(codex.targetId)
    expect(after.discoveredServers).toEqual([])
    expect((await service.setServerAssignment(added.id!, codex.targetId, false)).status).toBe('ok')
    expect((await service.getSnapshot(true)).servers[0].assignedTargetIds).not.toContain(codex.targetId)
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
