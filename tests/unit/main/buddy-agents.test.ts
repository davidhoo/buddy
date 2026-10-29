import { describe, expect, it, vi } from 'vitest'
import { buildLauncherCommand } from '../../../src/main/buddy/launchers'
import { acquireAgentUse, acquireAgentUpdate } from '../../../src/main/buddy/agents/locks'
import { newer } from '../../../src/main/buddy/agents/service'
import { normalizeGlobalSettings, normalizeLauncher } from '../../../src/shared/defaults'

describe('local agent configuration and execution',()=>{
  it('preserves CLI argv containing spaces and replaces a previous model once',()=>{
    const launcher=normalizeLauncher('codex',{command:'codex',args:['--model','old','--config','a path'],model:'new'})
    const result=buildLauncherCommand({actor:'codex',...launcher,promptFile:'/tmp/prompt',repoRoot:'/tmp/project'})
    expect(result.args).toContain('new')
    expect(result.args).not.toContain('old')
    expect(result.args).toContain('a path')
  })
  it('retains both protocol overrides when normalizing global settings',()=>{
    const input={agent_management:{codex:{protocol:'cli' as const,cli:{command:'codex',args:[],env:{},timeout_seconds:20},acp:{command:'adapter',args:['a path'],env:{},timeout_seconds:20}}}}
    expect(normalizeGlobalSettings(input).agent_management).toEqual(input.agent_management)
  })
  it('only orders comparable stable versions',()=>{
    expect(newer('2.10.0','2.9.0')).toBe(true)
    expect(newer('2.0.0-beta','1.0.0')).toBe(false)
    expect(newer('2026.hash','2.0.0')).toBe(false)
  })
  it('excludes updates while a task owns the runtime and makes new tasks wait during updates',async()=>{
    const release=await acquireAgentUse()
    expect(acquireAgentUpdate()).toBeUndefined()
    release()
    const unlock=acquireAgentUpdate()!
    let started=false
    const pending=acquireAgentUse().then(release=>{started=true;return release})
    await Promise.resolve()
    expect(started).toBe(false)
    unlock()
    const releaseSecond=await pending
    expect(started).toBe(true)
    releaseSecond()
  })
})

import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentManagementService } from '../../../src/main/buddy/agents/service'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyRunner } from '../../../src/main/buddy/runner'

it('discovers a real executable, updates through its original prefix and verifies the executable again',async()=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-agent-test-'))
  try {
    const bin=join(root,'bin'),pkg=join(root,'lib/node_modules/test-agent')
    await mkdir(bin,{recursive:true});await mkdir(pkg,{recursive:true})
    const cli=join(pkg,'cli');await writeFile(cli,'#!/bin/sh\necho 1.0.0\n',{mode:0o755});await symlink(cli,join(bin,'codebuddy'))
    const store=new BuddyStore(join(root,'data'))
    let version='1.0.0';const calls:string[][]=[]
    const service=new AgentManagementService(store,{dirs:[bin],appRoots:[],recipes:[{id:'codebuddy',name:'CodeBuddy',command:'codebuddy',npm:'test-agent',modelFlag:'--model'}],run:async(command,args)=>{
      calls.push([command,...args])
      if(args[0]==='install'){version='2.0.0';return ''}
      return version
    }})
    const agents=await service.list()
    expect(agents).toHaveLength(1)
    expect(agents[0].source).toBe('npm')
    agents[0].latest='2.0.0'
    agents[0].checkedAt=new Date().toISOString()
    const jobs=await service.update(['codebuddy','codebuddy'])
    expect(jobs.map(j=>j.status)).toEqual(['success','skipped'])
    expect(calls.filter(c=>c[1]==='install')).toEqual([[join(await realpath(root),'bin/npm'),'install','-g','--prefix',await realpath(root),'test-agent@2.0.0']])
    expect(jobs[0].after).toBe('2.0.0')
  }finally{await rm(root,{recursive:true,force:true})}
})

it('persists and reads a running actor absent from the legacy enumeration',async()=>{
  const root=await mkdtemp(join(tmpdir(),'buddy-dynamic-test-'))
  try {
    const store=new BuddyStore(root)
    const created=await store.createTask({task_id:'dynamic',repo_root:root,settings:{implementer_actor:'custom-acp',reviewer_actor:'codex',launchers:{'custom-acp':{command:'test-adapter',protocol:'acp',args:[],env:{},timeout_seconds:10}}}})
    const runner=new BuddyRunner(store,{executeLaunchers:false})
    await runner.startTask('dynamic',{workspace_key:created.workspace_key,actor:'custom-acp'})
    const detail=await store.getTaskDetail('dynamic',created.workspace_key)
    expect(detail.state.status).toBe('RUNNING_AGENT')
    expect(detail.state.active_run?.actor).toBe('custom-acp')
  }finally{await rm(root,{recursive:true,force:true})}
})


