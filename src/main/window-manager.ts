import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export class WindowManager {
  private mainWindow: BrowserWindow | null = null

  createWindow(): BrowserWindow {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1000,
      minHeight: 600,
      show: false,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 19 },
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    this.mainWindow.on('ready-to-show', () => {
      this.mainWindow?.show()
    })

    this.mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    // Intercept in-app navigation (e.g. <a> tag clicks) and open in system browser
    this.mainWindow.webContents.on('will-navigate', (event, url) => {
      const isLocal = url.startsWith('file://') ||
        (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? ''))
      if (!isLocal) {
        event.preventDefault()
        shell.openExternal(url)
      }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    this.mainWindow.on('enter-full-screen', () => {
      this.mainWindow?.webContents.send('window:fullScreenChange', true)
    })

    this.mainWindow.on('leave-full-screen', () => {
      this.mainWindow?.webContents.send('window:fullScreenChange', false)
    })

    return this.mainWindow
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }
}
