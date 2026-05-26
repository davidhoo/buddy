import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { WindowManager } from './window-manager'
import {
  BuddyHandlerService,
  registerBuddyHandlers
} from './ipc/buddy-handlers'

const windowManager = new WindowManager()
const notImplemented = async (): Promise<never> => {
  throw new Error('Native Buddy Core is not implemented yet')
}

const buddyService: BuddyHandlerService = {
  checkHealth: async () => true,
  bootstrap: async () => ({
    version: 'native',
    repo_root: '',
    data_root: '',
    tasks: []
  }),
  getTasks: async () => [],
  getTaskDetail: notImplemented,
  createTask: notImplemented,
  deleteTask: notImplemented,
  startTask: notImplemented,
  sendMessage: notImplemented,
  skipCountdown: notImplemented,
  pauseCountdown: notImplemented,
  interrupt: notImplemented,
  getEvents: async () => ({ events: [] }),
  updateGlobalSettings: async (settings) => settings
}

registerBuddyHandlers(ipcMain, buddyService)

app.whenReady().then(() => {
  windowManager.createWindow()

  ipcMain.handle('dialog:selectDirectory', async (_event, defaultPath?: string) => {
    const win = windowManager.getMainWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          properties: ['openDirectory'],
          defaultPath
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory'],
          defaultPath
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('window:isFullScreen', () => {
    return windowManager.getMainWindow()?.isFullScreen() ?? false
  })

  ipcMain.handle('shell:openInFinder', async (_event, path: string) => {
    await shell.openPath(path)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
