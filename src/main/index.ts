// Must be set before electron-updater is imported (via updater.ts)
process.env.ELECTRON_UPDATER_ALLOW_HTTP = '1'

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron'

// Guard against EPIPE and other stream errors crashing the main process.
// Child processes (e.g. wecode) may exit early during auto-upgrade, closing
// their stdin pipe before we finish writing. Node emits 'write EPIPE' as an
// uncaught exception in that case. Log and swallow rather than crash.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    console.error('[main] EPIPE (child pipe closed early, likely wecode auto-upgrade):', err.message)
    return
  }
  console.error('[main] Uncaught exception:', err)
})

import { WindowManager } from './window-manager'
import { registerBuddyHandlers } from './ipc/buddy-handlers'
import { BuddyCoreService } from './buddy/service'
import { BuddyEventBus } from './buddy/events'
import { fixShellPath } from './buddy/shell-path'
import { setupMenu, updateMenuLanguage } from './menu'
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall, setUpdaterWindow } from './updater'
import { mkdir, writeFile, stat, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

fixShellPath()

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
  const mainWindow = windowManager.getMainWindow()
  if (mainWindow) {
    setupMenu(mainWindow)
    initUpdater(mainWindow)
  }

  ipcMain.handle('updater:check', () => {
    checkForUpdates()
  })

  ipcMain.handle('updater:download', () => {
    downloadUpdate()
  })

  ipcMain.handle('updater:install', () => {
    quitAndInstall()
  })

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

  ipcMain.handle('find:start', (_event, text: string, options?: Electron.FindInPageOptions) => {
    const win = windowManager.getMainWindow()
    if (!win || !text) return null
    return win.webContents.findInPage(text, options)
  })

  ipcMain.handle('find:stop', (_event, action: 'clearSelection' | 'keepSelection' = 'clearSelection') => {
    windowManager.getMainWindow()?.webContents.stopFindInPage(action)
  })

  ipcMain.on('menu:updateLanguage', (_event, lang: string) => {
    updateMenuLanguage(lang)
  })

  ipcMain.handle('shell:openInFinder', async (_event, path: string) => {
    await shell.openPath(path)
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  ipcMain.handle('clipboard:readFilePaths', async () => {
    if (process.platform !== 'darwin') return []
    try {
      // Prefer NSFilenamesPboardType which contains real POSIX paths
      if (clipboard.has('NSFilenamesPboardType')) {
        const buffer = clipboard.readBuffer('NSFilenamesPboardType')
        const text = buffer.toString('utf8')
        const paths: string[] = []

        // Try XML plist format first
        if (text.includes('<string>')) {
          const matches = text.match(/<string>([^<]+)<\/string>/g)
          if (matches) {
            for (const m of matches) {
              const p = m.replace(/<\/?string>/g, '').trim()
              if (p.startsWith('/')) paths.push(p)
            }
          }
        }

        // Binary plist: extract null-separated path strings
        if (paths.length === 0 && buffer.length > 0) {
          const raw = buffer.toString('utf8')
          const parts = raw.split(/\0|\n/)
          for (const part of parts) {
            const p = part.trim()
            if (p.startsWith('/') && !p.includes('�')) {
              paths.push(p)
            }
          }
        }

        if (paths.length > 0) {
          const results: Array<{ path: string; size: number }> = []
          for (const p of paths) {
            try {
              const s = await stat(p)
              results.push({ path: p, size: s.size })
            } catch {
              results.push({ path: p, size: 0 })
            }
          }
          return results
        }
      }

      // Fallback to public.file-url
      if (!clipboard.has('public.file-url')) return []
      const buffer = clipboard.readBuffer('public.file-url')
      const text = buffer.toString('utf8')
      const paths = text.split('\0')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)
        .map((url: string) => {
          try { return decodeURIComponent(new URL(url).pathname) }
          catch { return url }
        })
      const results: Array<{ path: string; size: number }> = []
      for (const p of paths) {
        try {
          const resolved = await realpath(p)
          const s = await stat(resolved)
          results.push({ path: resolved, size: s.size })
        } catch {
          // Skip unresolvable .file/id= references
        }
      }
      return results
    } catch {
      return []
    }
  })

  ipcMain.handle('attachment:saveBuffer', async (_event, taskId: string, workspaceKey: string, name: string, bufferBase64: string) => {
    const taskDirPath = buddyService.getStore().taskDirectory(taskId, workspaceKey)
    const artifactsDir = join(taskDirPath, 'attachments')
    await mkdir(artifactsDir, { recursive: true })
    const ext = name.includes('.') ? '.' + name.split('.').pop() : ''
    const filename = `${randomUUID()}${ext}`
    const filePath = join(artifactsDir, filename)
    await writeFile(filePath, Buffer.from(bufferBase64, 'base64'))
    return filePath
  })

  ipcMain.handle('attachment:readFileAsDataURL', async (_event, filePath: string, mimeType: string) => {
    const buffer = await readFile(filePath)
    const base64 = buffer.toString('base64')
    return `data:${mimeType};base64,${base64}`
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createWindow()
      const mainWindow = windowManager.getMainWindow()
      if (mainWindow) {
        setupMenu(mainWindow)
        setUpdaterWindow(mainWindow)
      }
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
