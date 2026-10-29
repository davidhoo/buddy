import { parseAgyModels, parseCursorModels, parseKimiModels } from './models'
import { kimiAcpArgsFromHelp, nativeUpdateCommandFromHelp } from './capabilities'
import { agentLaunchChanged, applyAgentConfiguration } from '../../../shared/agents'
import { defaultLauncherFor, globalLauncherTimeout } from '../../../shared/defaults'
import { isNewerStableVersion as newer } from '../../../shared/agents'
import { agentInventoryCacheSchema } from '../schemas'
import { AgentUpdateQueue, runUpdateCommand } from './updates'
import { atomicWriteJson } from '../store'
import { execFile } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { AGENT_RECIPES, type LocalAgent, type AgentConfiguration, type AgentUpdateJob, type AgentInventorySnapshot } from '../../../shared/agents'
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
  readonly updates: AgentUpdateQueue
  private cacheLoaded?: Promise<void>
  private cacheWrites: Promise<void> = Promise.resolve()
  private inventoryRevision = 0
  private refreshError?: string
  private checking?: Promise<LocalAgent[]>
  private inventoryListeners = new Set<(snapshot: AgentInventorySnapshot) => void>()
  private configQueue:Promise<unknown>=Promise.resolve()
  constructor(private store: BuddyStore, private options:{recipes?:typeof AGENT_RECIPES;dirs?:string[];appRoots?:string[];run?:typeof runFile}={}) {
    this.updates = new AgentUpdateQueue({
      dataRoot: store.dataRoot,
      targets: async () => (await this.getInventory()).agents,
      prepare: async ids => { await this.refresh(new Set(ids)); return this.checkUpdates(false,new Set(ids)) },
      execute: (agent, onProcess) => this.executeUpdate(agent, onProcess),
      verify: async agent => {
        const related = new Set(this.inventory.filter(a => a.path === agent.path).map(a => a.id))
        related.add(agent.id)
        await this.refresh(related)
        for(const a of this.inventory)if(related.has(a.id)){a.checkedAt=undefined;a.updateError=undefined}
        await this.persistInventory();this.publish()
        return this.inventory.find(a => a.id === agent.id)
      }
    })
  }
  private run(command:string,args:string[],timeout?:number,env?:Record<string,string>){return (this.options.run || runFile)(command,args,timeout,env)}
  subscribe(listener: (snapshot: AgentInventorySnapshot) => void) { this.inventoryListeners.add(listener); return () => {this.inventoryListeners.delete(listener)} }
  private snapshot(): AgentInventorySnapshot {
    return {revision:this.inventoryRevision,agents:this.inventory,scannedAt:this.scannedAt?new Date(this.scannedAt).toISOString():undefined,refreshing:!!this.scanPending || !!this.checking,error:this.refreshError}
  }
  private publish() { this.inventoryRevision++; for(const listener of this.inventoryListeners)try{listener(this.snapshot())}catch{} }
  private async configurationHash() {
    const settings = await this.store.readGlobalSettings()
    return createHash('sha256').update(JSON.stringify([settings.launchers,settings.agent_management])).digest('hex')
  }
  private loadCache() {
    return this.cacheLoaded ??= (async () => {
      try {
        const cached = agentInventoryCacheSchema.parse(JSON.parse(await readFile(join(this.store.dataRoot,'global','agent-inventory-cache.json'),'utf8')))
        const settings = await this.store.readGlobalSettings()
        const matches = cached.configurationHash === await this.configurationHash()
        this.inventory = await Promise.all(cached.agents.map(async metadata => {
          const recipe = (this.options.recipes || AGENT_RECIPES).find(r=>r.id===metadata.id)
          const config = settings.agent_management?.[metadata.id]
          const selected = config?.protocol || settings.launchers?.[metadata.id]?.protocol || 'cli'
          const saved = settings.launchers?.[metadata.id]
          const fallback = {args:[] as string[],env:{},timeout_seconds:globalLauncherTimeout(settings)}
          const automaticCli = metadata.path ? {...fallback,command:metadata.path,args:splitCommand(recipe?.command || '').slice(1),protocol:'cli' as const} : undefined
          const adapter = recipe?.adapter ? await find(recipe.adapter,this.options.dirs) : undefined
          const savedCli=config?.cli || (saved?.protocol!=='acp'?saved:undefined)
          const cli=savedCli?{...savedCli,command:matches&&metadata.path?metadata.path:splitCommand(savedCli.command)[0],args:[...splitCommand(savedCli.command).slice(1),...(savedCli.args || [])],timeout_seconds:globalLauncherTimeout(settings)}:automaticCli
          const automaticAcp = adapter ? {...fallback,command:adapter,protocol:'acp' as const} : metadata.nativeAcpArgs && metadata.path ? {...fallback,command:metadata.path,args:[...(metadata.id==='kimi'?cli?.args || []:[]),...metadata.nativeAcpArgs],env:metadata.id==='kimi'?cli?.env || {}:{},protocol:'acp' as const} : undefined
          const acpCandidate = config?.acp || (saved?.protocol==='acp'?saved:automaticAcp)
          const acp=acpCandidate?{...acpCandidate,args:acpCandidate.args?.length?acpCandidate.args:defaultAcpArgs(acpCandidate.command,metadata.id),timeout_seconds:globalLauncherTimeout(settings)}:undefined
          const {nativeAcpArgs: _args, ...rest} = metadata
          return {...rest,cli,acp,automaticCli,automaticAcp,enabled:config?.enabled!==false,selectedProtocol:selected,acpStatus:matches?rest.acpStatus:acp?'unverified' as const:'missing' as const}
        }))
        this.scannedAt = matches && cached.scannedAt ? Date.parse(cached.scannedAt) || 0 : 0
      } catch { /* A missing, legacy or invalid cache triggers discovery at startup, never an empty overwrite. */ }
    })()
  }
  async getInventory(): Promise<AgentInventorySnapshot> {await this.loadCache();return this.snapshot()}
  async initialize() {
    await this.loadCache()
    await this.updates.getState()
  }
  hasDirtyTargets() {return !!this.inventory.length && !!this.dirtyAgents.size}
  needsStartupRefresh() {return !this.scannedAt || Date.now()-this.scannedAt>10*60*1000}
  async list(force=false): Promise<LocalAgent[]> {
    await this.loadCache()
    if(this.scanPending)await this.scanPending
    if(force || !this.inventory.length || this.dirtyAgents.size) return this.refresh(force || !this.inventory.length ? undefined : new Set(this.dirtyAgents))
    return this.inventory
  }
  async refresh(targets?: ReadonlySet<string>): Promise<LocalAgent[]> {
    await this.loadCache()
    if(this.scanPending)return this.scanPending
    this.refreshError=undefined
    if(targets)for(const id of targets)this.dirtyAgents.delete(id)
    else this.dirtyAgents.clear()
    this.scanPending=this.scan(targets).catch(error=>{
      this.refreshError=redactSensitiveText(String(error));if(targets)for(const id of targets)this.dirtyAgents.add(id)
      throw error
    }).finally(()=>{this.scanPending=undefined;this.publish()})
    this.publish()
    return this.scanPending
  }
  private async persistInventory() {
    const configurationHash=this.dirtyAgents.size?'':await this.configurationHash()
    const agents=this.inventory.map(({cli,acp,automaticCli,automaticAcp,...metadata})=>({
      ...metadata,
      nativeAcpArgs:automaticAcp?.command===metadata.path && automaticAcp.args?.every(arg=>['acp','--acp','--experimental-acp','opencode'].includes(arg)) ? automaticAcp.args : metadata.id==='kimi' && ['acp','--acp'].includes(automaticAcp?.args?.at(-1) || '') ? automaticAcp?.args?.slice(-1) : undefined
    }))
    const data={schemaVersion:2,scannedAt:this.scannedAt?new Date(this.scannedAt).toISOString():undefined,configurationHash,agents}
    const pending=this.cacheWrites.catch(()=>{}).then(()=>atomicWriteJson(join(this.store.dataRoot,'global','agent-inventory-cache.json'),data))
    this.cacheWrites=pending
    await pending
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
    const previousInventory = this.inventory
    const discovered = targets ? [...this.inventory.filter(a=>!targets.has(a.id)), ...out] : out
    // A background scan may have started before a configuration save finished.
    this.inventory = discovered.map(agent => {
      const override = this.configurationOverrides.get(agent.id)
      return override && override.revision > startingRevision ? applyAgentConfiguration(agent, override.config) : agent
    }).sort((a,b)=>a.name.localeCompare(b.name))
    // Preserve update-channel metadata when only runtime discovery changed.
    for (const agent of this.inventory) {
      const cached = previousInventory.find(a=>a.id===agent.id && a.installationId===agent.installationId && a.source===agent.source && a.package===agent.package && a.prefix===agent.prefix)
      if(cached) {agent.latest=cached.latest;agent.checkedAt=cached.checkedAt;agent.updateError=cached.updateError}
    }
    await this.persistInventory()
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
    this.inventory = this.inventory.map(a => a.id === id ? {...applyAgentConfiguration(a, next),...(this.dirtyAgents.has(id)?{acpStatus:next.acp || a.acp?'unverified' as const:'missing' as const}:{})} : a)
    this.publish()
    if (this.inventory.length) await this.persistInventory()
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
  async checkUpdates(force=false,targets?:ReadonlySet<string>): Promise<LocalAgent[]> {
    if(this.checking)return this.checking
    this.checking=this.checkUpdatesInner(force,targets).catch(error=>{this.refreshError=redactSensitiveText(String(error));throw error}).finally(()=>{this.checking=undefined;this.publish()})
    this.publish()
    return this.checking
  }
  private async checkUpdatesInner(force=false,targets?:ReadonlySet<string>): Promise<LocalAgent[]> {
    await this.loadCache()
    const agents=this.inventory.filter(a=>!targets || targets.has(a.id))
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
    this.inventory=this.inventory.map(current=>{
      const checked=agents.find(a=>a.id===current.id && a.installationId===current.installationId && a.source===current.source && a.package===current.package && a.prefix===current.prefix)
      return checked?{...current,latest:checked.latest,checkedAt:checked.checkedAt,updateError:checked.updateError}:current
    })
    await this.persistInventory()
    return this.inventory
  }
  async getJobs():Promise<AgentUpdateJob[]> {
    const state=await this.updates.getState()
    return (state.activeBatch || state.lastCompletedBatch)?.items.map(item=>({
      ...item,status: item.status==='updated'||item.status==='up_to_date'?'success':item.status==='installing'?'updating':item.status==='preparing'?'queued':item.status
    })) || []
  }
  cancel() {return this.updates.cancel()}
  async update(ids:string[]):Promise<AgentUpdateJob[]> {
    await this.updates.start(ids,createHash('sha256').update(String(Date.now())+Math.random()).digest('hex'))
    await this.updates.waitForIdle()
    return this.getJobs()
  }
  private async executeUpdate(a:LocalAgent,onProcess: Parameters<typeof runUpdateCommand>[3]) {
    if(!a.nativeUpdate && (!a.latest || !a.version || !newer(a.latest,a.version)))throw new Error('No newer stable version available')
    const args=a.nativeUpdate?.args || (a.source==='brew'?['upgrade',...(a.realPath.includes('/Caskroom/')?['--cask']:[]),a.package!]
      :a.source==='self'?['update']
      :a.source==='uv'?['tool','upgrade',a.package!]
      :a.source==='pipx'?['upgrade',a.package!]
      :a.source==='pnpm'?['add','-g',a.package+'@'+a.latest]
      :a.source==='bun'?['add','-g',a.package+'@'+a.latest]
      :['install','-g','--prefix',a.prefix!,a.package+'@'+a.latest])
    const command=a.nativeUpdate?.command || a.manager!
    if(this.options.run) await this.run(command,args,600000,a.nativeUpdate?a.cli?.env:undefined)
    else await runUpdateCommand(command,args,a.nativeUpdate?a.cli?.env:undefined,onProcess)
  }
}
