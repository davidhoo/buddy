import { latestWecodeVersion, wecodeBundle } from './wecode-updates'
import { agentUpdateGroupKey } from '../../../shared/agents'
import { parseAgyModels, parseCursorModels, parseKimiModels } from './models'
import { kimiAcpArgsFromHelp, nativeUpdateCommandFromHelp } from './capabilities'
import {
  agentLaunchChanged,
  applyAgentConfiguration,
  acpLaunchFingerprint,
  defaultSelectedProtocol,
  parseAcpAuthFailure,
  resolveEffectiveAgentLaunch,
  type AcpFailureStage
} from '../../../shared/agents'
import { defaultLauncherFor, globalLauncherTimeout } from '../../../shared/defaults'
import { isNewerStableVersion as newer } from '../../../shared/agents'
import { agentInventoryCacheSchema } from '../schemas'
import { AgentUpdateQueue, runUpdateCommand } from './updates'
import { extraDiscoveryBinDirs, findAppBundledCli, inspectLaunchTarget, isAmbiguousAgentAlias, verifyAmbiguousAliasIdentity, withCompatibleRuntimeEnv } from './discovery'
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
  const childEnv = { ...process.env, ...withCompatibleRuntimeEnv(command, env) }
  return new Promise((resolve, reject) => execFile(command, args, { timeout, maxBuffer: 1024 * 1024, env: childEnv }, (err, stdout, stderr) => err ? reject(new Error(redactSensitiveText(stderr || err.message))) : resolve(stdout.trim())))
}
export { newer }

export function discoveryDirs(dirs?: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of [...(dirs || (process.env.PATH || '').split(':').filter(Boolean)), ...extraDiscoveryBinDirs(homedir(), { dirs })]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return true } catch { return false } }
async function find(name: string, dirs?:string[]): Promise<string | undefined> {
  if(name.includes('/')) return await executable(name) ? name : undefined
  for(const dir of discoveryDirs(dirs)) {
    const path=join(dir,name); if(await executable(path)) return path
  }
}
export function installationIdentity(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0,20)
}

/** Session/auth failures require a full session probe to clear; handshake alone is insufficient. */
function isSessionScopedFailure(agent: Pick<LocalAgent, 'acpStatus' | 'acpFailureStage' | 'acpError'>): boolean {
  if (agent.acpStatus !== 'failed') return false
  if (agent.acpFailureStage === 'session') return true
  if (agent.acpFailureStage === 'spawn' || agent.acpFailureStage === 'handshake') return false
  // Legacy/unknown stage: never clear via handshake — require explicit re-verify.
  return true
}

/** Legacy rows may lack a fingerprint; treat missing as same-target until launch config changes. */
function fingerprintMatches(previous: string | undefined, current: string): boolean {
  if (!previous) return true
  return previous === current
}

