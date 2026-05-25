import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { WindowManager } from './window-manager'

const windowManager = new WindowManager()

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
