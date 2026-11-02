import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentManagementService } from '../../../src/main/buddy/agents/service'
import { BuddyStore } from '../../../src/main/buddy/store'
import { acquireAgentUse } from '../../../src/main/buddy/agents/locks'
let root:string
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'buddy-inventory-'));await mkdir(join(root,'bin'))})
afterEach(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();await rm(root,{recursive:true,force:true})})
async function fixture(command='test-agent',id='demo') {
  const bin=join(root,'bin'),entry=join(bin,command.split(' ')[0])
  await writeFile(entry,'#!/bin/sh\necho fixture\n',{mode:0o755})
  const store=new BuddyStore(join(root,'data')),run=vi.fn(async()=> '1.0.0')
  const options={dirs:[bin],appRoots:[],recipes:[{id,name:'Demo',command}],run}
  return {store,run,options,service:new AgentManagementService(store,options)}
}
it('snapshot reads never scan; a restart restores cached command metadata without running a CLI',async()=>{
  const {store,run,options,service}=await fixture('wecode codex','wecode_codex')
  expect((await service.getInventory()).agents).toEqual([]);expect(run).not.toHaveBeenCalled()
  await service.refresh();const count=(await service.getInventory()).agents.length;run.mockClear()
  for(const elapsed of [0,30000,60000,3600000]) {
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+elapsed)
    expect((await service.getInventory()).agents).toHaveLength(count)
  }
  expect(run).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  const restored=new AgentManagementService(store,options)
  expect((await restored.getInventory()).agents.find(a=>a.id==='wecode_codex')?.cli?.args).toEqual(['codex'])
  expect(run).not.toHaveBeenCalled()
})
it('keeps registry freshness through a scan and process restart without persisting launcher secrets',async()=>{
  const {store,run,options,service}=await fixture()
  const pkg=join(root,'lib/node_modules/demo-package');await mkdir(pkg,{recursive:true})
  await rm(join(root,'bin/test-agent'));await writeFile(join(pkg,'cli'),'#!/bin/sh\nexit 0\n',{mode:0o755});await symlink(join(pkg,'cli'),join(root,'bin/test-agent'))
  options.recipes[0]={...options.recipes[0],npm:'demo-package'} as typeof options.recipes[0]
  await service.configure('demo',{cli:{command:join(root,'bin/test-agent'),args:['--secret','private-argument'],env:{EXAMPLE_TOKEN:'private-environment'},timeout_seconds:20}})
  const fetch=vi.fn(async()=>({ok:true,json:async()=>({version:'2.0.0'})}));vi.stubGlobal('fetch',fetch)
  await service.refresh();await service.checkUpdates();await service.refresh()
  const file=await readFile(join(root,'data/global/agent-inventory-cache.json'),'utf8')
  expect(file).not.toContain('private-environment');expect(file).not.toContain('private-argument')
  run.mockClear();const restored=new AgentManagementService(store,options)
  expect((await restored.getInventory()).agents[0]).toMatchObject({latest:'2.0.0',cli:{env:{EXAMPLE_TOKEN:'private-environment'}}})
  await restored.checkUpdates()
  expect(fetch).toHaveBeenCalledTimes(1);expect(run).not.toHaveBeenCalled()
})
it('keeps a readable snapshot and a refresh error when discovery fails',async()=>{
  const {store,service}=await fixture();await service.refresh()
  vi.spyOn(store,'readGlobalSettings').mockRejectedValueOnce(new Error('cannot read settings'))
  await expect(service.refresh()).rejects.toThrow('cannot read settings')
  const cached=await service.getInventory()
  expect(cached.agents).toHaveLength(1);expect(cached.error).toContain('cannot read settings');expect(cached.refreshing).toBe(false)
})
it('does not stamp unscreened launch edits as a fresh validated cache',async()=>{
  const {store,options,service}=await fixture();await service.refresh()
  const row=(await service.getInventory()).agents[0]
  await service.configure('demo',{cli:{...row.cli!,args:['changed']}})
  const restored=new AgentManagementService(store,options)
  expect((await restored.getInventory()).agents).toHaveLength(1)
  expect(restored.needsStartupRefresh()).toBe(true)
})
it('ignores a malformed cache and performs no work until explicit refresh',async()=>{
  const {service,run}=await fixture()
  await mkdir(join(root,'data/global'),{recursive:true});await writeFile(join(root,'data/global/agent-inventory-cache.json'),'{broken')
  expect((await service.getInventory()).agents).toEqual([]);expect(run).not.toHaveBeenCalled()
  await service.refresh();expect((await service.getInventory()).agents).toHaveLength(1)
})
it('restores discovered Kimi ACP flags and inherits the current CLI environment without caching it',async()=>{
  const {store,options,service,run}=await fixture('kimi','kimi')
  run.mockImplementation(async(_command,args)=>args.includes('--help')?'Options:\n  --acp  Run the ACP server':'2.4.0')
  await service.configure('kimi',{cli:{command:join(root,'bin/kimi'),args:['--profile','private-profile'],env:{PRIVATE_VALUE:'private-env'},timeout_seconds:20}})
  vi.spyOn(service as any,'probeTarget').mockImplementation(async(a:any)=>({...a,acpStatus:'verified'}))
  await service.refresh()
  const disk=await readFile(join(root,'data/global/agent-inventory-cache.json'),'utf8')
  expect(disk).not.toContain('private-profile');expect(disk).not.toContain('private-env')
  const restored=new AgentManagementService(store,options)
  expect((await restored.getInventory()).agents.find(a=>a.id==='kimi')?.acp).toMatchObject({args:['--profile','private-profile','--acp'],env:{PRIVATE_VALUE:'private-env'}})
})

