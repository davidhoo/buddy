import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { AgentUpdateBatch, AgentUpdateItem, AgentUpdateSnapshot, LocalAgent } from '../../../shared/agents'
import { isAgentUpdateTerminal, isNewerStableVersion } from '../../../shared/agents'
import { agentUpdateJobsSchema, agentUpdateSnapshotSchema } from '../schemas'
import { atomicWriteJson } from '../store'
import { redactSensitiveText } from '../redact'
import { mergeChildEnv } from '../shell-path'
import { waitForAgentUpdate } from './locks'

const now = () => new Date().toISOString()
const safeError = (error: unknown) => redactSensitiveText(String(error)).slice(0, 2000)
export function updateTargetKey(a: LocalAgent): string {
  return createHash('sha256').update(JSON.stringify([a.installationId,a.source,a.prefix,a.package,a.nativeUpdate?.command,a.nativeUpdate?.args,a.cli?.command,a.cli?.args,a.cli?.env])).digest('hex')
}
export function updaterKey(a: LocalAgent): string {
  return JSON.stringify(a.nativeUpdate ? [a.nativeUpdate.command,a.nativeUpdate.args] : [a.source,a.prefix,a.package,a.manager])
}
const ps = (args: string[]) => new Promise<string>((resolve, reject) => execFile('/bin/ps', args, {timeout:3000}, (error, stdout) => error ? reject(error) : resolve(stdout.trim())))
export async function updateProcessAlive(info: NonNullable<AgentUpdateItem['process']>): Promise<boolean> {
  // Include the process group: an installer can exit while a child still mutates files.
  const rows = await ps(['-axo','pid=,pgid=,lstart=,comm='])
  return rows.split('\n').some(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line)
    if (!match) return false
    return Number(match[1]) === info.pid && match[3].trim() === info.started.trim() ||
      Number(match[2]) === info.pid && Date.parse(match[3]) >= Date.parse(info.started)
  })
}
export async function runUpdateCommand(command: string, args: string[], env: Record<string,string> | undefined, onProcess: (info: NonNullable<AgentUpdateItem['process']>) => Promise<void>, timeoutMs=600000): Promise<void> {
  // Do not let the installer run before its process-group identity is durable.
  // EOF on app crash before approval exits the shell without executing anything.
  const child = spawn('/bin/sh', ['-c','IFS= read -r ready && [ "$ready" = run ] && exec "$@"','buddy-updater',command,...args], {env:mergeChildEnv(process.env,env),stdio:['pipe','pipe','pipe'],detached:true})
  let identity: NonNullable<AgentUpdateItem['process']>|undefined
  let stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192) })
  child.stdout.resume()
  const stop = (signal: NodeJS.Signals) => { if(child.pid) try { process.kill(-child.pid,signal) } catch { /* exited */ } }
  let timedOut = false
  let force:NodeJS.Timeout|undefined
  const terminate=()=>{stop('SIGTERM');force??=setTimeout(()=>stop('SIGKILL'),1000);force.unref();return force}
  const timer=setTimeout(()=>{timedOut=true;terminate()},timeoutMs)
  const finished = new Promise<void>((resolve,reject) => {
    child.once('error',reject)
    child.once('close',code => code===0 && !timedOut ? resolve() : reject(new Error(timedOut ? 'Update timed out' : safeError(stderr || `Updater exited with code ${code}`))))
  })
  // Attach a rejection observer before reading/persisting the process identity.
  void finished.catch(()=>{})
  try {
    if(!child.pid)throw new Error('Cannot start updater')
    const started=await ps(['-p',String(child.pid),'-o','lstart='])
    if(!started)throw new Error('Cannot identify updater process')
    identity={pid:child.pid,started,command}
    await onProcess(identity)
    child.stdin.on('error',()=>{})
    child.stdin.end('run\n')
    await finished
    if(await updateProcessAlive(identity))throw new Error('Updater left child processes running')
  } catch(error) {
    const force=terminate()
    await finished.catch(()=>{})
    // Always kill lingering descendants before releasing the update lease.
    stop('SIGKILL');clearTimeout(force)
    if(identity)for(let attempt=0;attempt<20 && await updateProcessAlive(identity);attempt++)await new Promise(resolve=>setTimeout(resolve,25))
    throw error
  }
  finally { clearTimeout(timer);clearTimeout(force) }
}

