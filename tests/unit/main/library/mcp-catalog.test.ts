import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { LibraryService } from '../../../../src/main/buddy/library/service'
import type { AgentManagementService } from '../../../../src/main/buddy/agents/service'

it('shows one unimported server per name, hides all imported variants, and preserves files on unmanage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-catalog-'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('CODEX_HOME', join(root, '.codex'))
  try {
    const service = new LibraryService(join(root, 'buddy'), { getInventory: async () => ({ agents: [] }) } as unknown as AgentManagementService)
    const files = [join(root, '.cursor', 'mcp.json'), join(root, '.kimi', 'mcp.json')]
    for (const [index, path] of files.entries()) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, JSON.stringify({ mcpServers: { node_repl: { command: 'node', env: { PROFILE: String(index) } } } }))
    }
    const original = await Promise.all(files.map((path) => readFile(path, 'utf8')))
    const before = await service.getSnapshot(true)
    expect(before.discoveredServers).toHaveLength(1)
    expect(before.discoveredServers[0].sources).toHaveLength(2)
    const imported = await service.importServers([before.discoveredServers[0].discoveryId])
    expect(imported.results[0].status).toBe('ok')
    const after = await service.getSnapshot(true)
    expect(after.servers).toHaveLength(1)
    expect(after.discoveredServers).toEqual([])
    // Matching the catalog by name must not mark a different connection as enabled.
    expect(after.servers[0].assignedTargetIds).toHaveLength(1)
    expect((await service.ejectServer(after.servers[0].id)).status).toBe('ok')
    expect(await Promise.all(files.map((path) => readFile(path, 'utf8')))).toEqual(original)
    const ejected = await service.getSnapshot(true)
    expect(ejected.servers).toEqual([])
    expect(ejected.discoveredServers).toHaveLength(1)
    expect(ejected.discoveredServers[0].sources).toHaveLength(2)
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
