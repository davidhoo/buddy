import { acquireAgentUse } from './agents/locks'
import { AgentManagementService } from './agents/service'
import { LibraryService } from './library/service'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  AcpModelList,
  AttachmentMeta,
  BootstrapResponse,
  CountdownInput,
  CreateTaskInput,
  CreateTaskResult,
  Event,
  GlobalSettings,
  InstructionQueueItem,
  RoundEventSummary,
  SendMessageInput,
  TestLauncherResult,
  StartTaskInput,
  Task,
  TaskDetail,
  TaskStats
} from '../../shared/types'
import { BuddyEventBus } from './events'
import {
  getGitStatus,
  gitStageAll,
  gitStageFiles,
  gitCommitAndPush,
  gitDiffForCommitMessage,
  gitFileDiff,
  gitBranches,
  gitCheckout,
  gitCreateBranch,
  getGitPushAvailability,
  gitPush
} from './git'
import type { GitStatusResult, GitCommitPushResult, GitPushAvailability, GitPushResult, TaskSettings } from '../../shared/types'
import {
  generateCommitMessageWithActor,
  cancelGenerateCommitMessage as cancelCommitMessage,
  resolveLauncher,
  isSupportedActor
} from './commit-message' 
import { BuddyRunner } from './runner'
import { BuddyStore } from './store'
import { QueueCoordinator } from './queue-coordinator'
import { createTaskNotifier } from './notifications'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { buildLauncherCommand, commandKindFor, kindNeedsPty, LauncherTimeoutError, parserActorForKind, runLauncher, runLauncherWithPty, splitCommand, type LauncherRunResult } from './launchers'
import { AcpClient, AcpStdioTransport, defaultAcpArgs, prepareAcpEnvironment, probeAcpModels, resolveAcpBinary, checkGlobalAcpAdapters, type GlobalAcpAdaptersStatus } from './acp'
import { detectModelFromConfig } from './model-detect'
import { DEFAULT_LAUNCHER_ORDER, normalizeGlobalSettings, defaultLauncherFor, normalizeLauncher } from '../../shared/defaults'
import { resolveProtocolLauncher } from '../../shared/agents'
import { buildPingPrompt, actorDisplayName } from './prompts'
import { parseActorEvents, parseBuddyMessage } from './parsers'
import { collectRawEvents, collectOutputText, lastValue, isCliWarningOnly } from './runner'
import { mergeChildEnv, refreshShellPath } from './shell-path'
import { redactSensitiveText } from './redact'
import {
  MODEL_CACHE_ERROR_TTL_MS,
  MODEL_CACHE_TTL_MS,
  ModelCatalogDiskCache,
  modelCatalogCacheKey,
  type ModelCacheMemEntry
} from './model-cache'

export interface BuddyCoreServiceOptions {
  dataRoot?: string
  events?: BuddyEventBus
}

export class BuddyCoreService {
  readonly agents: AgentManagementService
  readonly library: LibraryService
  private readonly store: BuddyStore
  private readonly runner: BuddyRunner
  private readonly events?: BuddyEventBus
  private coordinator?: QueueCoordinator
  private readonly modelDiskCache: ModelCatalogDiskCache
  private readonly acpModelCache = new Map<string, ModelCacheMemEntry>()
  private readonly acpModelInflight = new Map<string, Promise<AcpModelList>>()
  private readonly cliModelCache = new Map<string, ModelCacheMemEntry>()
  private readonly cliModelInflight = new Map<string, Promise<AcpModelList>>()
  private readonly modelCatalogListeners = new Set<(update: import('../../shared/types').ModelCatalogUpdate) => void>()

  constructor(options: BuddyCoreServiceOptions | string = {}) {
    const normalized = typeof options === 'string' ? { dataRoot: options } : options
    this.events = normalized.events
    this.store = new BuddyStore(normalized.dataRoot ?? defaultDataRoot())
    this.agents = new AgentManagementService(this.store)
    this.library = new LibraryService(this.store.dataRoot, this.agents)
    this.modelDiskCache = new ModelCatalogDiskCache(this.store.dataRoot)
    const notifier = createTaskNotifier(this.store)
    this.runner = new BuddyRunner(this.store, { events: normalized.events, notifier })
    this.coordinator = new QueueCoordinator({ store: this.store, runner: this.runner, events: normalized.events })
    this.runner.onTaskTerminal = (workspaceKey) => {
      void this.coordinator?.onTaskTerminal(workspaceKey)
    }
  }

