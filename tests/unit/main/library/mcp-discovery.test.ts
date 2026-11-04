import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { discoverMcpServers } from '../../../../src/main/buddy/library/discovery'
import { resolveLibraryTargets } from '../../../../src/main/buddy/library/targets'

it('discovers shared home MCP servers without installed agents and tolerates a missing config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-shared-mcp-'))
  vi.stubEnv('HOME', root)
  try {
    const targets = await resolveLibraryTargets([], join(root, 'buddy'))
    const shared = targets.filter((target) => target.agentId === 'shared')
    expect(shared).toHaveLength(1)
    expect(await discoverMcpServers(shared, [])).toEqual([])

    const path = join(root, '.agents', 'mcp.json')
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(path, `{
      // Shared MCP configuration
      "mcpServers": {
        "local": { "command": "example", "args": ["serve"] },
        "remote": { "type": "http", "url": "https://example.com/mcp" }
      }
    }`)
    const servers = await discoverMcpServers(shared, [])
    expect(servers).toHaveLength(2)
    expect(servers[0]).toMatchObject({
      name: 'local', agentId: 'shared', targetId: 'shared:native:user',
      path, transport: 'stdio', summary: 'example serve'
    })
    expect(servers[1]).toMatchObject({ name: 'remote', transport: 'http' })

    await writeFile(path, '{invalid')
    expect(await discoverMcpServers(shared, [])).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
