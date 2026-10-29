import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeUpdateCommandFromHelp } from '../../../src/main/buddy/agents/capabilities'
import { parseCursorModels } from '../../../src/main/buddy/agents/models'
import { AgentManagementService } from '../../../src/main/buddy/agents/service'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyCoreService } from '../../../src/main/buddy/service'

const cursorModels = 'Available models\n\nauto - Auto (current, default)\ncomposer-2.5 - Composer 2.5\ncomposer-2.5 - Duplicate\nTip: use --model <id> to switch.'

describe('native capabilities', () => {
  it('reads update commands only from declarations, preserving wrapper help semantics', () => {
    expect(nativeUpdateCommandFromHelp('Commands:\n  upgrade          Upgrade wecode-cli to the latest version\n')).toBe('upgrade')
    expect(nativeUpdateCommandFromHelp('Commands:\n  update [version]  Upgrade (or pin) the opencode binary\n')).toBe('update')
    expect(nativeUpdateCommandFromHelp('Commands:\n  update|upgrade   Check for updates and install if available')).toBe('update')
    expect(nativeUpdateCommandFromHelp('Commands:\n  update <file>    Update configuration file')).toBeUndefined()
    expect(nativeUpdateCommandFromHelp('Example:\n  upgrade          Upgrade to latest version')).toBeUndefined()
  })

  it('parses Cursor IDs and names without headings, markers or duplicate rows', () => {
    expect(parseCursorModels('\u001b[32m'+cursorModels+'\u001b[0m')).toEqual([{ id: 'auto', name: 'Auto' }, { id: 'composer-2.5', name: 'Composer 2.5' }])
  })

  it('fills legacy Cursor ACP args and verifies initialization, then queries native models with launcher env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-cursor-capabilities-'))
    try {
      const command = join(root, 'cursor-agent')
      await writeFile(command, `#!${process.execPath}
if (!process.argv.includes('acp')) process.exit(3)
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}}))
})\n`, { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      await store.updateGlobalSettings({ agent_management: { cursor: { acp: { command, env: {}, timeout_seconds: 20, protocol: 'acp' } } }, launchers: { cursor: { command, args: ['--workspace', 'team'], env: { CURSOR_TEST: 'fixture' }, timeout_seconds: 20 } } })
      const run = vi.fn(async (_command: string, args: string[]) => args.includes('models') ? cursorModels : args.includes('--help') ? 'Commands:\n  update  Update Cursor Agent to the latest version' : '2026.09.15-d2fe57e')
      const service = new AgentManagementService(store, { dirs: [root], appRoots: [], recipes: [{ id: 'cursor', name: 'Cursor', command: 'cursor-agent', acp: ['acp'] }], run })
      const [agent] = await service.list()
      expect(agent.acp?.args).toEqual(['acp'])
      expect(agent.acpStatus).toBe('verified')
      run.mockClear()
      expect((await service.models('cursor')).models).toHaveLength(2)
      expect(run).toHaveBeenCalledExactlyOnceWith(command, ['--workspace', 'team', 'models'], 30000, { CURSOR_TEST: 'fixture' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('discovers three WeCode updater contexts via help, checks read-only and executes only requested native updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-wecode-update-'))
    try {
      const bin = join(root, 'bin'); await mkdir(bin)
      const command = join(bin, 'wecode'); await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const store = new BuddyStore(join(root, 'data'))
      const calls: string[][] = []
      let updated = false
      const service = new AgentManagementService(store, { dirs: [bin], appRoots: [], recipes: [
        { id: 'wecode_claude', name: 'WeCode Claude', command: 'wecode' },
        { id: 'wecode_codex', name: 'WeCode Codex', command: 'wecode codex' },
        { id: 'wecode_opencode', name: 'WeCode OpenCode', command: 'wecode opencode' }
      ], run: async (_command, args) => {
        calls.push(args)
        if (args.at(-1) === 'help') return 'Commands:\n  upgrade   Upgrade to the latest version\n'
        if (args.at(-1) === 'upgrade') { updated = true; return '' }
        if (args[0] === 'version') return 'wecode-cli version: ' + (updated ? '4.0.40' : '4.0.39')
        return args[0] === 'codex' ? '0.164.0' : args[0] === 'opencode' ? '1.19.4' : '2.1.159'
      } })
      await service.refresh()
      const agents = await service.checkUpdates()
      expect(calls.filter(args => args.at(-1) === 'help')).toEqual(expect.arrayContaining([['help'], ['codex', 'help'], ['opencode', 'help']]))
      expect(calls.some(args => args.includes('--help') || args.includes('upgrade'))).toBe(false)
      expect(agents.find(a => a.id === 'wecode_claude')?.nativeUpdate).toMatchObject({ args: ['upgrade'], version: '4.0.39', target: 'wecode' })
      expect(agents.find(a => a.id === 'wecode_codex')?.nativeUpdate).toMatchObject({ args: ['codex', 'upgrade'], version: '0.164.0', target: 'agent' })
      expect(agents.find(a => a.id === 'wecode_opencode')?.nativeUpdate).toMatchObject({ args: ['opencode', 'upgrade'], target: 'agent' })
      // Saving an absolute executable keeps the wrapper subcommand in args.
      await service.configure('wecode_codex', { cli: { ...agents.find(a => a.id === 'wecode_codex')!.cli!, model: 'test-model' } })
      const rescanned = await service.list(true)
      expect(rescanned.find(a => a.id === 'wecode_codex')).toMatchObject({ version: '0.164.0', cli: { args: ['codex'] }, nativeUpdate: { args: ['codex', 'upgrade'] } })
      const jobs = await service.update(['wecode_claude', 'wecode_claude'])
      expect(calls.filter(args => args.at(-1) === 'upgrade')).toEqual([['upgrade']])
      expect(jobs.map(j => j.status)).toEqual(['success', 'skipped'])
      expect(jobs[0]).toMatchObject({ before: '4.0.39', after: '4.0.40' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps the General timeout across protocol switches and stale advanced/model saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-shared-timeout-'))
    try {
      const core = new BuddyCoreService(root)
      const cli = { command: 'cursor-agent', env: { TEST: 'kept' }, args: ['--workspace', 'team'], timeout_seconds: 7200, model: 'auto' }
      const acp = { ...cli, args: ['acp'], protocol: 'acp' as const }
      await core.configureAgent('cursor', { cli, acp, protocol: 'cli' })
      const settings = (await core.bootstrap()).global_settings!
      await core.updateGlobalSettings({ ...settings, launchers: Object.fromEntries(Object.entries(settings.launchers!).map(([id, launcher]) => [id, { ...launcher, timeout_seconds: 321 }])) })
      await core.configureAgent('cursor', { protocol: 'acp', acp })
      expect((await core.bootstrap()).global_settings?.launchers?.cursor.timeout_seconds).toBe(321)
      await core.configureAgent('cursor', { protocol: 'cli', cli: { ...cli, args: ['--workspace', 'edited'] } })
      const saved = (await core.bootstrap()).global_settings!
      expect(saved.launchers?.cursor).toMatchObject({ timeout_seconds: 321, model: 'auto', env: { TEST: 'kept' }, args: ['--workspace', 'edited'] })
      expect(saved.agent_management?.cursor.acp?.timeout_seconds).toBe(321)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