  getLibrarySnapshot(force?: boolean) { return this.library.getSnapshot(!!force) }
  refreshLibrary(force?: boolean) { return this.library.refresh(!!force) }
  importLibrarySkills(discoveryIds: string[]) { return this.library.importSkills(discoveryIds) }
  setLibrarySkillAssignment(skillId: string, targetId: string, enabled: boolean) {
    return this.library.setSkillAssignment(skillId, targetId, enabled)
  }
  ejectLibrarySkill(skillId: string) { return this.library.ejectSkill(skillId) }
  importLibraryServers(discoveryIds: string[]) { return this.library.importServers(discoveryIds) }
  setLibraryServerAssignment(serverId: string, targetId: string, enabled: boolean) {
    return this.library.setServerAssignment(serverId, targetId, enabled)
  }
  openLibraryAuthGuidance(targetId: string, serverName: string) {
    return this.library.openAuthGuidance(targetId, serverName)
  }
  openLibraryDir() { return this.library.openLibraryDir() }
  openLibraryBackupsDir() { return this.library.openBackupsDir() }
  ensureLibraryAcpHome(agentId: string) { return this.library.ensureAcpHome(agentId) }

  /**
   * List models advertised by a CLI actor. Memory TTL avoids respawning slow
   * CLIs while switching actors; disk cache survives restarts (Cache-First +
   * background refresh).
   */
  listCliModels(id: string, context?: import('../../shared/types').ModelListContext): Promise<AcpModelList> {
    // Cache reads stay lock-free; resolveModelCatalog takes withAgentUse only around the probe.
    return this.listCliModelsInner(id, context)
  }

  private async resolveModelListLauncher(
    actor: string,
    protocol: 'cli' | 'acp',
    context?: import('../../shared/types').ModelListContext
  ): Promise<import('../../shared/types').Launcher | undefined> {
    if (context?.launcher?.command) {
      return normalizeLauncher(actor, { ...context.launcher, protocol: context.launcher.protocol || protocol })
    }
    if (context?.taskId && context.workspaceKey) {
      try {
        const taskSettings = await this.store.readTaskSettings(context.taskId, context.workspaceKey)
        const fromTask = taskSettings.launchers?.[actor]
        const taskProtocol = fromTask?.protocol === 'acp' ? 'acp' : 'cli'
        if (fromTask?.command && taskProtocol === protocol) {
          return normalizeLauncher(actor, { ...fromTask, protocol })
        }
      } catch {
        /* fall through to global/inventory */
      }
    }
    const settings = await this.store.readGlobalSettings()
    const inventory = await this.agents.getInventory()
    const agent = inventory.agents.find(a => a.id === actor)
    const resolved = resolveProtocolLauncher(protocol, agent, {
      agentConfig: settings.agent_management?.[actor],
      savedLauncher: settings.launchers?.[actor]
    })
    return resolved?.command
      ? normalizeLauncher(actor, { ...resolved, protocol })
      : undefined
  }

  private async listCliModelsInner(id: string, context?: import('../../shared/types').ModelListContext): Promise<AcpModelList> {
    const cli = await this.resolveModelListLauncher(id, 'cli', context)
    if (!cli?.command) return { models: [] }

    const cacheKey = modelCatalogCacheKey({
      protocol: 'cli',
      actor: id,
      command: cli.command,
      args: cli.args,
      env: cli.env
    })
    return this.resolveModelCatalog({
      cacheKey,
      memory: this.cliModelCache,
      inflight: this.cliModelInflight,
      fetch: () => this.agents.models(id, cli),
      actor: id,
      protocol: 'cli'
    })
  }

  /**
   * Shared Cache-First resolver: fresh memory hit returns immediately; stale
   * memory/disk returns immediately while a background probe refreshes; only a
   * true cold miss waits on the probe.
   */
  subscribeModelCatalog(listener: (update: import('../../shared/types').ModelCatalogUpdate) => void) {
    this.modelCatalogListeners.add(listener)
    return () => { this.modelCatalogListeners.delete(listener) }
  }

  private publishModelCatalog(update: import('../../shared/types').ModelCatalogUpdate) {
    for (const listener of this.modelCatalogListeners) {
      try { listener(update) } catch { /* subscriber errors must not break refresh */ }
    }
  }

