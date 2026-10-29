import { parseAgyModels, parseCursorModels, parseKimiModels } from './models'
import { kimiAcpArgsFromHelp, nativeUpdateCommandFromHelp } from './capabilities'
import { agentLaunchChanged, applyAgentConfiguration } from '../../../shared/agents'
import { defaultLauncherFor, globalLauncherTimeout } from '../../../shared/defaults'
import { isNewerStableVersion as newer } from '../../../shared/agents'
import { agentUpdateJobsSchema } from '../schemas'
import { acquireAgentUpdate } from './locks'
import { execFile } from 'node:child_process'
import { access, readFile, realpath, mkdir, writeFile, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AGENT_RECIPES, type LocalAgent, type AgentConfiguration, type AgentUpdateJob } from '../../../shared/agents'
import { splitCommand } from '../launchers'
import { AcpClient, AcpStdioTransport, defaultAcpArgs, prepareAcpEnvironment } from '../acp'
import { commandKindFor } from '../launchers'
import type { BuddyStore } from '../store'
import { redactSensitiveText } from '../redact'

export function runFile(command: string, args: string[], timeout = 3000, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { timeout, maxBuffer: 1024 * 1024, env: {...process.env, ...env, PATH: dirname(command)+':'+(env?.PATH ?? process.env.PATH ?? '')} }, (err, stdout, stderr) => err ? reject(new Error(redactSensitiveText(stderr || err.message))) : resolve(stdout.trim())))
}
export { newer }

