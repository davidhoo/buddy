import type { IpcMain } from 'electron'
import type {
  AttachmentMeta,
  CountdownInput,
  CreateTaskInput,
  CursorModelCatalog,
  CursorModelDiscoveryInput,
  GlobalSettings,
  Launcher,
  RoundEventSummary,
  SendMessageInput,
  StartTaskInput,
  TaskStats,
  TestLauncherResult
} from '../../shared/types'

export interface BuddyHandlerService {
  checkHealth(): Promise<boolean>
  bootstrap(): Promise<unknown>
  getTasks(): Promise<unknown>
  getTaskDetail(taskId: string, workspaceKey?: string): Promise<unknown>
  createTask(input: CreateTaskInput): Promise<unknown>
  deleteTask(taskId: string, workspaceKey?: string): Promise<void>
  startTask(taskId: string, input: StartTaskInput): Promise<void>
  sendMessage(taskId: string, input: SendMessageInput): Promise<void>
  skipCountdown(taskId: string, input: CountdownInput): Promise<void>
  pauseCountdown(taskId: string, input: CountdownInput): Promise<void>
  interrupt(taskId: string, workspaceKey?: string): Promise<void>
  enqueueInstruction(taskId: string, workspaceKey: string, content: string, attachments?: AttachmentMeta[]): Promise<unknown>
  dequeueInstruction(taskId: string, workspaceKey: string, itemId: string): Promise<void>
  clearInstructionQueue(taskId: string, workspaceKey: string): Promise<void>
  interruptAndInsert(taskId: string, workspaceKey: string, queueItemId: string): Promise<void>
  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<unknown>
  getRoundEvents(taskId: string, runId: string, workspaceKey?: string, actor?: string): Promise<RoundEventSummary | null>
  getTaskStats(taskId: string, workspaceKey?: string, throughRound?: number): Promise<TaskStats | null>
  updateGlobalSettings(settings: GlobalSettings): Promise<unknown>
  listCursorModels(input?: CursorModelDiscoveryInput): Promise<CursorModelCatalog>
  gitStatus(repoRoot: string): Promise<unknown>
  gitStageAll(repoRoot: string): Promise<void>
  gitCommitAndPush(repoRoot: string, message: string, remote: string, push?: boolean): Promise<unknown>
  gitDiffForCommitMessage(repoRoot: string): Promise<string>
  generateCommitMessage(repoRoot: string, actorCommand?: string, lang?: string): Promise<string>
  testLauncher(actor: string, command: string, env?: Record<string, string>, options?: Partial<Launcher>): Promise<TestLauncherResult>
  updateTaskText(taskId: string, workspaceKey: string, taskText: string): Promise<void>
}

type IpcHandle = Pick<IpcMain, 'handle'>

export function registerBuddyHandlers(ipcMain: IpcHandle, service: BuddyHandlerService): void {
  ipcMain.handle('buddy:checkHealth', () => service.checkHealth())
  ipcMain.handle('buddy:bootstrap', () => service.bootstrap())
  ipcMain.handle('buddy:getTasks', () => service.getTasks())
  ipcMain.handle('buddy:getTaskDetail', (_event, taskId: string, workspaceKey?: string) =>
    service.getTaskDetail(taskId, workspaceKey)
  )
  ipcMain.handle('buddy:createTask', (_event, input: CreateTaskInput) =>
    service.createTask(input)
  )
  ipcMain.handle('buddy:deleteTask', (_event, taskId: string, workspaceKey?: string) =>
    service.deleteTask(taskId, workspaceKey)
  )
  ipcMain.handle('buddy:startTask', (_event, taskId: string, input: StartTaskInput) =>
    service.startTask(taskId, input)
  )
  ipcMain.handle('buddy:sendMessage', (_event, taskId: string, input: SendMessageInput) =>
    service.sendMessage(taskId, input)
  )
  ipcMain.handle('buddy:skipCountdown', (_event, taskId: string, input: CountdownInput) =>
    service.skipCountdown(taskId, input)
  )
  ipcMain.handle('buddy:pauseCountdown', (_event, taskId: string, input: CountdownInput) =>
    service.pauseCountdown(taskId, input)
  )
  ipcMain.handle('buddy:interrupt', (_event, taskId: string, workspaceKey?: string) =>
    service.interrupt(taskId, workspaceKey)
  )
  ipcMain.handle('buddy:enqueueInstruction', (_event, taskId: string, workspaceKey: string, content: string, attachments?: AttachmentMeta[]) =>
    service.enqueueInstruction(taskId, workspaceKey, content, attachments)
  )
  ipcMain.handle('buddy:dequeueInstruction', (_event, taskId: string, workspaceKey: string, itemId: string) =>
    service.dequeueInstruction(taskId, workspaceKey, itemId)
  )
  ipcMain.handle('buddy:clearInstructionQueue', (_event, taskId: string, workspaceKey: string) =>
    service.clearInstructionQueue(taskId, workspaceKey)
  )
  ipcMain.handle('buddy:interruptAndInsert', (_event, taskId: string, workspaceKey: string, queueItemId: string) =>
    service.interruptAndInsert(taskId, workspaceKey, queueItemId)
  )
  ipcMain.handle('buddy:getEvents', (_event, taskId: string, since: number, workspaceKey?: string) =>
    service.getEvents(taskId, since, workspaceKey)
  )
  ipcMain.handle('buddy:getRoundEvents', (_event, taskId: string, runId: string, workspaceKey?: string, actor?: string) =>
    service.getRoundEvents(taskId, runId, workspaceKey, actor)
  )
  ipcMain.handle('buddy:getTaskStats', (_event, taskId: string, workspaceKey?: string, throughRound?: number) =>
    service.getTaskStats(taskId, workspaceKey, throughRound)
  )
  ipcMain.handle('buddy:updateGlobalSettings', (_event, settings: GlobalSettings) =>
    service.updateGlobalSettings(settings)
  )
  ipcMain.handle('buddy:listCursorModels', (_event, input?: CursorModelDiscoveryInput) =>
    service.listCursorModels(input)
  )
  ipcMain.handle('buddy:gitStatus', (_event, repoRoot: string) =>
    service.gitStatus(repoRoot)
  )
  ipcMain.handle('buddy:gitStageAll', (_event, repoRoot: string) =>
    service.gitStageAll(repoRoot)
  )
  ipcMain.handle('buddy:gitCommitAndPush', (_event, repoRoot: string, message: string, remote: string, push?: boolean) =>
    service.gitCommitAndPush(repoRoot, message, remote, push)
  )
  ipcMain.handle('buddy:gitDiffForCommitMessage', (_event, repoRoot: string) =>
    service.gitDiffForCommitMessage(repoRoot)
  )
  ipcMain.handle('buddy:generateCommitMessage', (_event, repoRoot: string, actorCommand?: string, lang?: string) =>
    service.generateCommitMessage(repoRoot, actorCommand, lang)
  )
  ipcMain.handle('buddy:testLauncher', (_event, actor: string, command: string, env?: Record<string, string>, options?: Partial<Launcher>) =>
    service.testLauncher(actor, command, env, options)
  )
  ipcMain.handle('buddy:updateTaskText', (_event, taskId: string, workspaceKey: string, taskText: string) =>
    service.updateTaskText(taskId, workspaceKey, taskText)
  )
}
