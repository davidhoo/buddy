import type {
  AttachmentMeta,
  CountdownInput,
  CreateTaskInput,
  CursorModelDiscoveryInput,
  GlobalSettings,
  InstructionQueueItem,
  Launcher,
  RoundEventSummary,
  SendMessageInput,
  TestLauncherResult,
  StartTaskInput,
  TaskEventEnvelope,
  TaskStats
} from '../../shared/types'

function buddy() {
  if (!window.buddy) {
    throw new Error('Native Buddy API is unavailable')
  }
  return window.buddy
}

let latestGlobalSettings: GlobalSettings | undefined
let globalSettingsSaveQueue: Promise<void> = Promise.resolve()

function updateGlobalSettingsPatch(
  base: GlobalSettings,
  patch: Partial<GlobalSettings>
): Promise<GlobalSettings> {
  let resolveResult!: (value: GlobalSettings) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<GlobalSettings>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  globalSettingsSaveQueue = globalSettingsSaveQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const next = { ...(latestGlobalSettings ?? base), ...patch }
        const saved = await buddy().updateGlobalSettings(next)
        latestGlobalSettings = saved
        resolveResult(saved)
      } catch (error) {
        rejectResult(error)
      }
    })
  return result
}

export const api = {
  checkHealth: () => buddy().checkHealth(),
  bootstrap: () => buddy().bootstrap(),
  getTasks: () => buddy().getTasks(),
  getTaskDetail: (taskId: string, workspaceKey?: string) =>
    buddy().getTaskDetail(taskId, workspaceKey),
  createTask: (data: CreateTaskInput) =>
    buddy().createTask(data),
  deleteTask: (taskId: string, workspaceKey?: string) =>
    buddy().deleteTask(taskId, workspaceKey),
  startTask: (taskId: string, data: StartTaskInput) =>
    buddy().startTask(taskId, data),
  sendMessage: (taskId: string, data: SendMessageInput) =>
    buddy().sendMessage(taskId, data),
  skipCountdown: (taskId: string, data: CountdownInput) =>
    buddy().skipCountdown(taskId, data),
  pauseCountdown: (taskId: string, data: CountdownInput) =>
    buddy().pauseCountdown(taskId, data),
  interrupt: (taskId: string, workspaceKey?: string) =>
    buddy().interrupt(taskId, workspaceKey),
  enqueueInstruction: (taskId: string, workspaceKey: string, content: string, attachments?: AttachmentMeta[]) =>
    buddy().enqueueInstruction(taskId, workspaceKey, content, attachments),
  dequeueInstruction: (taskId: string, workspaceKey: string, itemId: string) =>
    buddy().dequeueInstruction(taskId, workspaceKey, itemId),
  clearInstructionQueue: (taskId: string, workspaceKey: string) =>
    buddy().clearInstructionQueue(taskId, workspaceKey),
  interruptAndInsert: (taskId: string, workspaceKey: string, queueItemId: string) =>
    buddy().interruptAndInsert(taskId, workspaceKey, queueItemId),
  getEvents: (taskId: string, since: number, workspaceKey?: string) =>
    buddy().getEvents(taskId, since, workspaceKey),
  getRoundEvents: (taskId: string, runId: string, workspaceKey?: string, actor?: string) =>
    buddy().getRoundEvents(taskId, runId, workspaceKey, actor) as Promise<RoundEventSummary | null>,
  getTaskStats: (taskId: string, workspaceKey?: string) =>
    buddy().getTaskStats(taskId, workspaceKey) as Promise<TaskStats | null>,
  updateGlobalSettings: (settings: GlobalSettings) =>
    buddy().updateGlobalSettings(settings),
  updateGlobalSettingsPatch,
  listCursorModels: (input?: CursorModelDiscoveryInput) =>
    buddy().listCursorModels(input),
  gitStatus: (repoRoot: string) =>
    buddy().gitStatus(repoRoot),
  gitStageAll: (repoRoot: string) =>
    buddy().gitStageAll(repoRoot),
  gitCommitAndPush: (repoRoot: string, message: string, remote: string, push?: boolean) =>
    buddy().gitCommitAndPush(repoRoot, message, remote, push),
  gitDiffForCommitMessage: (repoRoot: string) =>
    buddy().gitDiffForCommitMessage(repoRoot),
  generateCommitMessage: (repoRoot: string, actorCommand?: string, lang?: string) =>
    buddy().generateCommitMessage(repoRoot, actorCommand, lang),
  testLauncher: (actor: string, command: string, env?: Record<string, string>, options?: Partial<Launcher>) =>
    buddy().testLauncher(actor, command, env, options) as Promise<TestLauncherResult>,
  onTaskEvent: (callback: (payload: TaskEventEnvelope) => void) =>
    buddy().onTaskEvent(callback)
}