async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return true } catch { return false } }
async function find(name: string, dirs?:string[]): Promise<string | undefined> {
  if(name.includes('/')) return await executable(name) ? name : undefined
  for(const dir of dirs || [...(process.env.PATH || '').split(':'), join(homedir(),'.local/bin'),join(homedir(),'.bun/bin'),join(homedir(),'.wecode-cli/bin'),'/opt/homebrew/bin','/usr/local/bin']) {
    const path=join(dir,name); if(await executable(path)) return path
  }
}
export function installationIdentity(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0,20)
}
export class AgentManagementService {
  private inventory: LocalAgent[] = []
  private scannedAt=0
  private readonly dirtyAgents = new Set<string>()
  private configurationRevision = 0
  private readonly configurationOverrides = new Map<string, { revision: number; config: AgentConfiguration }>()
  private scanPending?: Promise<LocalAgent[]>
  private jobs: AgentUpdateJob[] = []
  private updating = false
  private cancelled = false
  private configQueue:Promise<unknown>=Promise.resolve()
  constructor(private store: BuddyStore, private options:{recipes?:typeof AGENT_RECIPES;dirs?:string[];appRoots?:string[];run?:typeof runFile}={}) {}
  private run(command:string,args:string[],timeout?:number,env?:Record<string,string>){return (this.options.run || runFile)(command,args,timeout,env)}
  private async persistJobs(): Promise<void> {
    const path=join(this.store.dataRoot,'global','agent-update-jobs.json')
    await mkdir(dirname(path),{recursive:true}); await writeFile(path+'.tmp',JSON.stringify(this.jobs)); await rename(path+'.tmp',path)
  }
  async list(force=false): Promise<LocalAgent[]> {
    if (this.scanPending) {
      await this.scanPending
      return force || this.dirtyAgents.size ? this.list(force) : this.inventory
    }
    const targets = !force && this.inventory.length && this.dirtyAgents.size ? new Set(this.dirtyAgents) : undefined
    if (!force && !targets && this.inventory.length && Date.now()-this.scannedAt<60000) return this.inventory
    if (targets) for (const id of targets) this.dirtyAgents.delete(id)
    else this.dirtyAgents.clear()
    this.scanPending = this.scan(targets).catch(error => {
      if (targets) for (const id of targets) this.dirtyAgents.add(id)
      throw error
    }).finally(() => { this.scanPending=undefined })
    return this.scanPending
  }
  private async scan(targets?: ReadonlySet<string>): Promise<LocalAgent[]> {
    const startingRevision = this.configurationRevision
    const settings=await this.store.readGlobalSettings()
    const timeout = globalLauncherTimeout(settings)
    const configurations=settings.agent_management || {}
    const recipes=[...(this.options.recipes || AGENT_RECIPES)]
    for(const id of Object.keys(settings.launchers || {})) if(!recipes.some(r=>r.id===id)) recipes.push({id,name:id,command:settings.launchers![id].command})
    const out: LocalAgent[]=[]
    // Bounded batches: a slow version process cannot serialize the entire scan.
    const selectedRecipes = targets ? recipes.filter(recipe=>targets.has(recipe.id)) : recipes
    for(let offset=0;offset<selectedRecipes.length;offset+=4) await Promise.all(selectedRecipes.slice(offset,offset+4).map(async recipe=>{
      const config=configurations[recipe.id]
      const saved=config?.cli || (settings.launchers?.[recipe.id]?.protocol!=='acp'?settings.launchers?.[recipe.id]:undefined)
      // Desktop applications without an execution entry are not Buddy actors.
      if (!recipe.command && !saved?.command && !config?.acp?.command) return
      const tokens=splitCommand(saved?.command || recipe.command)
      let path=tokens[0]?await find(tokens[0],this.options.dirs):undefined
      if(!path && !saved) for(const alias of recipe.aliases || []) {path=await find(alias,this.options.dirs); if(path) break}
      let appVersion: string|undefined
      if(recipe.app) for(const root of this.options.appRoots || ['/Applications',join(homedir(),'Applications')]) {
        try { appVersion=await this.run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(root,recipe.app+'.app/Contents/Info.plist')]); break } catch { /* no app */ }
      }
      if(!path && !appVersion && !config && (!saved || saved.command===recipe.command) && settings.launchers?.[recipe.id]?.protocol!=='acp') return
      const real=path?await realpath(path).catch(()=>path!):''
      const installations:NonNullable<LocalAgent['installations']>=[]
      const knownPaths=new Set<string>()
      for(const dir of this.options.dirs || (process.env.PATH || '').split(':')) {
        const candidate=join(dir,splitCommand(recipe.command)[0] || '__absent__')
        if(!await executable(candidate))continue
        const target=await realpath(candidate).catch(()=>candidate)
        if(knownPaths.has(target))continue
        knownPaths.add(target)
        let detectedVersion:string|undefined
        try {detectedVersion=(await this.run(candidate,[...splitCommand(recipe.command).slice(1),'--version'])).match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0]} catch { /* retain installation evidence */ }
        installations.push({id:installationIdentity(candidate),path:candidate,realPath:target,version:detectedVersion})
      }
      const brew=/^(.*)\/(?:Cellar|Caskroom)\/([^/]+)\//.exec(real)
      const node=recipe.npm?real.indexOf('/lib/node_modules/'+recipe.npm): -1
      const prefix=node>=0?real.slice(0,node):undefined
      let source:LocalAgent['source']=brew?'brew':prefix?'npm':real.includes('/.bun/')?'bun':real.includes('/pnpm/')?'pnpm':'unknown'
      let manager=brew?join(brew[1],'bin/brew'):prefix?join(prefix,'bin/npm'):undefined
      if(source==='unknown' && /\/.local\/share\/uv\/tools\//.test(real)) {source='uv';manager=await find('uv',this.options.dirs)}
      if(source==='unknown' && /\/pipx\/venvs\//.test(real)) {source='pipx';manager=await find('pipx',this.options.dirs)}
      if(source==='unknown' && recipe.id==='claude' && real.includes('/.local/share/claude/versions/')) {source='self';manager=path}
      if(source==='bun')manager=await find('bun',this.options.dirs)
      if(source==='pnpm')manager=await find('pnpm',this.options.dirs)
      if(manager && ['pnpm','bun'].includes(source)) {
        try {const bin=await this.run(manager,source==='pnpm'?['bin','-g']:['pm','bin','-g']);if(await realpath(dirname(path!))!==await realpath(bin))manager=undefined} catch {manager=undefined}
      }
      let version: string|undefined, error: string|undefined
      const cliArgs = [...tokens.slice(1), ...(saved?.args || [])]
      if(path) try { const raw=await this.run(path,[...cliArgs,'--version'],3000,saved?.env); version=raw.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || raw.slice(0,100) } catch(e) { error=String(e) }
      const nativeKind=commandKindFor(recipe.id,[path || tokens[0] || recipe.command,...cliArgs])
      const native=nativeKind!=='contract'
      const cli=path?{ ...saved, command:path, args:cliArgs, env:saved?.env || {},timeout_seconds:timeout,protocol:'cli' as const }:undefined
      let nativeUpdate: LocalAgent['nativeUpdate']
      if (cli && native && source === 'unknown') {
        try {
          const wecode = basename(cli.command) === 'wecode'
          const prefix = wecode && ['codex', 'opencode'].includes(cli.args[0]) ? [cli.args[0]] : []
          // WeCode forwards --help to the inner CLI; only its help subcommand describes the wrapper.
          const help = await this.run(cli.command, [...prefix, wecode ? 'help' : '--help'], 5000, cli.env)
          const update = nativeUpdateCommandFromHelp(help)
          if (update) {
            const versionArgs = wecode && !prefix.length ? ['version'] : [...prefix, '--version']
            const rawVersion = await this.run(cli.command, versionArgs, 3000, cli.env)
            const updateVersion = rawVersion.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || rawVersion.trim().slice(0, 100)
            if (updateVersion) nativeUpdate = { command: cli.command, args: [...prefix, update], versionArgs, version: updateVersion, target: wecode && !prefix.length ? 'wecode' : 'agent' }
          }
        } catch { /* Help failure does not make a runnable CLI unavailable. */ }
      }
      const adapter=recipe.adapter?await find(recipe.adapter,this.options.dirs):undefined
      let automaticAcp=adapter?{command:adapter,args:[],env:{},timeout_seconds:timeout,protocol:'acp' as const}:path && recipe.acp?{command:path,args:recipe.acp,env:{},timeout_seconds:timeout,protocol:'acp' as const}:undefined
      if (cli && nativeKind==='native_kimi' && !automaticAcp) {
        try {
          const help=await this.run(cli.command,[...cli.args,'--help'],3000,cli.env)
          const args=kimiAcpArgsFromHelp(help)
          if (args) automaticAcp={command:cli.command,args:[...cli.args,...args],env:cli.env,timeout_seconds:cli.timeout_seconds,protocol:'acp'}
        } catch { /* No advertised ACP entry: retain CLI and user-configured ACP. */ }
      }
      const acpCandidate=config?.acp || (settings.launchers?.[recipe.id]?.protocol==='acp'?settings.launchers[recipe.id]:undefined) || automaticAcp
      const acp=acpCandidate?{...acpCandidate,args:acpCandidate.args?.length?acpCandidate.args:defaultAcpArgs(acpCandidate.command,recipe.id),timeout_seconds:timeout}:undefined
      const defaultPath=recipe.command?await find(splitCommand(recipe.command)[0],this.options.dirs):undefined
      const automaticCli=defaultPath?{command:defaultPath,args:splitCommand(recipe.command).slice(1),env:{},timeout_seconds:timeout,protocol:'cli' as const}:undefined
      if (!cli && !acp) return
      out.push({nativeUpdate,automaticCli,automaticAcp,installations,id:recipe.id,installationId:installationIdentity(path || recipe.id),name:recipe.name,path:path || '',realPath:real,version,appVersion,source,prefix,manager,package:source==='uv'||source==='pipx'?(recipe.id==='kimi'?'kimi-cli':undefined):brew?.[2] || recipe.npm,selectedProtocol:config?.protocol || settings.launchers?.[recipe.id]?.protocol || 'cli',runnable:!!cli&&!error&&(native||!!config?.contract),enabled:config?.enabled!==false,error,cli,acp,acpStatus:acp?'unverified':'missing',modelFlag:recipe.modelFlag})
    }))
    for(let offset=0;offset<out.length;offset+=4) await Promise.all(out.slice(offset,offset+4).filter(a=>a.acp&&!/\bnpx\b/.test(a.acp.command)).map(a=>this.probeTarget(a).catch(error=>{a.acpStatus='failed';a.acpError=redactSensitiveText(String(error));return a})))
    if (!targets) this.scannedAt=Date.now()
    const discovered = targets ? [...this.inventory.filter(a=>!targets.has(a.id)), ...out] : out
    // A background scan may have started before a configuration save finished.
    this.inventory = discovered.map(agent => {
      const override = this.configurationOverrides.get(agent.id)
      return override && override.revision > startingRevision ? applyAgentConfiguration(agent, override.config) : agent
    }).sort((a,b)=>a.name.localeCompare(b.name))
    const path=join(this.store.dataRoot,'global','agent-inventory-cache.json')
    await mkdir(dirname(path),{recursive:true})
    const metadata=this.inventory.map(({cli,acp,automaticCli,automaticAcp,...metadata})=>metadata)
    await writeFile(path+'.tmp',JSON.stringify({schemaVersion:1,scannedAt:new Date().toISOString(),agents:metadata}),{mode:0o600})
    await rename(path+'.tmp',path)
    return this.inventory
  }
  configure(id:string,config:AgentConfiguration):Promise<void> {
    const pending=this.configQueue.then(()=>this.configureInner(id,config))
    this.configQueue=pending.catch(()=>{})
    return pending
  }
  private async configureInner(id:string, config:AgentConfiguration): Promise<void> {
    if(!/^[\w.-]+$/.test(id)) throw new Error('Invalid agent ID')
    const settings=await this.store.readGlobalSettings()
    const current=settings.agent_management?.[id] || {}
    const next={...current,...config}
    const timeout = globalLauncherTimeout(settings)
    for (const protocol of ['cli', 'acp'] as const) {
      if (next[protocol]) next[protocol] = { ...next[protocol], timeout_seconds: timeout }
    }
    const agent=this.inventory.find(a=>a.id===id)
    const protocol=next.protocol || settings.launchers?.[id]?.protocol || 'cli'
    const existing = settings.launchers?.[id]
    const launcher=next[protocol] || agent?.[protocol] || ((existing?.protocol || 'cli') === protocol ? existing : undefined) || (protocol === 'cli' ? defaultLauncherFor(id) : undefined)
    if (!launcher) throw new Error('No configured ACP entry for '+id)
    await this.store.updateGlobalSettings({...settings,agent_management:{...settings.agent_management,[id]:next},launchers:{...settings.launchers,[id]:{...launcher,protocol,timeout_seconds:timeout}}})
    this.configurationOverrides.set(id, { revision: ++this.configurationRevision, config: next })
    if (!agent || agentLaunchChanged(agent, config)) this.dirtyAgents.add(id)
    this.inventory = this.inventory.map(a => a.id === id ? applyAgentConfiguration(a, next) : a)
  }
  async probe(id:string): Promise<LocalAgent> {
    const a=(await this.list()).find(a=>a.id===id); if(!a?.acp) throw new Error('ACP entry unavailable')
    return this.probeTarget(a)
  }
  private async probeTarget(a:LocalAgent):Promise<LocalAgent> {
    if(!a.acp) return a
    const id=a.id
    if(/\bnpx\b/.test(a.acp.command)) throw new Error('Install a local ACP adapter before scanning')
    const tokens=splitCommand(a.acp.command)
    const transport=new AcpStdioTransport({command:tokens[0],args:[...tokens.slice(1),...(a.acp.args || [])],cwd:homedir(),env:await prepareAcpEnvironment(id,a.acp.env,this.store.dataRoot)})
    const client=new AcpClient(transport,{timeoutMs:10000})
    try { transport.start(); const result=await client.initialize({clientCapabilities:{},capabilities:{}}); a.acpStatus=Number(result.protocolVersion)===1?'verified':'incompatible' }
    catch(e) { a.acpStatus='failed';a.acpError=redactSensitiveText(String(e)) }
    finally {await client.close().catch(()=>{});await transport.close().catch(()=>{})}
    return a
  }
  async models(id:string):Promise<import('../../../shared/types').AcpModelList> {
    const a=this.inventory.find(a=>a.id===id) ?? (await this.list()).find(a=>a.id===id)
    if(!a?.cli) return {models:[]}
    const tokens=splitCommand(a.cli.command)
    const args=[...tokens.slice(1),...(a.cli.args || [])]
    const kind=commandKindFor(id,[tokens[0],...args])
    if(kind==='native_cursor') {
      const raw=await this.run(tokens[0],[...args,'models'],30000,a.cli.env)
      return {models:parseCursorModels(raw),currentModelId:a.cli.model}
    }
    if(kind==='native_kimi') {
      const raw=await this.run(tokens[0],[...args,'provider','list','--json'],10000,a.cli.env)
      return {models:parseKimiModels(raw),currentModelId:a.cli.model}
    }
    if(kind==='native_agy') {
      const raw=await this.run(tokens[0],[...args,'models'],30000,a.cli.env)
      return {models:parseAgyModels(raw),currentModelId:a.cli.model}
    }
    if(kind==='native_opencode') {
      const raw=await this.run(tokens[0],[...args,'models'],15000,a.cli.env)
      return {models:raw.split('\n').map(id=>id.trim()).filter(id=>/^[^\s]+\/[^\s]+$/.test(id)).map(id=>({id,name:id}))}
    }
    if(kind==='native_codebuddy') {
      const help=await this.run(tokens[0],[...args,'--help'],3000,a.cli.env)
      const values=/Currently supported: \(([^)]+)\)/.exec(help)?.[1]
      return {models:values?values.split(',').map(id=>({id:id.trim(),name:id.trim()})):[]}
    }
    return {models:[]}
  }
  async checkUpdates(force=false): Promise<LocalAgent[]> {
    const agents=await this.list()
    for(let offset=0;offset<agents.length;offset+=4) await Promise.all(agents.slice(offset,offset+4).map(async a=>{
      if(!force && a.checkedAt && Date.now()-Date.parse(a.checkedAt)<6*3600000 && !a.updateError)return
      a.checkedAt=new Date().toISOString(); a.updateError=undefined;a.latest=undefined
      try {
        if(a.source==='brew'&&a.manager&&a.package) {const info=JSON.parse(await this.run(a.manager,['info','--json=v2',a.package],30000));a.latest=info.formulae?.[0]?.versions?.stable || info.casks?.[0]?.version}
        else if(['npm','pnpm','bun','self'].includes(a.source)&&a.package) {
          const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(a.package)+'/latest',{signal:AbortSignal.timeout(15000)})
          if(!response.ok)throw new Error('Version registry returned '+response.status)
          const info=await response.json() as {version?:string};a.latest=info.version
        }
        else if(['uv','pipx'].includes(a.source)&&a.package) {
          const response=await fetch('https://pypi.org/pypi/'+encodeURIComponent(a.package)+'/json',{signal:AbortSignal.timeout(15000)})
          if(!response.ok)throw new Error('Version registry returned '+response.status)
          a.latest=((await response.json()) as {info:{version:string}}).info.version
        }
        else if (!a.nativeUpdate) a.updateError='Installation source does not expose a verified updater'
      } catch(e) {a.updateError=String(e)}
    }))
    return this.inventory
  }
  async getJobs():Promise<AgentUpdateJob[]> {
    if(!this.jobs.length) try {this.jobs=agentUpdateJobsSchema.parse(JSON.parse(await readFile(join(this.store.dataRoot,'global','agent-update-jobs.json'),'utf8'))); for(const j of this.jobs) if(['queued','updating','verifying'].includes(j.status))j.status='interrupted'} catch { /* first run */ }
    return this.jobs
  }
  cancel():void { this.cancelled=true }
  async update(ids:string[]):Promise<AgentUpdateJob[]> {
    if(this.updating) throw new Error('An update queue is already running')
    this.updating=true; this.cancelled=false
    const agents=await this.list();const seen=new Set<string>()
    this.jobs=ids.map(id=>({id:randomUUID(),agentId:id,status:'queued'}))
    try {
      for(const job of this.jobs) {
        const a=agents.find(a=>a.id===job.agentId)
        let release:(()=>void)|undefined
        try {
          if(this.cancelled) {job.status='cancelled';continue}
          if(!a || (!a.nativeUpdate && (!a.manager || !a.package || !a.latest || !a.version || !newer(a.latest,a.version)))) {job.status='skipped';job.error=!a?.manager?'Verified updater unavailable':undefined;continue}
          const key=a.nativeUpdate?JSON.stringify([await realpath(a.nativeUpdate.command),a.nativeUpdate.args]):a.source+':'+a.prefix+':'+a.package
          if(seen.has(key)) {job.status='skipped';continue} seen.add(key)
          release=acquireAgentUpdate()
          if(!release) {job.status='skipped';job.error='Agent tasks are running';continue}
          const tasks=await this.store.getTasks()
          if(tasks.some(t=>t.active_run)) {job.status='skipped';job.error='Agent tasks are running';continue}
          job.before=a.nativeUpdate?.version || a.version;job.status='updating';await this.persistJobs()
          const args=a.nativeUpdate?.args || (a.source==='brew'?['upgrade',...(a.realPath.includes('/Caskroom/')?['--cask']:[]),a.package!]
            :a.source==='self'?['update']
            :a.source==='uv'?['tool','upgrade',a.package!]
            :a.source==='pipx'?['upgrade',a.package!]
            :a.source==='pnpm'?['add','-g',a.package+'@'+a.latest]
            :a.source==='bun'?['add','-g',a.package+'@'+a.latest]
            :['install','-g','--prefix',a.prefix!,a.package+'@'+a.latest])
          await this.run(a.nativeUpdate?.command || a.manager!,args,600000,a.nativeUpdate?a.cli?.env:undefined)
          job.status='verifying';await this.persistJobs()
          const refreshed=(await this.list(true)).find(x=>x.id===a.id)
          job.after=a.nativeUpdate?refreshed?.nativeUpdate?.version:refreshed?.version
          if(!refreshed?.runnable || !job.after || (a.nativeUpdate ? !!job.before && newer(job.before,job.after) : refreshed.version!==a.latest)) throw new Error('Updated installation failed version/runtime verification')
          job.status='success'
        }catch(e){job.status='failed';job.error=redactSensitiveText(String(e))}
        finally{release?.();await this.persistJobs()}
      }
    }finally{this.updating=false}
    return this.jobs
  }
}
