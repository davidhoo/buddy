import type { IpcMain } from 'electron'
import type {
  CountdownInput,
  CreateTaskInput,
  GlobalSettings,
  SendMessageInput,
  StartTaskInput
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
  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<unknown>
  updateGlobalSettings(settings: GlobalSettings): Promise<unknown>
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
  ipcMain.handle('buddy:getEvents', (_event, taskId: string, since: number, workspaceKey?: string) =>
    service.getEvents(taskId, since, workspaceKey)
  )
  ipcMain.handle('buddy:updateGlobalSettings', (_event, settings: GlobalSettings) =>
    service.updateGlobalSettings(settings)
  )
}
