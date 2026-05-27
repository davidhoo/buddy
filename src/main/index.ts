import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { WindowManager } from './window-manager'
import { registerBuddyHandlers } from './ipc/buddy-handlers'
import { BuddyCoreService } from './buddy/service'
import { BuddyEventBus } from './buddy/events'

const windowManager = new WindowManager()
const buddyEvents = new BuddyEventBus()
const buddyService = new BuddyCoreService({ events: buddyEvents })

app.setName('Buddy')

registerBuddyHandlers(ipcMain, buddyService)
buddyEvents.subscribe((event) => {
  windowManager.getMainWindow()?.webContents.send('buddy:event', event)
})

app.whenReady().then(async () => {
  await buddyService.recoverInterruptedRuns()
  windowManager.createWindow()

  ipcMain.handle('dialog:selectDirectory', async (_event, defaultPath?: string) => {
    const win = windowManager.getMainWindow()
    const dialogOptions: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath
    }
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
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
