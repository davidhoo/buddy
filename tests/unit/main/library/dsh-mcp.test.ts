import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readDshServers, writeDshServer } from '../../../../src/main/buddy/library/edit/dsh'
import { LibraryStore } from '../../../../src/main/buddy/library/store'
import { addServer, assignServerToTarget } from '../../../../src/main/buddy/library/mcp'
import { discoverMcpServers } from '../../../../src/main/buddy/library/discovery'
import type { LibraryTarget } from '../../../../src/shared/library'

it('writes native dsh entries, discovers assignments, removes them and preserves YAML tags and comments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-dsh-mcp-'))
  try {
    const path = join(root, 'cordis.patch.yml')
    const original = '# custom profile\n- insert:\n    - id: custom\n      name: example\n      config:\n        token: !!js process.env.TEST_TOKEN\n'
    await writeFile(path, original)
    const store = new LibraryStore(join(root, 'buddy'))
    const added = await addServer(store, 'docs', { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'test-only' } })
    const target: LibraryTarget = {
      targetId: 'dsh:native:user', agentId: 'dsh', displayName: 'DeepSeek Harness', configContext: 'native', scope: 'user',
      mcpPath: path, mcpFormat: 'dsh-patch', capabilities: { readSkills: true, writeSkills: true, readMcp: true, writeMcp: true, authProbe: false, diagnose: false }
    }
    expect((await assignServerToTarget(store, root, added.id!, target, true)).status).toBe('ok')
    expect(await readDshServers(path)).toMatchObject([{ name: 'docs', raw: { transport: 'streamable-http', headers: { Authorization: 'test-only' } } }])
    const discovered = await discoverMcpServers([target], (await store.readMeta()).servers)
    expect(discovered[0].alreadyImported).toBe(true)
    expect((await assignServerToTarget(store, root, added.id!, target, false)).status).toBe('ok')
    expect(await readDshServers(path)).toEqual([])
    expect(await readFile(path, 'utf8')).toContain('!!js process.env.TEST_TOKEN')
    expect(await readFile(path, 'utf8')).toContain('# custom profile')
    await expect(writeDshServer(path, 'sse', { type: 'sse', url: 'https://example.com' })).rejects.toThrow('SSE')
  } finally { await rm(root, { recursive: true, force: true }) }
})
