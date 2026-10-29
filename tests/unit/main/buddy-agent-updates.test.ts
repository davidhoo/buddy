import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentUpdateQueue, runUpdateCommand, updateProcessAlive } from '../../../src/main/buddy/agents/updates'
import { AgentUpdateQuitGuard } from '../../../src/main/buddy/agents/lifecycle'
import { acquireAgentUse, acquireAgentUpdate, waitForAgentUpdate } from '../../../src/main/buddy/agents/locks'
import { atomicWriteJson } from '../../../src/main/buddy/store'
import type { AgentUpdateSnapshot, LocalAgent } from '../../../src/shared/agents'

let root:string
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'buddy-update-queue-'))})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
const agent=(id='demo'):LocalAgent=>({id,name:id,installationId:id,path:'/tmp/'+id,realPath:'/tmp/'+id,version:'1.0.0',source:'unknown',runnable:true,enabled:true,selectedProtocol:'cli',cli:{command:'/tmp/'+id,args:[],env:{},timeout_seconds:10},nativeUpdate:{command:'/tmp/'+id,args:['upgrade'],versionArgs:['--version'],version:'1.0.0',target:'agent'}})
const dependencies=()=>({dataRoot:root,targets:vi.fn(async()=>[agent('a'),agent('b')]),prepare:vi.fn(async()=>[agent('a'),agent('b')]),execute:vi.fn(async()=>{}),verify:vi.fn(async(a:LocalAgent)=>({...a,version:'2.0.0',nativeUpdate:{...a.nativeUpdate!,version:'2.0.0'}}))})

describe('durable global Agent update queue',()=>{
  it('accepts immediately, deduplicates concurrent requests and keeps last results during the next batch',async()=>{
    const hold=gate(),deps=dependencies();deps.execute.mockImplementation(()=>hold.promise)
    const q=new AgentUpdateQueue(deps)
    const [a,b]=await Promise.all([q.start(['a'],'request-1'),q.start(['b'],'request-2')])
    expect(a.activeBatch?.id).toBe(b.activeBatch?.id)
    expect(JSON.parse(await readFile(join(root,'global/agent-update-jobs.json'),'utf8')).activeBatch.id).toBe(a.activeBatch?.id)
    await vi.waitFor(()=>expect(deps.execute).toHaveBeenCalledTimes(1))
    hold.resolve();await q.waitForIdle()
    expect((await q.getState()).lastCompletedBatch?.items[0].status).toBe('updated')
    const same=await q.start(['a'],'request-1');expect(same.activeBatch).toBeUndefined()
    const next=await q.start(['b'],'request-3')
    expect(next.lastCompletedBatch?.id).toBe(a.activeBatch?.id)
    expect(next.activeBatch?.id).not.toBe(a.activeBatch?.id)
    await q.waitForIdle()
  })
  it('cancels only remaining items while the current installer finishes verification',async()=>{
    const hold=gate(),deps=dependencies();deps.execute.mockImplementation(()=>hold.promise)
    const q=new AgentUpdateQueue(deps);await q.start(['a','b'],'cancel')
    await vi.waitFor(()=>expect(deps.execute).toHaveBeenCalledTimes(1));await q.cancel()
    expect((await q.getState()).activeBatch?.cancelRequested).toBe(true)
    hold.resolve();await q.waitForIdle()
    expect(deps.verify).toHaveBeenCalledTimes(1)
    expect((await q.getState()).lastCompletedBatch?.items.map(i=>i.status)).toEqual(['updated','cancelled'])
  })
  it('serves snapshots and cancels while waiting for an actor without starting discovery',async()=>{
    const release=await acquireAgentUse(),deps=dependencies(),q=new AgentUpdateQueue(deps)
    try {
      await q.start(['a'],'wait')
      await vi.waitFor(async()=>expect((await q.getState()).activeBatch?.status).toBe('waiting'))
      expect(deps.prepare).not.toHaveBeenCalled()
      await q.cancel();await q.waitForIdle()
      expect(deps.execute).not.toHaveBeenCalled()
      expect((await q.getState()).lastCompletedBatch?.items[0].status).toBe('cancelled')
    }finally{release()}
  })
  it.each(['prepare','execute','verify'] as const)('releases the lease after a %s failure and permits retry',async(stage)=>{
    const deps=dependencies();deps[stage].mockRejectedValueOnce(new Error('test failure'))
    const q=new AgentUpdateQueue(deps);await q.start(['a'],'failure');await q.waitForIdle()
    expect((await q.getState()).lastCompletedBatch?.items[0].status).toBe('failed')
    const release=acquireAgentUpdate();expect(release).toBeTypeOf('function');release?.()
    await q.start(['a'],'retry');await q.waitForIdle()
    expect((await q.getState()).lastCompletedBatch?.items[0].status).toBe('updated')
  })
  it('fails safely before spawning when persistence fails, then releases the lease',async()=>{
    const deps=dependencies();let writes=0
    const q=new AgentUpdateQueue({...deps,save:async(path,data)=>{if(++writes===3)throw new Error('disk full');await atomicWriteJson(path,data)}})
    await q.start(['a'],'disk');await q.waitForIdle()
    expect(deps.execute).not.toHaveBeenCalled()
    expect((await q.getState()).lastCompletedBatch?.error).toContain('disk full')
    const release=acquireAgentUpdate();expect(release).toBeTypeOf('function');release?.()
  })
  it('distinguishes native no-op, duplicate updater and invalid post-update runtime',async()=>{
    const deps=dependencies();deps.verify.mockImplementation(async a=>a)
    const q=new AgentUpdateQueue(deps);await q.start(['a','a'],'same');await q.waitForIdle()
    expect((await q.getState()).lastCompletedBatch?.items.map(i=>i.status)).toEqual(['up_to_date','skipped'])
    deps.verify.mockImplementation(async a=>({...a,runnable:false}))
    await q.start(['a'],'broken');await q.waitForIdle()
    expect((await q.getState()).lastCompletedBatch?.items[0].status).toBe('failed')
  })
  it('rejects configuration changes and downgrades before reporting success',async()=>{
    const deps=dependencies();deps.prepare.mockResolvedValueOnce([{...agent('a'),cli:{...agent('a').cli!,env:{HOME:'/different'}}}])
    const q=new AgentUpdateQueue(deps);await q.start(['a'],'changed');await q.waitForIdle()
    expect(deps.execute).not.toHaveBeenCalled()
    deps.verify.mockImplementation(async a=>({...a,nativeUpdate:{...a.nativeUpdate!,version:'0.9.0'}}))
    await q.start(['a'],'downgrade');await q.waitForIdle()
    expect((await q.getState()).lastCompletedBatch?.items[0].status).toBe('failed')
  })
  it('recovers interrupted work without replaying it and blocks retry until its process group exits',async()=>{
    await atomicWriteJson(join(root,'global/agent-update-jobs.json'),{schemaVersion:2,revision:8,activeBatch:{id:'old',requestId:'old',status:'running',cancelRequested:false,items:[{id:'old-a',agentId:'a',name:'a',status:'installing',process:{pid:123,started:'old',command:'installer'}}]}})
    const deps=dependencies(),alive=vi.fn(async()=>true),q=new AgentUpdateQueue({...deps,processAlive:alive})
    expect((await q.getState()).lastCompletedBatch?.items[0].status).toBe('interrupted')
    expect(deps.execute).not.toHaveBeenCalled()
    await expect(q.start(['a'],'retry')).rejects.toThrow('still running')
    alive.mockResolvedValue(false);await q.start(['a'],'retry');await q.waitForIdle()
    expect(deps.execute).toHaveBeenCalledTimes(1)
  })
  it('migrates legacy jobs without inventing completion dates',async()=>{
    await atomicWriteJson(join(root,'global/agent-update-jobs.json'),[{id:'old',agentId:'a',status:'success',before:'1',after:'2'}])
    const q=new AgentUpdateQueue(dependencies()),state=await q.getState()
    expect(state.lastCompletedBatch).toMatchObject({items:[{status:'updated'}]})
    expect(state.lastCompletedBatch?.finishedAt).toBeUndefined()
  })
  it('emits ordered revisions and durable final state',async()=>{
    const q=new AgentUpdateQueue(dependencies()),states:AgentUpdateSnapshot[]=[]
    q.subscribe(s=>states.push(s));await q.start(['a'],'events');await q.waitForIdle()
    expect(states.map(s=>s.revision)).toEqual([...new Set(states.map(s=>s.revision))].sort((a,b)=>a-b))
    expect(states.at(-1)).toEqual(JSON.parse(await readFile(join(root,'global/agent-update-jobs.json'),'utf8')))
  })
})