interface UpdateDependencies {
  dataRoot: string
  targets(): Promise<LocalAgent[]>
  prepare(ids: string[]): Promise<LocalAgent[]>
  execute(agent: LocalAgent, onProcess: (info: NonNullable<AgentUpdateItem['process']>) => Promise<void>): Promise<void>
  verify(agent: LocalAgent): Promise<LocalAgent | undefined>
  save?: (path:string,value:unknown)=>Promise<void>
  processAlive?: typeof updateProcessAlive
}

export class AgentUpdateQueue {
  private state: AgentUpdateSnapshot = {schemaVersion:2,revision:0}
  private loaded?: Promise<void>
  private starts: Promise<unknown> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()
  private execution?: Promise<void>
  private cancelWait?: AbortController
  private listeners = new Set<(state:AgentUpdateSnapshot)=>void>()
  constructor(private deps: UpdateDependencies) {}
  subscribe(listener:(state:AgentUpdateSnapshot)=>void) { this.listeners.add(listener); return ()=>{this.listeners.delete(listener)} }
  private copy() { return structuredClone(this.state) }
  private emit(snapshot=this.copy()) { for(const listener of this.listeners) try {listener(snapshot)} catch { /* UI observers never stop a job */ } }
  private persist(): Promise<void> {
    this.state.revision++
    const snapshot=this.copy()
    const pending=this.writes.catch(()=>{}).then(()=> (this.deps.save || atomicWriteJson)(join(this.deps.dataRoot,'global','agent-update-jobs.json'),snapshot))
    this.writes=pending
    return pending.then(()=>this.emit(snapshot))
  }
  private initialize() {
    return this.loaded ??= (async()=>{
      let raw: unknown
      try {raw=JSON.parse(await readFile(join(this.deps.dataRoot,'global','agent-update-jobs.json'),'utf8'))}
      catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('Cannot read Agent update history: '+safeError(error))}
      if(Array.isArray(raw)) {
        const jobs=agentUpdateJobsSchema.parse(raw)
        if(jobs.length) this.state.lastCompletedBatch={id:randomUUID(),requestId:'legacy',status:'completed',cancelRequested:false,items:jobs.map(job=>({...job,name:job.agentId,status:job.status==='success'?'updated':['queued','updating','verifying'].includes(job.status)?'interrupted':job.status as AgentUpdateItem['status']}))}
        await this.persist()
      } else this.state=agentUpdateSnapshotSchema.parse(raw)
      if(this.state.activeBatch) {
        const batch=this.state.activeBatch
        batch.status='interrupted';batch.finishedAt=now()
        for(const item of batch.items)if(!isAgentUpdateTerminal(item.status)){item.status='interrupted';item.finishedAt=now()}
        this.state.lastCompletedBatch=batch;this.state.activeBatch=undefined
        await this.persist()
      }
    })()
  }
  async getState() {await this.initialize();return this.copy()}
  start(ids:string[],requestId:string):Promise<AgentUpdateSnapshot> {
    const pending=this.starts.then(async()=>{
      await this.initialize()
      if(this.state.activeBatch || this.state.lastCompletedBatch?.requestId===requestId)return this.copy()
      if(!ids.length || ids.some(id=>!id.match(/^[\w.-]+$/)) || !requestId)throw new Error('Invalid update request')
      for(const item of this.state.lastCompletedBatch?.items || []) {
        if(item.process && await (this.deps.processAlive || updateProcessAlive)(item.process))throw new Error('A previous installer is still running; retry after it exits')
      }
      const targets=await this.deps.targets()
      const batch:AgentUpdateBatch={id:randomUUID(),requestId,createdAt:now(),status:'queued',cancelRequested:false,items:ids.map(id=>{
        const agent=targets.find(a=>a.id===id)
        return {id:randomUUID(),agentId:id,name:agent?.name || id,target:agent?.nativeUpdate?.target,source:agent?.source,installationId:agent?.installationId,targetKey:agent?updateTargetKey(agent):undefined,status:'queued'}
      })}
      this.state.activeBatch=batch
      try {await this.persist()} catch(error){this.state.activeBatch=undefined;throw error}
      // Yield the accepted snapshot before background discovery or an updater starts.
      const accepted=this.copy()
      this.execution=new Promise<void>(resolve=>setTimeout(resolve,0)).then(()=>this.run(batch))
      void this.execution.catch(()=>{})
      return accepted
    })
    this.starts=pending.catch(()=>{})
    return pending
  }
  async cancel() {
    await this.initialize()
    const batch=this.state.activeBatch
    if(!batch)return
    batch.cancelRequested=true;batch.status='cancelling'
    this.cancelWait?.abort()
    await this.persist()
  }
  async waitForIdle() {await this.starts;await this.execution}
  private async run(batch:AgentUpdateBatch) {
    let release:(()=>void)|undefined
    try {
      batch.status=batch.cancelRequested?'cancelling':'waiting';await this.persist()
      this.cancelWait=new AbortController()
      if(batch.cancelRequested)this.cancelWait.abort()
      if(batch.cancelRequested)return
      release=await waitForAgentUpdate(this.cancelWait.signal)
      this.cancelWait=undefined
      if(batch.cancelRequested)return
      batch.status='preparing';await this.persist()
      let targets=await this.deps.prepare(batch.items.map(i=>i.agentId))
      const seen=new Set<string>()
      for(const item of batch.items) {
        if(batch.cancelRequested)break
        item.startedAt=now();item.status='preparing';batch.status='running';await this.persist()
        try {
          const agent=targets.find(a=>a.id===item.agentId)
          if(!agent || item.targetKey && item.targetKey!==updateTargetKey(agent))throw new Error('Installation or launch configuration changed; refresh and retry')
          item.installationId=agent.installationId;item.targetKey=updateTargetKey(agent)
          const key=updaterKey(agent)
          if(seen.has(key)){item.status='skipped';continue}
          seen.add(key)
          item.before=agent.nativeUpdate?.version || agent.version
          if(!agent.nativeUpdate && (!agent.manager || !agent.package || !agent.latest))throw new Error(agent.updateError || 'Verified updater unavailable')
          if(!agent.nativeUpdate && (agent.latest===agent.version || isNewerStableVersion(agent.version!,agent.latest!))){item.status='up_to_date';item.after=item.before;continue}
          item.status='installing';await this.persist()
          await this.deps.execute(agent,async info=>{item.process=info;await this.persist()})
          item.status='verifying';await this.persist()
          const after=await this.deps.verify(agent)
          item.after=agent.nativeUpdate?after?.nativeUpdate?.version:after?.version
          if(!after?.runnable || !item.after || item.before && isNewerStableVersion(item.before,item.after) || !agent.nativeUpdate && item.after!==agent.latest)throw new Error('Updated installation failed version/runtime verification')
          item.status=item.before===item.after?'up_to_date':'updated'
          item.process=undefined
        } catch(error) {
          item.status='failed';item.error=safeError(error)
          if(item.process && await (this.deps.processAlive || updateProcessAlive)(item.process))throw new Error('Installer process is still running; remaining updates stopped')
        }
        finally {item.finishedAt=now();await this.persist()}
        targets=await this.deps.targets()
      }
    } catch(error) {
      if(!batch.cancelRequested){batch.error=safeError(error);for(const item of batch.items)if(!isAgentUpdateTerminal(item.status)){item.status='failed';item.error=batch.error;item.finishedAt=now()}}
    } finally {
      this.cancelWait=undefined
      for(const item of batch.items)if(!isAgentUpdateTerminal(item.status)){item.status='cancelled';item.finishedAt=now()}
      batch.status='completed';batch.finishedAt=now()
      this.state.lastCompletedBatch=batch;this.state.activeBatch=undefined
      try {await this.persist()} catch(error) {batch.error=safeError(error);this.state.revision++;this.emit()}
      release?.()
    }
  }
}
