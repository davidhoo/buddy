import { app, BrowserWindow } from 'electron'
import { WindowManager } from './window-manager'

const windowManager = new WindowManager()

app.whenReady().then(() => {
  windowManager.createWindow()

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