it('gives a waiting writer priority over new readers without starving or nesting',async()=>{
  const release=await acquireAgentUse(),order:string[]=[],controller=new AbortController()
  const writer=waitForAgentUpdate(controller.signal).then(unlock=>{order.push('writer');return unlock})
  const reader=acquireAgentUse().then(unlock=>{order.push('reader');return unlock})
  release();const unlock=await writer;expect(order).toEqual(['writer'])
  unlock();(await reader)();expect(order).toEqual(['writer','reader'])
  controller.abort();await expect(waitForAgentUpdate(controller.signal)).rejects.toThrow('cancelled')
})

it('uses the same finish-current quit guard for normal quit and application upgrade',async()=>{
  const hold=gate(),deps=dependencies();deps.execute.mockImplementation(()=>hold.promise)
  const q=new AgentUpdateQueue(deps);await q.start(['a','b'],'quit')
  await vi.waitFor(()=>expect(deps.execute).toHaveBeenCalledTimes(1))
  const choose=vi.fn(async()=> 'background' as 'background'|'finish'),quit=vi.fn(),guard=new AgentUpdateQuitGuard(q,choose)
  expect(await guard.request(quit)).toBe(false);expect(quit).not.toHaveBeenCalled()
  choose.mockResolvedValue('finish');const pending=guard.request(quit)
  await vi.waitFor(async()=>expect((await q.getState()).activeBatch?.cancelRequested).toBe(true))
  expect(quit).not.toHaveBeenCalled();hold.resolve();expect(await pending).toBe(true)
  expect(quit).toHaveBeenCalledTimes(1);expect(deps.execute).toHaveBeenCalledTimes(1)
})

it('persists installer identity before execution; failed persistence never executes the command',async()=>{
  const marker=join(root,'ran'),identified=vi.fn(async info=>{expect(await updateProcessAlive(info)).toBe(true)})
  await runUpdateCommand('/bin/sh',['-c','echo ok > "$1"','fixture',marker],undefined,identified)
  expect(identified).toHaveBeenCalledTimes(1);expect(await readFile(marker,'utf8')).toBe('ok\n')
  await rm(marker)
  await expect(runUpdateCommand('/bin/sh',['-c','echo bad > "$1"','fixture',marker],undefined,async()=>{throw new Error('disk unavailable')})).rejects.toThrow('disk unavailable')
  await expect(readFile(marker)).rejects.toThrow()
})

it('cleans up the installer process group on timeout',async()=>{
  let processInfo:Parameters<typeof updateProcessAlive>[0]|undefined
  await expect(runUpdateCommand('/bin/sh',['-c','sleep 30'],undefined,async info=>{processInfo=info},100)).rejects.toThrow('timed out')
  expect(await updateProcessAlive(processInfo!)).toBe(false)
})
