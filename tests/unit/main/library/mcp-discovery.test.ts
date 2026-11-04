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

it('groups identical configurations across agents but keeps differing credentials separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-mcp-dedupe-'))
  vi.stubEnv('HOME', root)
  try {
    const targets = (await resolveLibraryTargets([], join(root, 'buddy')))
      .filter((target) => ['shared', 'cursor', 'kimi'].includes(target.agentId))
    for (const target of targets) {
      await mkdir(join(target.mcpPath!, '..'), { recursive: true })
      const raw = target.agentId === 'kimi'
        ? { command: 'example', env: { TOKEN: 'different' } }
        : { env: { TOKEN: 'same' }, command: 'example' }
      await writeFile(target.mcpPath!, JSON.stringify({ mcpServers: { example: raw } }))
    }
    const discovered = await discoverMcpServers(targets, [])
    expect(discovered).toHaveLength(2)
    expect(discovered[0].sources?.map((s) => s.agentId)).toEqual(['shared', 'cursor'])
    const imported = { id: 'one', name: 'example', transport: 'stdio' as const,
      summary: 'example', raw: discovered[0].raw, scope: 'user' as const,
      assignedTargetIds: ['shared:native:user'], managed: true }
    const rescanned = await discoverMcpServers(targets, [imported])
    expect(rescanned.filter((s) => !s.alreadyImported)).toHaveLength(1)
    expect(rescanned.find((s) => !s.alreadyImported)?.agentId).toBe('kimi')
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it('shows native agents once and routes Codex to its active ACP context', async () => {
  const { groupMcpTargets } = await import('../../../../src/shared/library')
  const root = await mkdtemp(join(tmpdir(), 'buddy-mcp-targets-'))
  vi.stubEnv('HOME', root)
  try {
    const targets = await resolveLibraryTargets([], join(root, 'buddy'))
    const acp = targets.find((target) => target.configContext === 'buddy-acp')!
    acp.usedByTasks = true
    targets.push({ ...acp, targetId: 'wecode_codex:wecode:user', agentId: 'wecode_codex', configContext: 'wecode', displayName: 'WeCode Codex ACP' })
    const grouped = groupMcpTargets(targets)
    expect(grouped.some((target) => target.agentId === 'shared')).toBe(false)
    expect(grouped.filter((target) => target.agentId === 'codex')).toHaveLength(1)
    expect(grouped.find((target) => target.agentId === 'codex')).toMatchObject({ targetId: acp.targetId, displayName: 'Codex' })
    expect(grouped.find((target) => target.agentId === 'codebuddy')).toMatchObject({ mcpFormat: 'jsonc-mcpServers', mcpPath: join(root, '.codebuddy.json') })
    expect(grouped.find((target) => target.agentId === 'dsh')).toBeDefined()
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