it('saves WeCode ACP to CLI immediately without waiting for discovery or probing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-fast-protocol-'))
  try {
    const store = new BuddyStore(root)
    const cli = { command: 'wecode', args: [], env: {}, timeout_seconds: 20, model: 'cli-model' }
    const acp = { command: 'claude-agent-acp', args: [], env: {}, timeout_seconds: 20, protocol: 'acp' as const, model: 'acp-model' }
    await store.updateGlobalSettings({ agent_management: { wecode_claude: { protocol: 'acp', cli, acp } }, launchers: { wecode_claude: acp } })
    const run = vi.fn()
    const service = new AgentManagementService(store, { run })
    const discovery = vi.spyOn(service, 'list').mockImplementation(() => new Promise(() => {}))
    await service.configure('wecode_claude', { protocol: 'cli' })
    const settings = await store.readGlobalSettings()
    expect(settings.launchers?.wecode_claude).toMatchObject({ command: 'wecode', model: 'cli-model' })
    expect(settings.launchers?.wecode_claude.protocol).not.toBe('acp')
    expect(settings.agent_management?.wecode_claude.acp).toEqual({ ...acp, timeout_seconds: 7200 })
    expect(discovery).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not discover desktop-only apps and only rescans an edited launch target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-target-scan-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    for (const name of ['codebuddy', 'opencode']) await writeFile(join(bin, name), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 })
    const store = new BuddyStore(join(root, 'data'))
    const run = vi.fn(async (_command: string, _args: string[]) => '1.0.0')
    const service = new AgentManagementService(store, { dirs: [bin], appRoots: ['/Applications'], recipes: [
      { id: 'codebuddy', name: 'CodeBuddy', command: 'codebuddy' },
      { id: 'opencode', name: 'OpenCode', command: 'opencode' },
      { id: 'claude_desktop', name: 'Claude Desktop', command: '', app: 'Claude' }
    ], run })
    const rows = await service.list()
    expect(rows.map(a => a.id).sort()).toEqual(['codebuddy', 'opencode'])
    const row = rows.find(a => a.id === 'codebuddy')!
    run.mockClear()
    await service.configure(row.id, { enabled: false })
    expect((await service.list()).find(a => a.id === row.id)?.enabled).toBe(false)
    expect(run).not.toHaveBeenCalled()
    await service.configure(row.id, { cli: { ...row.cli!, args: ['--profile', 'edited'] } })
    expect(run).not.toHaveBeenCalled()
    const refreshed = await service.list()
    expect(refreshed).toHaveLength(2)
    expect(run.mock.calls.every(call => call[0].endsWith('/codebuddy'))).toBe(true)
    expect(refreshed.find(a => a.id === row.id)?.cli?.args).toEqual(['--profile', 'edited'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('a scan already in flight cannot undo a protocol save, while a later scan respects persisted edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-scan-save-race-'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'codebuddy'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 })
    const cli = { command: join(bin, 'codebuddy'), args: [], env: {}, timeout_seconds: 20 }
    const acp = { ...cli, args: ['--acp'], protocol: 'acp' as const }
    const store = new BuddyStore(join(root, 'data'))
    await store.updateGlobalSettings({ agent_management: { codebuddy: { protocol: 'acp', cli, acp } }, launchers: { codebuddy: acp } })
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const service = new AgentManagementService(store, { dirs: [bin], appRoots: [], recipes: [{ id: 'codebuddy', name: 'CodeBuddy', command: 'codebuddy' }], run: async () => { started(); await gate; return '1.0.0' } })
    vi.spyOn(service as unknown as { probeTarget(a: import('../../../src/shared/agents').LocalAgent): Promise<import('../../../src/shared/agents').LocalAgent> }, 'probeTarget').mockImplementation(async agent => agent)
    const pending = service.list()
    await entered
    await service.configure('codebuddy', { protocol: 'cli' })
    release()
    expect((await pending)[0].selectedProtocol).toBe('cli')
    const saved = await store.readGlobalSettings()
    await store.updateGlobalSettings({ ...saved, agent_management: { codebuddy: { ...saved.agent_management!.codebuddy, protocol: 'acp' } } })
    expect((await service.list(true))[0].selectedProtocol).toBe('acp')
  } finally { release(); await rm(root, { recursive: true, force: true }) }
})