/** Failures that a shallow handshake must not wash to verified. */
function mustPreserveFailureAcrossHandshake(agent: Pick<LocalAgent, 'acpStatus' | 'acpFailureStage' | 'acpError'>): boolean {
  return isSessionScopedFailure(agent)
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
  private refreshDiagnostic?: string
  private checking?: Promise<LocalAgent[]>
  private inventoryListeners = new Set<(snapshot: AgentInventorySnapshot) => void>()
  private configQueue:Promise<unknown>=Promise.resolve()
  constructor(private store: BuddyStore, private options:{recipes?:typeof AGENT_RECIPES;dirs?:string[];appRoots?:string[];run?:typeof runFile}={}) {
    this.updates = new AgentUpdateQueue({
      dataRoot: store.dataRoot,
      targets: async () => (await this.getInventory()).agents,
      selectionKeys: ids => this.updateSelectionKeys(ids),
      prepare: async ids => { await this.refresh(new Set(ids)); return this.checkUpdates(false,new Set(ids)) },
      execute: (agent, onProcess) => this.executeUpdate(agent, onProcess),
      verify: async agent => {
        const related = new Set(this.inventory.filter(a => agentUpdateGroupKey(a) === agentUpdateGroupKey(agent)).map(a => a.id))
        related.add(agent.id)
        await this.refresh(related)
        for(const a of this.inventory)if(related.has(a.id)){a.checkedAt=undefined;a.updateError=undefined}
        await this.persistInventory();this.publish()
        return this.inventory.find(a => a.id === agent.id)
      }
    })
  }
  private run(command:string,args:string[],timeout?:number,env?:Record<string,string>){return (this.options.run || runFile)(command,args,timeout,basename(command)==='wecode'?{...env,WECODE_NO_AUTO_UPGRADE:'1'}:env)}
  subscribe(listener: (snapshot: AgentInventorySnapshot) => void) { this.inventoryListeners.add(listener); return () => {this.inventoryListeners.delete(listener)} }
  private snapshot(): AgentInventorySnapshot {
    const error = this.refreshError || this.refreshDiagnostic
    return {revision:this.inventoryRevision,agents:this.inventory,scannedAt:this.scannedAt?new Date(this.scannedAt).toISOString():undefined,refreshing:!!this.scanPending || !!this.checking,error}
  }
  /** Soft diagnostic (e.g. shell PATH refresh failed) — does not clear inventory. */
  noteRefreshDiagnostic(message: string) {
    this.refreshDiagnostic = redactSensitiveText(message)
    this.publish()
  }
  private publish() { this.inventoryRevision++; for(const listener of this.inventoryListeners)try{listener(this.snapshot())}catch{} }
  private async configurationHash() {
    const settings = await this.store.readGlobalSettings()
    return createHash('sha256').update(JSON.stringify([settings.launchers,settings.agent_management])).digest('hex')
  }
  private async updateSelectionKeys(ids: string[]): Promise<Record<string, string>> {
    const settings = await this.store.readGlobalSettings()
    return Object.fromEntries(ids.map(id => {
      const saved = settings.launchers?.[id]
      const cli = settings.agent_management?.[id]?.cli || (saved?.protocol !== 'acp' ? saved : undefined)
      const recipe = (this.options.recipes || AGENT_RECIPES).find(recipe => recipe.id === id)
      const tokens = splitCommand(cli?.command || recipe?.command || '')
      // Exclude model, enabled state and timeout; none changes the installation.
      // Hash arguments/environment so update history never persists credentials.
      const selection = [tokens[0], [...tokens.slice(1), ...(cli?.args || [])], Object.entries(cli?.env || {}).sort(([a], [b]) => a.localeCompare(b))]
      return [id, createHash('sha256').update(JSON.stringify(selection)).digest('hex')]
    }))
  }
  private loadCache() {
    return this.cacheLoaded ??= (async () => {
      try {
        const cached = agentInventoryCacheSchema.parse(JSON.parse(await readFile(join(this.store.dataRoot,'global','agent-inventory-cache.json'),'utf8')))
        const settings = await this.store.readGlobalSettings()
        const matches = cached.configurationHash === await this.configurationHash()
        this.inventory = await Promise.all(cached.agents.map(async metadata => {
          if(metadata.id.startsWith('wecode_') && !metadata.nativeUpdate?.sharedKey)this.dirtyAgents.add(metadata.id)
          const recipe = (this.options.recipes || AGENT_RECIPES).find(r=>r.id===metadata.id)
          const config = settings.agent_management?.[metadata.id]
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
          const selected = config?.protocol || settings.launchers?.[metadata.id]?.protocol || defaultSelectedProtocol({runnable:rest.runnable,acp})
          const acpStatus = matches ? rest.acpStatus : acp ? 'unverified' as const : 'missing' as const
          // Legacy failed rows without a stage need an explicit re-verify path.
          const acpFailureStage = acpStatus === 'failed'
            ? (rest.acpFailureStage || 'unknown' as const)
            : undefined
          return {
            ...rest,
            // Old caches described inner WeCode updaters; require discovery before updating.
            ...(metadata.id.startsWith('wecode_') && !rest.nativeUpdate?.sharedKey ? {nativeUpdate:undefined,latest:undefined,checkedAt:undefined} : {}),
            cli,
            acp,
            automaticCli,
            automaticAcp,
            enabled: config?.enabled !== false,
            selectedProtocol: selected,
            acpStatus,
            acpFailureStage,
            acpLaunchFingerprint: acpStatus === 'failed' ? (rest.acpLaunchFingerprint || acpLaunchFingerprint(acp)) : rest.acpLaunchFingerprint
          }
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
    this.refreshDiagnostic=undefined
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
    const cacheableAcpArg = (arg: string) => ['acp','--acp','--experimental-acp','opencode','--stdio','exec','--output-format'].includes(arg)
    const agents=this.inventory.map(({cli,acp,automaticCli,automaticAcp,...metadata})=>({
      ...metadata,
      nativeAcpArgs:automaticAcp?.command===metadata.path && !!automaticAcp.args?.length && automaticAcp.args.every(cacheableAcpArg)
        ? automaticAcp.args
        : metadata.id==='kimi' && ['acp','--acp'].includes(automaticAcp?.args?.at(-1) || '') ? automaticAcp?.args?.slice(-1) : undefined
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
      let identityError: string|undefined
      if(!path && !saved) for(const alias of recipe.aliases || []) {
        const candidate=await find(alias,this.options.dirs)
        if(!candidate) continue
        if(!isAmbiguousAgentAlias(recipe, alias)) { path=candidate; break }
        const real=await realpath(candidate).catch(()=>candidate)
        const identity=verifyAmbiguousAliasIdentity({recipe, path:candidate, realPath:real})
        if(identity.ok) { path=candidate; break }
        identityError=identity.reason
      }
      let appVersion: string|undefined
      if(recipe.app) for(const root of this.options.appRoots || ['/Applications',join(homedir(),'Applications')]) {
        try { appVersion=await this.run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(root,recipe.app+'.app/Contents/Info.plist')]); break } catch { /* no app */ }
      }
      // Known App-bundle CLI paths are candidates for the same product — not a new Actor.
      if(!path && !saved && recipe.app && recipe.appCli?.length) {
        const bundled=findAppBundledCli({appName:recipe.app, relativePaths:recipe.appCli, appRoots:this.options.appRoots})
        if(bundled) path=bundled
      }
      // Collect adapter before the early return so a standalone adapter is not skipped
      // merely because the primary CLI is missing from PATH.
      const adapterEarly=recipe.adapter?await find(recipe.adapter,this.options.dirs):undefined
      const savedAcp=config?.acp || (settings.launchers?.[recipe.id]?.protocol==='acp'?settings.launchers[recipe.id]:undefined)
      if(!path && !appVersion && !config && !adapterEarly && !savedAcp && (!saved || saved.command===recipe.command)) return
      const real=path?await realpath(path).catch(()=>path!):''
      const installations:NonNullable<LocalAgent['installations']>=[]
      const knownPaths=new Set<string>()
      const commandNames=[...new Set([splitCommand(recipe.command)[0],...(recipe.aliases || [])].filter((name): name is string => !!name && !name.includes('/')))]
      for(const dir of discoveryDirs(this.options.dirs)) {
        for(const name of commandNames) {
          const candidate=join(dir,name)
          if(!await executable(candidate))continue
          const inspected=inspectLaunchTarget(candidate)
          if(inspected.broken) continue
          const target=inspected.realPath || await realpath(candidate).catch(()=>candidate)
          if(isAmbiguousAgentAlias(recipe, name)) {
            const identity=verifyAmbiguousAliasIdentity({recipe, path:candidate, realPath:target})
            if(!identity.ok) { identityError=identityError || identity.reason; continue }
          }
          if(knownPaths.has(target))continue
          knownPaths.add(target)
          let detectedVersion:string|undefined
          try {detectedVersion=(await this.run(candidate,[...splitCommand(recipe.command).slice(1),'--version'])).match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0]} catch { /* retain installation evidence */ }
          installations.push({
            id:installationIdentity(candidate),
            path:candidate,
            realPath:target,
            version:detectedVersion,
            shim: inspected.shim,
            sourceHint: inspected.sourceHint,
            runtime: inspected.runtime ? { kind: inspected.runtime.kind, binDir: inspected.runtime.binDir } : undefined
          })
        }
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
          const help = await this.run(cli.command, wecode ? ['help'] : [...prefix, '--help'], 5000, cli.env)
          const update = nativeUpdateCommandFromHelp(help)
          if (update && (!wecode || help.includes('--cli-only'))) {
            const versionArgs = wecode ? ['version'] : [...prefix, '--version']
            const rawVersion = await this.run(cli.command, versionArgs, 3000, cli.env)
            const updateVersion = rawVersion.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] || rawVersion.trim().slice(0, 100)
            if (updateVersion) nativeUpdate = { command: cli.command, args: wecode ? [update, '--cli-only'] : [...prefix, update], versionArgs, version: updateVersion, target: wecode ? 'wecode' : 'agent', sharedKey: wecode ? (await wecodeBundle(cli.command).catch(()=>real)) + ':' + (cli.env?.WECODE_INSTALL_BRANCH || process.env.WECODE_INSTALL_BRANCH || 'master') : undefined }
          }
        } catch { /* Help failure does not make a runnable CLI unavailable. */ }
      }
      const adapter=adapterEarly
      let automaticAcp=adapter?{command:adapter,args:[],env:{},timeout_seconds:timeout,protocol:'acp' as const}:path && recipe.acp?{command:path,args:recipe.acp,env:{},timeout_seconds:timeout,protocol:'acp' as const}:undefined
      if (recipe.adapter && !adapter && !automaticAcp && !savedAcp) {
        identityError = identityError || `Missing local ACP adapter '${recipe.adapter}'`
      }
      if (cli && nativeKind==='native_kimi' && !automaticAcp) {
        try {
          const help=await this.run(cli.command,[...cli.args,'--help'],3000,cli.env)
          const args=kimiAcpArgsFromHelp(help)
          if (args) automaticAcp={command:cli.command,args:[...cli.args,...args],env:cli.env,timeout_seconds:cli.timeout_seconds,protocol:'acp'}
        } catch { /* No advertised ACP entry: retain CLI and user-configured ACP. */ }
      }
      const acpCandidate=config?.acp || (settings.launchers?.[recipe.id]?.protocol==='acp'?settings.launchers[recipe.id]:undefined) || automaticAcp
      const acp=acpCandidate?{...acpCandidate,args:acpCandidate.args?.length?acpCandidate.args:defaultAcpArgs(acpCandidate.command,recipe.id),timeout_seconds:timeout}:undefined
      // Prefer primary command, then verified aliases; fall back to the already-resolved path so
      // alias-only installs still expose automaticCli (matches cache reload from metadata.path).
      let defaultPath: string | undefined
      if (recipe.command) {
        defaultPath = await find(splitCommand(recipe.command)[0], this.options.dirs)
        if (!defaultPath) for (const alias of recipe.aliases || []) {
          const candidate = await find(alias, this.options.dirs)
          if (!candidate) continue
          if (isAmbiguousAgentAlias(recipe, alias)) {
            const target = await realpath(candidate).catch(() => candidate)
            if (!verifyAmbiguousAliasIdentity({ recipe, path: candidate, realPath: target }).ok) continue
          }
          defaultPath = candidate
          break
        }
      }
      if (!defaultPath && path && !saved) defaultPath = path
      const automaticCli=defaultPath?{command:defaultPath,args:splitCommand(recipe.command).slice(1),env:{},timeout_seconds:timeout,protocol:'cli' as const}:undefined
      if (!cli && !acp) return
      const runnable=!!cli&&!error&&(native||!!config?.contract)
      const explicitProtocol=config?.protocol || settings.launchers?.[recipe.id]?.protocol
      out.push({nativeUpdate,automaticCli,automaticAcp,installations,id:recipe.id,installationId:installationIdentity(path || recipe.id),name:recipe.name,path:path || '',realPath:real,version,appVersion,source,prefix,manager,package:source==='uv'||source==='pipx'?(recipe.id==='kimi'?'kimi-cli':undefined):brew?.[2] || recipe.npm,selectedProtocol:explicitProtocol || defaultSelectedProtocol({runnable,acp}),runnable,enabled:config?.enabled!==false,error:error || (!path && identityError ? identityError : undefined),cli,acp,acpStatus:acp?'unverified':'missing',modelFlag:recipe.modelFlag})
    }))
    // Session/auth and legacy-unknown failures survive a new scan for the same
    // (or missing) launch fingerprint. Transient spawn/handshake failures start clean.
    for (const agent of out) {
      const previous = this.inventory.find(row => row.id === agent.id)
      const fingerprint = acpLaunchFingerprint(agent.acp)
      if (
        previous?.acpStatus === 'failed' &&
        fingerprintMatches(previous.acpLaunchFingerprint, fingerprint) &&
        mustPreserveFailureAcrossHandshake(previous)
      ) {
        agent.acpStatus = 'failed'
        agent.acpError = previous.acpError
        agent.acpFailureStage = previous.acpFailureStage || 'unknown'
        agent.acpLaunchFingerprint = fingerprint || previous.acpLaunchFingerprint
      }
    }
    // Scan only does ACP handshake (initialize). session/new waits for explicit probe/task start.
    for(let offset=0;offset<out.length;offset+=4) await Promise.all(out.slice(offset,offset+4).filter(a=>a.acp&&!/\bnpx\b/.test(a.acp.command)).map(a=>this.probeTarget(a,'handshake').catch(error=>{
      a.acpStatus='failed'
      a.acpError=redactSensitiveText(String(error))
      a.acpFailureStage='spawn'
      a.acpLaunchFingerprint=acpLaunchFingerprint(a.acp)
      return a
    })))
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
      if(cached && cached.nativeUpdate?.target===agent.nativeUpdate?.target && cached.nativeUpdate?.sharedKey===agent.nativeUpdate?.sharedKey) {
        agent.latest=cached.latest;agent.checkedAt=cached.checkedAt;agent.updateError=cached.updateError
        // Handshake must not erase session/auth or legacy-unknown failures.
        const fingerprint = acpLaunchFingerprint(agent.acp)
        if (
          cached.acpStatus === 'failed' &&
          agent.acpStatus === 'verified' &&
          fingerprintMatches(cached.acpLaunchFingerprint, fingerprint) &&
          mustPreserveFailureAcrossHandshake(cached)
        ) {
          agent.acpStatus = 'failed'
          agent.acpError = cached.acpError
          agent.acpFailureStage = cached.acpFailureStage || 'unknown'
          agent.acpLaunchFingerprint = fingerprint || cached.acpLaunchFingerprint
        }
      }
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
    const patched = agent ? applyAgentConfiguration(agent, next) : undefined
    const { protocol, launcher: resolved } = resolveEffectiveAgentLaunch(patched, {
      agentConfig: next,
      savedLauncher: settings.launchers?.[id]
    })
    const candidate = next[protocol] || resolved || (protocol === 'cli' ? defaultLauncherFor(id) : undefined)
    if (!candidate?.command) throw new Error('No configured ACP entry for '+id)
    const launcher = {
      command: candidate.command,
      args: candidate.args || [],
      env: candidate.env || {},
      timeout_seconds: timeout,
      protocol,
      ...(typeof candidate.model === 'string' && candidate.model.trim() ? { model: candidate.model.trim() } : {})
    }
    // Persist the resolved protocol so enable/model saves cannot rewrite ACP → CLI.
    next.protocol = protocol
    await this.store.updateGlobalSettings({...settings,agent_management:{...settings.agent_management,[id]:next},launchers:{...settings.launchers,[id]:launcher}})
    this.configurationOverrides.set(id, { revision: ++this.configurationRevision, config: next })
    if (!agent || agentLaunchChanged(agent, config)) this.dirtyAgents.add(id)
    const launchChanged = !agent || agentLaunchChanged(agent, config)
    this.inventory = this.inventory.map(a => a.id === id ? {
      ...applyAgentConfiguration(a, next),
      selectedProtocol: protocol,
      ...(launchChanged ? {
        acpStatus: (next.acp || a.acp ? 'unverified' : 'missing') as LocalAgent['acpStatus'],
        acpError: undefined,
        acpFailureStage: undefined,
        acpLaunchFingerprint: undefined
      } : {})
    } : a)
    this.publish()
    if (this.inventory.length) await this.persistInventory()
  }
  async probe(id:string): Promise<LocalAgent> {
    const a=(await this.list()).find(a=>a.id===id); if(!a?.acp) throw new Error('ACP entry unavailable')
    const probed = await this.probeTarget(a,'session')
    this.publish()
    await this.persistInventory()
    return probed
  }
  /** Model-list / runtime failures can outrank a stale scan verdict. */
  recordAcpProbe(id:string, result:{ok:true}|{ok:false;error:string}):void {
    const agent=this.inventory.find(a=>a.id===id)
    if(!agent?.acp) return
    const fingerprint = acpLaunchFingerprint(agent.acp)
    if(result.ok) {
      if(agent.acpStatus==='verified' && !agent.acpError) return
      this.inventory=this.inventory.map(a=>a.id===id?{...a,acpStatus:'verified' as const,acpError:undefined,acpFailureStage:undefined,acpLaunchFingerprint:fingerprint}:a)
    } else {
      const acpError=redactSensitiveText(result.error)
      const stage: AcpFailureStage = parseAcpAuthFailure(acpError) ? 'session' : 'handshake'
      if(agent.acpStatus==='failed' && agent.acpError===acpError && agent.acpFailureStage===stage) return
      this.inventory=this.inventory.map(a=>a.id===id?{...a,acpStatus:'failed' as const,acpError,acpFailureStage:stage,acpLaunchFingerprint:fingerprint}:a)
    }
    this.publish()
    void this.persistInventory()
  }
  /**
   * handshake: initialize only (used by inventory scan).
   * session: also session/new — catches auth failures that only surface there.
   * Handshake success clears spawn/handshake/unknown failures for the same launch
   * fingerprint, but never clears a known session/auth failure.
   */
  private async probeTarget(a:LocalAgent, depth:'handshake'|'session'='handshake'):Promise<LocalAgent> {
    if(!a.acp) return a
    const id=a.id
    const fingerprint = acpLaunchFingerprint(a.acp)
    // Stale failure from a different launch config must not block this probe.
    if (a.acpLaunchFingerprint && a.acpLaunchFingerprint !== fingerprint) {
      a.acpStatus = a.acp ? 'unverified' : 'missing'
      a.acpError = undefined
      a.acpFailureStage = undefined
      a.acpLaunchFingerprint = undefined
    }
    if(/\bnpx\b/.test(a.acp.command)) throw new Error('Install a local ACP adapter before scanning')
    const tokens=splitCommand(a.acp.command)
    const cwd=homedir()
    let stage: AcpFailureStage = 'spawn'
    const transport=new AcpStdioTransport({command:tokens[0],args:[...tokens.slice(1),...(a.acp.args || [])],cwd,env:{...await prepareAcpEnvironment(id,a.acp.env,this.store.dataRoot),...(id.startsWith('wecode_')?{WECODE_NO_AUTO_UPGRADE:'1'}:{})}})
    const client=new AcpClient(transport,{timeoutMs:10000})
    try {
      transport.start()
      stage = 'handshake'
      const result=await client.initialize({clientCapabilities:{},capabilities:{}})
      if(Number(result.protocolVersion)!==1) {
        a.acpStatus='incompatible'
        a.acpError=undefined
        a.acpFailureStage=undefined
        a.acpLaunchFingerprint=fingerprint
      } else if (depth === 'session') {
        stage = 'session'
        await client.newSession({cwd,mcpServers:[]})
        a.acpStatus='verified'
        a.acpError=undefined
        a.acpFailureStage=undefined
        a.acpLaunchFingerprint=fingerprint
      } else if (
        mustPreserveFailureAcrossHandshake(a) &&
        fingerprintMatches(a.acpLaunchFingerprint, fingerprint)
      ) {
        // Keep session/auth or legacy-unknown failure; handshake alone is not proof of login.
        a.acpStatus = 'failed'
        a.acpFailureStage = a.acpFailureStage || 'unknown'
        a.acpLaunchFingerprint = fingerprint || a.acpLaunchFingerprint
      } else {
        a.acpStatus='verified'
        a.acpError=undefined
        a.acpFailureStage=undefined
        a.acpLaunchFingerprint=fingerprint
      }
    }
    catch(e) {
      const acpError=redactSensitiveText(String(e))
      if (stage === 'session' || parseAcpAuthFailure(acpError)) stage = 'session'
      a.acpStatus='failed'
      a.acpError=acpError
      a.acpFailureStage=stage
      a.acpLaunchFingerprint=fingerprint
    }
    finally {await client.close().catch(()=>{});await transport.close().catch(()=>{})}
    return a
  }
  async models(
    id: string,
    launcherOverride?: Partial<import('../../../shared/types').Launcher>
  ): Promise<import('../../../shared/types').AcpModelList> {
    const a=this.inventory.find(a=>a.id===id) ?? (await this.list()).find(a=>a.id===id)
    const cli = launcherOverride?.command
      ? {
          command: launcherOverride.command,
          args: launcherOverride.args || [],
          env: launcherOverride.env || {},
          model: launcherOverride.model,
          timeout_seconds: launcherOverride.timeout_seconds || 20
        }
      : a?.cli
    if(!cli?.command) return {models:[]}
    const tokens=splitCommand(cli.command)
    const args=[...tokens.slice(1),...(cli.args || [])]
    const kind=commandKindFor(id,[tokens[0],...args])
    if(kind==='native_cursor') {
      const raw=await this.run(tokens[0],[...args,'models'],30000,cli.env)
      return {models:parseCursorModels(raw),currentModelId:cli.model}
    }
    if(kind==='native_kimi') {
      const raw=await this.run(tokens[0],[...args,'provider','list','--json'],10000,cli.env)
      return {models:parseKimiModels(raw),currentModelId:cli.model}
    }
    if(kind==='native_agy') {
      const raw=await this.run(tokens[0],[...args,'models'],30000,cli.env)
      return {models:parseAgyModels(raw),currentModelId:cli.model}
    }
    if(kind==='native_opencode') {
      const raw=await this.run(tokens[0],[...args,'models'],15000,cli.env)
      return {models:raw.split('\n').map(id=>id.trim()).filter(id=>/^[^\s]+\/[^\s]+$/.test(id)).map(id=>({id,name:id}))}
    }
    if(kind==='native_codebuddy') {
      const help=await this.run(tokens[0],[...args,'--help'],3000,cli.env)
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
    const selected=this.inventory.filter(a=>!targets || targets.has(a.id))
    const groups=new Set(selected.filter(a=>a.nativeUpdate?.target==='wecode').map(agentUpdateGroupKey))
    const agents=this.inventory.filter(a=>selected.includes(a) || groups.has(agentUpdateGroupKey(a)))
    const checks=new Map<string,Promise<string>>()
    for(let offset=0;offset<agents.length;offset+=4) await Promise.all(agents.slice(offset,offset+4).map(async a=>{
      if(!force && a.checkedAt && Date.now()-Date.parse(a.checkedAt)<3600000 && !a.updateError)return
      a.checkedAt=new Date().toISOString(); a.updateError=undefined;a.latest=undefined
      try {
        if(a.nativeUpdate?.target==='wecode') {
          const key=agentUpdateGroupKey(a)
          let check=checks.get(key)
          if(!check){check=latestWecodeVersion(a.nativeUpdate.command,a.cli?.env);checks.set(key,check)}
          a.latest=await check
        }
        else if(a.source==='brew'&&a.manager&&a.package) {const info=JSON.parse(await this.run(a.manager,['info','--json=v2',a.package],30000));a.latest=info.formulae?.[0]?.versions?.stable || info.casks?.[0]?.version}
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
    if((!a.nativeUpdate || a.nativeUpdate.target==='wecode') && (!a.latest || !(a.nativeUpdate?.version || a.version) || !newer(a.latest,(a.nativeUpdate?.version || a.version)!)))throw new Error('No newer stable version available')
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