  private async resolveModelCatalog(options: {
    cacheKey: string
    memory: Map<string, ModelCacheMemEntry>
    inflight: Map<string, Promise<AcpModelList>>
    fetch: () => Promise<AcpModelList>
    actor: string
    protocol: 'cli' | 'acp'
  }): Promise<AcpModelList> {
    await this.modelDiskCache.ensureLoaded()
    const now = Date.now()
    let cached = options.memory.get(options.cacheKey)
    if (!cached) {
      const fromDisk = this.modelDiskCache.get(options.cacheKey)
      if (fromDisk) {
        options.memory.set(options.cacheKey, fromDisk)
        cached = fromDisk
      }
    }
    if (cached && cached.expiresAt > now) return cached.list

    const refresh = (): Promise<AcpModelList> => {
      const existing = options.inflight.get(options.cacheKey)
      if (existing) return existing
      // Occupy inflight synchronously before any await (including withAgentUse),
      // so concurrent callers share one probe instead of racing a lock gap.
      const pending = (async (): Promise<AcpModelList> => {
        try {
          const list = await this.withAgentUse(() => options.fetch())
          const entry = { list, expiresAt: Date.now() + MODEL_CACHE_TTL_MS }
          options.memory.set(options.cacheKey, entry)
          void this.modelDiskCache.set(options.cacheKey, list).catch(() => {})
          this.publishModelCatalog({ actor: options.actor, protocol: options.protocol, list })
          return list
        } catch (error) {
          const message = redactSensitiveText(String(error))
          const stale = options.memory.get(options.cacheKey)
          if (stale) {
            options.memory.set(options.cacheKey, {
              list: { ...stale.list, error: message },
              expiresAt: Date.now() + MODEL_CACHE_ERROR_TTL_MS
            })
            this.publishModelCatalog({
              actor: options.actor,
              protocol: options.protocol,
              list: { ...stale.list, error: message }
            })
            return { ...stale.list, error: message }
          }
          const empty = { models: [], error: message }
          this.publishModelCatalog({ actor: options.actor, protocol: options.protocol, list: empty })
          return empty
        } finally {
          options.inflight.delete(options.cacheKey)
        }
      })()
      options.inflight.set(options.cacheKey, pending)
      return pending
    }

    if (cached) {
      void refresh()
      return cached.list
    }
    return refresh()
  }
  async listLocalAgents(force=false) { return force ? this.refreshLocalAgents('scan').then(s=>s.agents) : (await this.agents.getInventory()).agents }
  getAgentInventory() { return this.agents.getInventory() }
  getAgentUpdateState() { return this.agents.updates.getState() }
  startAgentUpdates(ids:string[],requestId:string) { return this.agents.updates.start(ids,requestId) }
  async initializeAgents() {
    try {
      await this.agents.initialize()
      // Migrate/discard legacy plaintext model-cache keys even when no model UI is opened.
      await this.modelDiskCache.ensureLoaded()
    } finally {
      // An unreadable update history must not prevent inventory discovery.
      void this.withAgentUse(async()=>{if(this.agents.needsStartupRefresh())await this.agents.refresh();await this.agents.checkUpdates(false)}).catch(()=>{})
    }
  }
  refreshLocalAgents(mode:'all'|'scan'|'updates'='all') {
    return this.withAgentUse(async()=>{
      // Rescan / refresh-all re-read the login shell PATH so installs added after
      // Buddy started become visible. Update-only checks keep the existing snapshot.
      if(mode!=='updates') {
        const pathRefresh = refreshShellPath()
        if (!pathRefresh.ok) {
          this.agents.noteRefreshDiagnostic(pathRefresh.error)
        }
        await this.agents.refresh()
      }
      if(mode!=='scan')await this.agents.checkUpdates(mode==='all' || mode==='updates')
      return this.agents.getInventory()
    })
  }
  async configureAgent(id:string, config:import('../../shared/agents').AgentConfiguration) {
    if((await this.agents.updates.getState()).activeBatch)throw new Error('Agent updates are running')
    await this.agents.configure(id,config)
    // Transport edits refresh only dirty targets; model/default edits do no CLI work.
    if(this.agents.hasDirtyTargets())void this.withAgentUse(()=>this.agents.list()).catch(()=>{})
  }
  probeLocalAgent(id:string) { return this.withAgentUse(()=>this.agents.probe(id)) }
  checkAgentUpdates(force=false) { return this.withAgentUse(()=>this.agents.checkUpdates(force)) }
  updateLocalAgents(ids:string[]) { return this.agents.update(ids) }
  getAgentUpdateJobs() { return this.agents.getJobs() }
  cancelAgentUpdates() { return this.agents.cancel() }

