import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { addServer, assignServerToTarget } from '../../../../src/main/buddy/library/mcp'
import { LibraryStore } from '../../../../src/main/buddy/library/store'
import type { LibraryTarget } from '../../../../src/shared/library'

it('saves a server unassigned, then writes it only to a compatible Agent without a name conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-add-mcp-'))
  try {
    const store = new LibraryStore(root)
    const path = join(root, 'mcp.json')
    const config = { type: 'http', url: 'https://example.com/mcp' }
    const result = await addServer(store, 'docs', config)
    expect(result.status).toBe('ok')
    expect((await store.readMeta()).servers[0].assignedTargetIds).toEqual([])
    expect((await addServer(store, 'docs', config)).status).toBe('exists')
    expect((await addServer(store, 'bad', { type: 'http', url: 'file:///tmp/mcp' })).status).toBe('rejected')

    const target: LibraryTarget = {
      targetId: 'claude:native:user',
      agentId: 'claude',
      displayName: 'Claude',
      configContext: 'native',
      scope: 'user',
      mcpPath: path,
      mcpFormat: 'jsonc-mcpServers',
      capabilities: { readSkills: false, writeSkills: false, readMcp: true, writeMcp: true, authProbe: false, diagnose: false }
    }
    const existing = '{"mcpServers":{"docs":{"command":"existing"}}}'
    await writeFile(path, existing)
    expect((await assignServerToTarget(store, root, result.id!, target, true)).status).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe(existing)

    await writeFile(path, '{}')
    expect((await assignServerToTarget(store, root, result.id!, target, true)).status).toBe('ok')
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers.docs).toEqual(config)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
