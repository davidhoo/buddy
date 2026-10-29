import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { kimiAcpArgsFromHelp } from '../../../src/main/buddy/agents/capabilities'
import { parseKimiModels } from '../../../src/main/buddy/agents/models'
import { AgentManagementService } from '../../../src/main/buddy/agents/service'
import { BuddyStore } from '../../../src/main/buddy/store'
import { buildLauncherCommand } from '../../../src/main/buddy/launchers'

const nativeCatalog = JSON.stringify({
  providers: { wecode: { type: 'openai', api_key: 'private-test-provider-key' } },
  models: {
    'kimi-k2-6': { provider: 'wecode', model: 'moonshot-kimi-k2.6', display_name: 'Kimi K2.6' },
    'kimi-k2-5': { provider: 'wecode', model: 'moonshot-kimi-k2.5' }
  }
})

describe('Kimi native capabilities', () => {
  it('detects advertised ACP entry points without inferring support from a version or prose', () => {
    expect(kimiAcpArgsFromHelp('Commands:\n  acp [options]  Run the ACP server.')).toEqual(['acp'])
    expect(kimiAcpArgsFromHelp('\u001b[32m│ --acp  Run ACP\u001b[0m')).toEqual(['--acp'])
    expect(kimiAcpArgsFromHelp('Kimi 2.4.0\nUse an adapter for acp.')).toBeUndefined()
    expect(kimiAcpArgsFromHelp('Options:\n  --acp-config <path>  Client config')).toBeUndefined()
  })

  it('returns configured alias IDs and labels without exposing provider credentials', () => {
    const models = parseKimiModels(nativeCatalog)
    expect(models).toEqual([{ id: 'kimi-k2-6', name: 'Kimi K2.6' }, { id: 'kimi-k2-5', name: 'kimi-k2-5' }])
    expect(JSON.stringify(models)).not.toContain('private-test-provider-key')
    expect(JSON.stringify(models)).not.toContain('moonshot-kimi-k2.6')
    expect(parseKimiModels('{"providers":{},"models":{}}')).toEqual([])
  })

  it.each(['{"models":{"broken":null},"secret":"private-test-key"}', 'not-json-private-test-key'])('rejects invalid output without echoing credential-bearing JSON: %s', raw => {
    expect(() => parseKimiModels(raw)).toThrow(/Kimi model list returned/)
    try { parseKimiModels(raw) } catch (error) { expect(String(error)).not.toContain('private-test-key') }
  })

  it('discovers ACP, verifies a real stdio handshake, switches protocols and queries native aliases in the launcher context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-kimi-'))
    try {
      const bin = join(root, 'bin'), log = join(root, 'acp.jsonl')
      await mkdir(bin)
      const command = join(bin, 'kimi')
      await writeFile(command, `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.KIMI_CODE_HOME })+'\\n')
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:1,agentCapabilities:{}}}))
})
`, { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      const cli = { command, args: ['--agent-file', 'team agent.md'], env: { KIMI_CODE_HOME: join(root, 'kimi-home') }, timeout_seconds: 20 }
      await store.updateGlobalSettings({ launchers: { kimi: cli } })
      const run = vi.fn(async (_command: string, args: string[]) => args.includes('provider') ? nativeCatalog : args.includes('--help') ? 'Commands:\n  acp [options]  Run ACP server.' : '2.4.0')
      const service = new AgentManagementService(store, { recipes: [{id:'kimi',name:'Kimi Code',command:'kimi'}], dirs: [bin], appRoots: [], run })
      const [agent] = await service.list()
      expect(agent.version).toBe('2.4.0')
      expect(agent.acpStatus).toBe('verified')
      expect(agent.acp).toMatchObject({ command, args: [...cli.args, 'acp'], env: cli.env })
      expect(JSON.parse((await readFile(log, 'utf8')).trim())).toEqual({ args: [...cli.args, 'acp'], home: cli.env.KIMI_CODE_HOME })
      run.mockClear()
      vi.spyOn(service, 'list').mockRejectedValue(new Error('Model queries must not scan'))
      const list = await service.models('kimi')
      expect(list.models).toHaveLength(2)
      expect(run).toHaveBeenCalledExactlyOnceWith(command, [...cli.args, 'provider', 'list', '--json'], 10000, cli.env)
      await service.configure('kimi', { protocol: 'acp' })
      expect((await store.readGlobalSettings()).launchers?.kimi).toMatchObject({ protocol: 'acp', args: [...cli.args, 'acp'], env: cli.env })
      await service.configure('kimi', { protocol: 'cli', cli: {...cli, model: list.models[0].id} })
      const saved = (await store.readGlobalSettings()).launchers!.kimi
      const invocation = buildLauncherCommand({ actor: 'kimi', ...saved, promptFile: '/tmp/prompt', repoRoot: root, promptText: 'test' })
      expect(invocation.args).toContain('kimi-k2-6')
      expect(invocation.args).not.toContain('moonshot-kimi-k2.6')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each(['no entry', 'help failure'])('retains CLI when ACP is not advertised: %s', async condition => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-kimi-no-acp-'))
    try {
      const command = join(root, 'kimi')
      await writeFile(command, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      const service = new AgentManagementService(store, { recipes: [{id:'kimi',name:'Kimi Code',command:'kimi'}], dirs: [root], appRoots: [], run: async (_command, args) => {
        if (!args.includes('--help')) return '2.4.0'
        if (condition === 'help failure') throw new Error('CLI unavailable')
        return 'Commands:\n  provider  Manage providers'
      } })
      const [agent] = await service.list()
      expect(agent.cli).toBeDefined()
      expect(agent.acp).toBeUndefined()
      expect(agent.acpStatus).toBe('missing')
      expect(agent.runnable).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
