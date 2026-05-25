import { BrowserWindow, shell, session } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const BUDDY_API_ORIGIN = 'http://127.0.0.1:8765'

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

    this.setupApiProxy()

    return this.mainWindow
  }

  private setupApiProxy(): void {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['file:///api/*'] },
      (details, callback) => {
        const url = new URL(details.url)
        const redirectURL = `${BUDDY_API_ORIGIN}${url.pathname}${url.search}`
        callback({ redirectURL })
      }
    )
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }
}
