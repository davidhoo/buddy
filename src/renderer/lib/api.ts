import type {
  CountdownInput,
  CreateTaskInput,
  GlobalSettings,
  SendMessageInput,
  StartTaskInput
} from '../../shared/types'

function buddy() {
  if (!window.buddy) {
    throw new Error('Native Buddy API is unavailable')
  }
  return window.buddy
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
  getEvents: (taskId: string, since: number, workspaceKey?: string) =>
    buddy().getEvents(taskId, since, workspaceKey),
  updateGlobalSettings: (settings: GlobalSettings) =>
    buddy().updateGlobalSettings(settings),
  gitStatus: (repoRoot: string) =>
    buddy().gitStatus(repoRoot),
  gitStageAll: (repoRoot: string) =>
    buddy().gitStageAll(repoRoot),
  gitCommitAndPush: (repoRoot: string, message: string, remote: string) =>
    buddy().gitCommitAndPush(repoRoot, message, remote),
  gitDiffForCommitMessage: (repoRoot: string) =>
    buddy().gitDiffForCommitMessage(repoRoot),
  generateCommitMessage: (repoRoot: string, actorCommand?: string, lang?: string) =>
    buddy().generateCommitMessage(repoRoot, actorCommand, lang)
}