it.each([
  { selection: 'automatic', installed: '0.166.0', status: 'up_to_date' },
  { selection: 'automatic', installed: '0.165.0', status: 'updated' },
  { selection: 'explicit', installed: '0.166.0', status: 'updated' }
])('resolves a stale Codex cache with $selection selection and a new PATH installation at $installed',async({selection,installed,status})=>{
  const resolvedRoot=await realpath(root)
  const previous=join(resolvedRoot,'npm-global'),preferred=join(resolvedRoot,'homebrew')
  const versions=new Map<string,string>()
  const install=async(prefix:string,version:string)=>{
    const bin=join(prefix,'bin'),pkg=join(prefix,'lib/node_modules/@openai/codex')
    await mkdir(bin,{recursive:true});await mkdir(pkg,{recursive:true})
    await writeFile(join(pkg,'cli.js'),'#!/bin/sh\nexit 0\n',{mode:0o755})
    await symlink(join(pkg,'cli.js'),join(bin,'codex'))
    versions.set(join(bin,'codex'),version)
  }
  await install(previous,'0.163.0')
  const run=vi.fn(async(command:string,args:string[])=>{
    if(args[0]==='install'){
      versions.set(join(args[args.indexOf('--prefix')+1],'bin/codex'),'0.166.0')
      return ''
    }
    return versions.get(command) || ''
  })
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({version:'0.166.0'})})))
  const service=new AgentManagementService(new BuddyStore(join(root,'data')),{
    dirs:[join(preferred,'bin'),join(previous,'bin')],appRoots:[],
    recipes:[{id:'codex',name:'Codex',command:'codex',npm:'@openai/codex'}],run
  })
  await service.refresh();await service.checkUpdates()
  const cached=(await service.getInventory()).agents[0]
  expect(cached.path).toBe(join(previous,'bin/codex'))
  if(selection==='explicit')await service.configure('codex',{cli:cached.cli})
  await install(preferred,installed)
  const accepted=await service.updates.start(['codex'],'path-change')
  expect(accepted.activeBatch?.items[0].installationId).toBe(cached.installationId)
  await service.updates.waitForIdle()
  const result=(await service.updates.getState()).lastCompletedBatch!.items[0]
  const resolved=(await service.getInventory()).agents[0]
  const selectedPrefix=selection==='explicit'?previous:preferred
  expect(resolved.path).toBe(join(selectedPrefix,'bin/codex'))
  expect(result).toMatchObject({status,installationId:resolved.installationId,source:'npm',after:'0.166.0'})
  expect(result.error).toBeUndefined()
  const installers=run.mock.calls.filter(([,args])=>args[0]==='install')
  if(status==='up_to_date')expect(installers).toEqual([])
  else expect(installers).toEqual([[join(selectedPrefix,'bin/npm'),['install','-g','--prefix',selectedPrefix,'@openai/codex@0.166.0'],600000,undefined]])
  expect(versions.get(join(selection==='explicit'?preferred:previous,'bin/codex'))).toBe(selection==='explicit'?installed:'0.163.0')
})

it.each(['command','args','env'] as const)('rejects an explicit CLI %s change while an update waits',async(field)=>{
  const {service,run}=await fixture('codex','codex')
  run.mockImplementation(async(_command,args)=>args.includes('--help')?'Commands:\n  upgrade  Upgrade Codex':'0.163.0')
  await service.refresh()
  const cli=(await service.getInventory()).agents[0].cli!
  const release=await acquireAgentUse()
  try {
    await service.updates.start(['codex'],'configuration-change')
    const change=field==='command'?{command:cli.command+'-other'}:field==='args'?{args:['--profile','changed']}:{env:{TEST_TOKEN:'private-new-value'}}
    await service.configure('codex',{cli:{...cli,...change}})
  }finally{release()}
  await service.updates.waitForIdle()
  expect((await service.updates.getState()).lastCompletedBatch?.items[0]).toMatchObject({status:'failed',error:expect.stringContaining('configuration changed')})
  expect(run.mock.calls.some(([,args])=>args.includes('upgrade'))).toBe(false)
  expect(await readFile(join(root,'data/global/agent-update-jobs.json'),'utf8')).not.toContain('private-new-value')
})