  private async withAgentUse<T>(run:()=>Promise<T>):Promise<T> {
    const release=await acquireAgentUse()
    try{return await run()}finally{release()}
  }

  getCoordinator(): QueueCoordinator | undefined {
    return this.coordinator
  }

  getStore(): BuddyStore {
    return this.store
  }

  async updateTaskText(taskId: string, workspaceKey: string, taskText: string): Promise<void> {
    return this.store.updateTaskText(taskId, workspaceKey, taskText)
  }

  async updateTaskLauncherModel(
    taskId: string,
    workspaceKey: string,
    actor: string,
    model: string
  ) {
    return this.store.updateTaskLauncherModel(taskId, workspaceKey, actor, model)
  }

  async checkHealth(): Promise<boolean> {
    return true
  }

  async bootstrap(): Promise<BootstrapResponse> {
    let locale: string | undefined
    try { locale = app?.getLocale() } catch { /* not available in test env */ }
    return {
      version: 'native',
      repo_root: '',
      data_root: this.store.dataRoot,
      home_dir: homedir(),
      locale,
      tasks: await this.store.getTasks(),
      global_settings: await this.store.readGlobalSettings()
    }
  }

  getTasks(): Promise<Task[]> {
    return this.store.getTasks()
  }

  getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getTaskDetail(taskId, workspaceKey)
  }

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const result = await this.store.createTask(input)
    // A newly created queued task may be the next to run; an immediate task may now block the
    // queue. Either way the workspace scheduling conditions changed, so re-evaluate once.
    void this.coordinator?.reconcile(result.workspace_key)
    return result
  }

  async deleteTask(taskId: string, workspaceKey?: string): Promise<void> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    await this.runner.cancelTask(taskId, workspaceKey)
    await this.store.deleteTask(taskId, workspaceKey)
    // Removing a blocking task may unblock the queue.
    void this.coordinator?.onTaskTerminal(workspaceKey)
  }

  async startTask(taskId: string, input: StartTaskInput): Promise<void> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const state = await this.store.readTaskState(taskId, input.workspace_key).catch(() => null)
    if (state?.status === 'CANCELLED') throw new Error('Task has been cancelled')
    // A queued task must not be started directly by the renderer via runner.startTask, because
    // runner.canStartFrom('QUEUED') is false. Any manual user start on a queued task — whether
    // waiting, superseded, or a blocked active task (PAUSED/FAILED) — goes through the
    // coordinator's manual activation path, which preserves queue identity and supersede logic.
    if (state && state.execution_mode === 'queued') {
      await this.coordinator?.startQueuedNow(taskId, input.workspace_key)
      return
    }
    await this.runner.startTask(taskId, input)
    // After an immediate start, re-evaluate the queue in case this task is itself an
    // immediate-execution task that should block queued advancement.
    void this.coordinator?.reconcile(input.workspace_key)
  }

  sendMessage(taskId: string, input: SendMessageInput): Promise<void> {
    return this.runner.sendMessage(taskId, input)
  }

  async skipCountdown(taskId: string, input: CountdownInput): Promise<void> {
    await this.runner.skipCountdown(taskId, input)
  }

  pauseCountdown(taskId: string, input: CountdownInput): Promise<void> {
    return this.runner.pauseCountdown(taskId, input)
  }

  async interrupt(taskId: string, workspaceKey?: string): Promise<void> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    await this.runner.interrupt(taskId, workspaceKey)
    // A user interrupt moves the task to PAUSED, which may block (queued) or free (immediate)
    // the workspace queue. Re-evaluate once.
    void this.coordinator?.onTaskTerminal(workspaceKey)
  }

  async cancelTask(taskId: string, workspaceKey?: string): Promise<void> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    await this.runner.cancelTask(taskId, workspaceKey)
  }

  enqueueInstruction(taskId: string, workspaceKey: string, content: string, attachments?: AttachmentMeta[]): Promise<InstructionQueueItem> {
    return this.runner.enqueueInstruction(taskId, workspaceKey, content, attachments)
  }

  dequeueInstruction(taskId: string, workspaceKey: string, itemId: string): Promise<void> {
    return this.runner.dequeueInstruction(taskId, workspaceKey, itemId)
  }

  clearInstructionQueue(taskId: string, workspaceKey: string): Promise<void> {
    return this.runner.clearInstructionQueue(taskId, workspaceKey)
  }

  interruptAndInsert(taskId: string, workspaceKey: string, queueItemId: string): Promise<void> {
    return this.runner.interruptAndInsert(taskId, workspaceKey, queueItemId)
  }

  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<{ events: Event[] }> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getEvents(taskId, since, workspaceKey)
  }

  getRoundEvents(taskId: string, runId: string, workspaceKey?: string, actor?: string, command?: string): Promise<RoundEventSummary | null> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getRoundEvents(taskId, runId, workspaceKey, actor, command)
  }

  getTaskStats(taskId: string, workspaceKey?: string): Promise<TaskStats | null> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getTaskStats(taskId, workspaceKey)
  }

  async updateGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
    const current = await this.store.readGlobalSettings()
    const launchers = { ...settings.launchers }
    // Managed launchers are edited through the serialized per-Agent API.
    // A stale general-settings window must not replace their commands/models.
    for (const id of Object.keys(current.agent_management ?? {})) {
      const existing = current.launchers?.[id]
      if (existing) launchers[id] = { ...existing, timeout_seconds: settings.launchers?.[id]?.timeout_seconds ?? existing.timeout_seconds }
    }
    const agentManagement = { ...current.agent_management }
    for (const [id, config] of Object.entries(agentManagement)) {
      const timeout = launchers[id]?.timeout_seconds
      if (timeout === undefined) continue
      agentManagement[id] = { ...config,
        ...(config.cli ? { cli: { ...config.cli, timeout_seconds: timeout } } : {}),
        ...(config.acp ? { acp: { ...config.acp, timeout_seconds: timeout } } : {})
      }
    }
    return this.store.updateGlobalSettings({ ...settings, launchers, agent_management: agentManagement })
  }

  gitStatus(repoRoot: string): Promise<GitStatusResult> {
    return getGitStatus(repoRoot)
  }

  gitStageAll(repoRoot: string): Promise<void> {
    return gitStageAll(repoRoot)
  }

  gitStageFiles(repoRoot: string, paths: string[]): Promise<void> {
    return gitStageFiles(repoRoot, paths)
  }

  gitCommitAndPush(repoRoot: string, message: string, remote: string, push?: boolean): Promise<GitCommitPushResult> {
    return gitCommitAndPush(repoRoot, message, remote, push)
  }

  gitDiffForCommitMessage(repoRoot: string, paths?: string[]): Promise<string> {
    return gitDiffForCommitMessage(repoRoot, paths)
  }

  gitFileDiff(repoRoot: string, filePath: string): Promise<string> {
    return gitFileDiff(repoRoot, filePath)
  }

  gitBranches(repoRoot: string): Promise<string[]> {
    return gitBranches(repoRoot)
  }

  gitCheckout(repoRoot: string, branch: string): Promise<void> {
    return gitCheckout(repoRoot, branch)
  }

  gitCreateBranch(repoRoot: string, branch: string): Promise<void> {
    return gitCreateBranch(repoRoot, branch)
  }

  gitPushAvailability(repoRoot: string, remote: string): Promise<GitPushAvailability> {
    return getGitPushAvailability(repoRoot, remote)
  }

  gitPush(repoRoot: string, remote: string): Promise<GitPushResult> {
    return gitPush(repoRoot, remote)
  }

  async generateCommitMessage(input: {
    repoRoot: string
    actor: string
    lang?: string
    paths: string[]
    taskSettings?: TaskSettings | null
  }): Promise<{ message: string }> {
    const globalSettings = await this.store.readGlobalSettings()
    if(!isSupportedActor(input.actor) && !input.taskSettings?.launchers?.[input.actor] && !globalSettings.launchers?.[input.actor]) throw new Error('Agent unavailable')
    const actor = input.actor
    const launcher = resolveLauncher(actor, input.taskSettings, globalSettings)
    const result = await generateCommitMessageWithActor({
      repoRoot: input.repoRoot,
      actor,
      lang: input.lang,
      paths: input.paths,
      launcher,
      dataRoot: this.store.dataRoot
    })
    return { message: result.message }
  }

  cancelGenerateCommitMessage(): void {
    cancelCommitMessage()
  }

  async recoverInterruptedRuns(): Promise<void> {
    const tasks = await this.store.getTasks()
    for (const task of tasks) {
      const wasRunning = task.status.startsWith('RUNNING_') || task.status === 'PINGING'
      if (wasRunning) {
        const event = await this.store.appendTaskEvent(task.task_id, task.workspace_key, {
          type: 'actor.interrupted',
          payload: { reason: 'app_restarted' }
        })
        await this.store.updateTaskState(task.task_id, task.workspace_key, (state) => ({
          ...state,
          status: 'PAUSED',
          active_run: null,
          updated_at: new Date().toISOString()
        }))
        this.events?.publish({
          workspace_key: task.workspace_key,
          task_id: task.task_id,
          event
        })
      }
    }
    // After recovery, rebuild per-workspace queues and run a safe scheduling pass.
    await this.runner.services.recover()
    // A previously-running queued task is now PAUSED and blocks its queue — no auto-start.
    // Unblocked workspaces with waiting tasks will start their queue head.
    await this.coordinator?.rebuildAndReconcileAll()
  }

  /**
   * Detect the currently configured model for every CLI actor, reading each
   * actor's launcher command from global settings so the result matches what
   * the runner will actually invoke. Used by the new-task modal to annotate
   * each CLI agent option with its model (e.g. "Codex (gpt-5.6-luna)").
   *
   * ACP actors are omitted: their model is chosen from the live agent list
   * rather than from a local CLI config file.
   *
   * Returns a map of actor → model string. Actors whose model cannot be
   * determined before a run resolve to undefined.
   */
  async detectActorModels(): Promise<Record<string, string | undefined>> {
    const settings = await this.store.readGlobalSettings()
    const launchers = normalizeGlobalSettings(settings).launchers ?? {}
    const result: Record<string, string | undefined> = {}
    for (const actor of DEFAULT_LAUNCHER_ORDER) {
      const launcher = launchers[actor]
      if (launcher?.protocol === 'acp') {
        result[actor] = undefined
        continue
      }
      const command = launcher?.command
      result[actor] = await detectModelFromConfig(actor, command).catch(() => undefined)
    }
    return result
  }

  /**
   * Probe an ACP actor for the models it currently advertises. CLI actors
   * resolve to an empty list. Memory + disk Cache-First with background
   * refresh; a failed refresh falls back to the last good list.
   */
  listAcpModels(
    actor: string,
    cwd?: string,
    context?: import('../../shared/types').ModelListContext
  ): Promise<AcpModelList> {
    // Cache reads stay lock-free; resolveModelCatalog takes withAgentUse only around the probe.
    return this.listAcpModelsInner(actor, cwd, context)
  }
  private async listAcpModelsInner(
    actor: string,
    cwd?: string,
    context?: import('../../shared/types').ModelListContext
  ): Promise<AcpModelList> {
    const empty: AcpModelList = { models: [] }
    const launcher = await this.resolveModelListLauncher(actor, 'acp', context)
    if (!launcher?.command) return empty

    const cacheKey = modelCatalogCacheKey({
      protocol: 'acp',
      actor,
      command: launcher.command,
      args: launcher.args,
      env: launcher.env,
      cwd
    })
    return this.resolveModelCatalog({
      cacheKey,
      memory: this.acpModelCache,
      inflight: this.acpModelInflight,
      actor,
      protocol: 'acp',
      fetch: async () => {
        const baseArgs = Array.isArray(launcher.args)
          ? launcher.args
          : defaultAcpArgs(launcher.command, actor)
        const binary = resolveAcpBinary(launcher.command, baseArgs)
        const acpEnv = await prepareAcpEnvironment(actor, launcher.env, this.store.dataRoot)
        try {
          const list = await probeAcpModels({
            command: binary.command,
            args: binary.args,
            cwd,
            env: acpEnv
          })
          this.agents.recordAcpProbe(actor, { ok: true })
          return list
        } catch (error) {
          const message = redactSensitiveText(String(error))
          this.agents.recordAcpProbe(actor, { ok: false, error: message })
          throw error
        }
      }
    })
  }

  testLauncher(actor:string,command:string,env?:Record<string,string>,protocol?:'cli'|'acp',args?:string[]):Promise<TestLauncherResult> {
    return this.withAgentUse(()=>this.testLauncherInner(actor,command,env,protocol,args))
  }
  private async testLauncherInner(
    actor: string,
    command: string,
    env?: Record<string, string>,
    protocol?: 'cli' | 'acp',
    args?: string[]
  ): Promise<TestLauncherResult> {
    const PING_TIMEOUT_SECONDS = 120
    const startTime = Date.now()
    const effectiveCommand =
      protocol !== 'acp' && (command.trim() === 'npx' || !command.trim())
        ? defaultLauncherFor(actor).command
        : command

    // Phase 1: Tool check - verify the command exists and can be spawned
    try {
      const splitCmd = splitCommand(effectiveCommand)
      const baseExecutable = splitCmd[0] ?? ''
      await new Promise<void>((resolve, reject) => {
        const child = spawn(baseExecutable, ['--version'], {
          env: mergeChildEnv(process.env, env),
          stdio: 'pipe',
          timeout: 10000
        })
        let settled = false
        child.on('error', (err) => {
          if (settled) return
          settled = true
          reject(err)
        })
        child.on('spawn', () => {
          if (settled) return
          settled = true
          child.kill('SIGTERM')
          resolve()
        })
        // Fallback timeout in case spawn event never fires
        setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGTERM')
          resolve()
        }, 8000)
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const res: TestLauncherResult = {
        actor,
        success: false,
        phase: 'tool_check',
        error: redactSensitiveText(message).slice(0, 300),
        durationMs: Date.now() - startTime
      }
      await this.store.recordLauncherTest(actor, res).catch(() => {})
      return res
    }

    // Phase 2: Ping test - actually invoke the actor with a hello prompt (or ACP initialize handshake)
    const testDir = join(tmpdir(), `buddy-test-${actor}-${Date.now()}`)
    try {
      await mkdir(testDir, { recursive: true })

      if (protocol === 'acp') {
        const baseArgs = args && args.length > 0 ? args : defaultAcpArgs(effectiveCommand, actor)
        const resolved = resolveAcpBinary(effectiveCommand, baseArgs)
        const acpEnv = await prepareAcpEnvironment(actor, env, this.store.dataRoot)
        const transport = new AcpStdioTransport({
          command: resolved.command,
          args: resolved.args,
          cwd: testDir,
          env: acpEnv
        })
        try {
          transport.start()
          const client = new AcpClient(transport, { timeoutMs: PING_TIMEOUT_SECONDS * 1000 })
          const initResult = await client.initialize()
          const info = initResult.agentInfo ?? initResult.serverInfo
          const serverName = info?.name ?? (actor === 'cursor' ? 'Cursor Agent' : `${actorDisplayName(actor)} (ACP)`)
          const serverVersion = info?.version ? ` v${info.version}` : ''
          await client.close().catch(() => {})
          const res: TestLauncherResult = {
            actor,
            success: true,
            phase: 'ping',
            responsePreview: `Connected: ${serverName}${serverVersion}`,
            durationMs: Date.now() - startTime,
            timedOut: false,
            exitCode: 0,
            signal: null
          }
          await this.store.recordLauncherTest(actor, res).catch(() => {})
          return res
        } catch (err) {
          await transport.close().catch(() => {})
          const message = err instanceof Error ? err.message : String(err)
          const res: TestLauncherResult = {
            actor,
            success: false,
            phase: 'ping',
            error: redactSensitiveText(message).slice(0, 300),
            durationMs: Date.now() - startTime,
            timedOut: false,
            exitCode: null,
            signal: null
          }
          await this.store.recordLauncherTest(actor, res).catch(() => {})
          return res
        }
      }

      const runId = `test_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
      const prompt = buildPingPrompt(actor)
      const promptFile = join(testDir, `${runId}-prompt.md`)
      const outputFile = join(testDir, `${runId}-output.md`)
      const eventFile = join(testDir, `${runId}-events.jsonl`)
      await writeFile(promptFile, prompt)

      const commandKind = commandKindFor(actor, effectiveCommand)
      const launcherCommand = buildLauncherCommand({
        actor,
        command: effectiveCommand,
        mode: 'start',
        promptFile,
        promptText: prompt,
        eventFile,
        outputFile,
        repoRoot: testDir,
        taskDir: testDir,
        runId,
        timeoutSeconds: PING_TIMEOUT_SECONDS
      })

      const outputLines: string[] = []
      const stderrLines: string[] = []

      try {
        const needsPty = kindNeedsPty(launcherCommand.kind)
        let result: LauncherRunResult

        const mergedEnv = { ...env, ...(launcherCommand.env ?? {}) }

        if (needsPty) {
          result = await runLauncherWithPty({
            command: launcherCommand.command,
            args: launcherCommand.args,
            cwd: testDir,
            env: mergedEnv,
            timeoutMs: PING_TIMEOUT_SECONDS * 1000,
            onData: (data) => {
              for (const line of data.split(/\r?\n/).filter(Boolean)) {
                outputLines.push(line)
              }
            }
          })
        } else {
          result = await runLauncher({
            command: launcherCommand.command,
            args: launcherCommand.args,
            cwd: testDir,
            env: mergedEnv,
            stdinText: launcherCommand.stdinText,
            timeoutMs: PING_TIMEOUT_SECONDS * 1000,
            onStdout: (line) => outputLines.push(line),
            onStderr: (line) => stderrLines.push(line)
          })
        }

        // 1. Priority check for timeout without executing unnecessary parsing
        if (result.timedOut) {
          const res: TestLauncherResult = {
            actor,
            success: false,
            phase: 'ping',
            error: new LauncherTimeoutError(PING_TIMEOUT_SECONDS * 1000).message,
            runId,
            durationMs: Date.now() - startTime,
            timedOut: true,
            exitCode: result.exitCode ?? null,
            signal: result.signal ?? null
          }
          await this.store.recordLauncherTest(actor, res).catch(() => {})
          return res
        }

        // 2. Non-zero or signal exit
        if (result.exitCode !== 0) {
          const stdoutText = outputLines.join('\n')
          const outputText = await collectOutputText(actor, launcherCommand.kind, outputFile, stdoutText).catch(() => '')
          const stderrText = stderrLines.join('\n').trim()

          let exitDesc: string
          if (result.exitCode !== null && result.exitCode !== undefined) {
            exitDesc = `Process exited with code ${result.exitCode}`
          } else if (result.signal) {
            exitDesc = `Process terminated by signal ${result.signal}`
          } else {
            exitDesc = 'Process exited unexpectedly'
          }

          const rawDetail = stderrText || outputText.trim() || exitDesc
          const error = redactSensitiveText(rawDetail).slice(0, 300)
          const res: TestLauncherResult = {
            actor,
            success: false,
            phase: 'ping',
            error,
            runId,
            durationMs: Date.now() - startTime,
            timedOut: false,
            exitCode: result.exitCode ?? null,
            signal: result.signal ?? null
          }
          await this.store.recordLauncherTest(actor, res).catch(() => {})
          return res
        }

        // 3. Exit 0: collect output and parse buddy message
        const stdoutText = outputLines.join('\n')
        const rawEvents = await collectRawEvents(eventFile, stdoutText, launcherCommand.kind)
        const outputText = await collectOutputText(actor, launcherCommand.kind, outputFile, stdoutText)
        const parsedLines = parseActorEvents(parserActorForKind(actor, launcherCommand.kind), rawEvents)

        const message = parseBuddyMessage(outputText)
        const hasContent = message.kind === 'message'
          ? message.text.trim().length > 0
          : message.content.trim().length > 0
        if (!hasContent) {
          const res: TestLauncherResult = {
            actor,
            success: false,
            phase: 'ping',
            error: 'Actor responded with empty content',
            runId,
            durationMs: Date.now() - startTime,
            timedOut: false,
            exitCode: 0,
            signal: null
          }
          await this.store.recordLauncherTest(actor, res).catch(() => {})
          return res
        }

        const sessionId = lastValue(parsedLines.map((line: any) => line.sessionId))
        const threadId = lastValue(parsedLines.map((line: any) => line.threadId))
        const preview = message.kind === 'message'
          ? message.text.slice(0, 200)
          : message.content.slice(0, 200)

        const res: TestLauncherResult = {
          actor,
          success: true,
          phase: 'ping',
          sessionId,
          threadId,
          responsePreview: redactSensitiveText(preview),
          runId,
          durationMs: Date.now() - startTime,
          timedOut: false,
          exitCode: 0,
          signal: null
        }
        await this.store.recordLauncherTest(actor, res).catch(() => {})
        return res
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const stderrText = stderrLines.join('\n').trim()
        const isOnlyWarning = stderrText && isCliWarningOnly(stderrText)
        const rawDetail = message || (!isOnlyWarning ? stderrText : 'Actor exited without producing any output')
        const res: TestLauncherResult = {
          actor,
          success: false,
          phase: 'ping',
          error: redactSensitiveText(rawDetail).slice(0, 300),
          runId,
          durationMs: Date.now() - startTime,
          timedOut: false,
          exitCode: null,
          signal: null
        }
        await this.store.recordLauncherTest(actor, res).catch(() => {})
        return res
      }
    } finally {
      // Clean up temp directory
      try { await rm(testDir, { recursive: true, force: true }) } catch { /* ignore cleanup errors */ }
    }
  }

  checkAcpGlobalAdapters(): GlobalAcpAdaptersStatus {
    return checkGlobalAcpAdapters()
  }
}

function defaultDataRoot(): string {
  return process.env.BUDDY_DATA_ROOT || join(homedir(), 'Library', 'Application Support', 'buddy')
}
