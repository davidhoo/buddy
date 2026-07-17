import type {
  AttachmentMeta,
  BootstrapResponse,
  CountdownInput,
  CreateTaskInput,
  CreateTaskResult,
  CursorModelCatalog,
  CursorModelDiscoveryInput,
  Event,
  GlobalSettings,
  InstructionQueueItem,
  Launcher,
  RoundEventSummary,
  SendMessageInput,
  StartTaskInput,
  Task,
  TaskDetail,
  TaskEventEnvelope,
  TaskStats,
  TestLauncherResult
} from '../shared/types'

type Listener = (event: unknown, payload: TaskEventEnvelope) => void

interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: Listener): void
  removeListener(channel: string, listener: Listener): void
}

export function createBuddyPreloadApi(ipc: IpcLike) {
  return {
    checkHealth: (): Promise<boolean> =>
      ipc.invoke('buddy:checkHealth') as Promise<boolean>,
    bootstrap: (): Promise<BootstrapResponse> =>
      ipc.invoke('buddy:bootstrap') as Promise<BootstrapResponse>,
    getTasks: (): Promise<Task[]> =>
      ipc.invoke('buddy:getTasks') as Promise<Task[]>,
    getTaskDetail: (taskId: string, workspaceKey?: string): Promise<TaskDetail> =>
      ipc.invoke('buddy:getTaskDetail', taskId, workspaceKey) as Promise<TaskDetail>,
    createTask: (input: CreateTaskInput): Promise<CreateTaskResult> =>
      ipc.invoke('buddy:createTask', input) as Promise<CreateTaskResult>,
    deleteTask: (taskId: string, workspaceKey?: string): Promise<void> =>
      ipc.invoke('buddy:deleteTask', taskId, workspaceKey) as Promise<void>,
    startTask: (taskId: string, input: StartTaskInput): Promise<void> =>
      ipc.invoke('buddy:startTask', taskId, input) as Promise<void>,
    sendMessage: (taskId: string, input: SendMessageInput): Promise<void> =>
      ipc.invoke('buddy:sendMessage', taskId, input) as Promise<void>,
    skipCountdown: (taskId: string, input: CountdownInput): Promise<void> =>
      ipc.invoke('buddy:skipCountdown', taskId, input) as Promise<void>,
    pauseCountdown: (taskId: string, input: CountdownInput): Promise<void> =>
      ipc.invoke('buddy:pauseCountdown', taskId, input) as Promise<void>,
    interrupt: (taskId: string, workspaceKey?: string): Promise<void> =>
      ipc.invoke('buddy:interrupt', taskId, workspaceKey) as Promise<void>,
    enqueueInstruction: (taskId: string, workspaceKey: string, content: string, attachments?: AttachmentMeta[]): Promise<InstructionQueueItem> =>
      ipc.invoke('buddy:enqueueInstruction', taskId, workspaceKey, content, attachments) as Promise<InstructionQueueItem>,
    dequeueInstruction: (taskId: string, workspaceKey: string, itemId: string): Promise<void> =>
      ipc.invoke('buddy:dequeueInstruction', taskId, workspaceKey, itemId) as Promise<void>,
    clearInstructionQueue: (taskId: string, workspaceKey: string): Promise<void> =>
      ipc.invoke('buddy:clearInstructionQueue', taskId, workspaceKey) as Promise<void>,
    interruptAndInsert: (taskId: string, workspaceKey: string, queueItemId: string): Promise<void> =>
      ipc.invoke('buddy:interruptAndInsert', taskId, workspaceKey, queueItemId) as Promise<void>,
    getEvents: (taskId: string, since: number, workspaceKey?: string): Promise<{ events: Event[] }> =>
      ipc.invoke('buddy:getEvents', taskId, since, workspaceKey) as Promise<{ events: Event[] }>,
    getRoundEvents: (taskId: string, runId: string, workspaceKey?: string, actor?: string): Promise<RoundEventSummary | null> =>
      ipc.invoke('buddy:getRoundEvents', taskId, runId, workspaceKey, actor) as Promise<RoundEventSummary | null>,
    getTaskStats: (taskId: string, workspaceKey?: string): Promise<TaskStats | null> =>
      ipc.invoke('buddy:getTaskStats', taskId, workspaceKey) as Promise<TaskStats | null>,
    updateGlobalSettings: (settings: GlobalSettings): Promise<GlobalSettings> =>
      ipc.invoke('buddy:updateGlobalSettings', settings) as Promise<GlobalSettings>,
    listCursorModels: (input?: CursorModelDiscoveryInput): Promise<CursorModelCatalog> =>
      ipc.invoke('buddy:listCursorModels', input) as Promise<CursorModelCatalog>,
    gitStatus: (repoRoot: string): Promise<unknown> =>
      ipc.invoke('buddy:gitStatus', repoRoot),
    gitStageAll: (repoRoot: string): Promise<void> =>
      ipc.invoke('buddy:gitStageAll', repoRoot) as Promise<void>,
    gitCommitAndPush: (repoRoot: string, message: string, remote: string, push?: boolean): Promise<unknown> =>
      ipc.invoke('buddy:gitCommitAndPush', repoRoot, message, remote, push),
    gitDiffForCommitMessage: (repoRoot: string): Promise<string> =>
      ipc.invoke('buddy:gitDiffForCommitMessage', repoRoot) as Promise<string>,
    generateCommitMessage: (repoRoot: string, actorCommand?: string, lang?: string): Promise<string> =>
      ipc.invoke('buddy:generateCommitMessage', repoRoot, actorCommand, lang) as Promise<string>,
    testLauncher: (actor: string, command: string, env?: Record<string, string>, options?: Partial<Launcher>): Promise<TestLauncherResult> =>
      ipc.invoke('buddy:testLauncher', actor, command, env, options) as Promise<TestLauncherResult>,
    updateTaskText: (taskId: string, workspaceKey: string, taskText: string): Promise<void> =>
      ipc.invoke('buddy:updateTaskText', taskId, workspaceKey, taskText) as Promise<void>,
    onTaskEvent: (callback: (payload: TaskEventEnvelope) => void): (() => void) => {
      const listener: Listener = (_event, payload) => callback(payload)
      ipc.on('buddy:event', listener)
      return () => ipc.removeListener('buddy:event', listener)
    }
  }
}

export type BuddyPreloadApi = ReturnType<typeof createBuddyPreloadApi>
