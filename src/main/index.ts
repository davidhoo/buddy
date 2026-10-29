// Must be set before electron-updater is imported (via updater.ts)
process.env.ELECTRON_UPDATER_ALLOW_HTTP = '1'

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification } from 'electron'
import { openPathOrThrow } from './ipc/open-path'

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
import { setupMenu, updateMenuLanguage, getMenuLanguage } from './menu'
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall, setUpdaterWindow } from './updater'
import { mkdir, writeFile, stat, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentUpdateQuitGuard } from './buddy/agents/lifecycle'
import { agentUpdateCounts } from '../shared/agents'

fixShellPath()

const windowManager = new WindowManager()
const buddyEvents = new BuddyEventBus()
const buddyService = new BuddyCoreService({ events: buddyEvents })

let allowAgentQuit = false
const agentQuitGuard = new AgentUpdateQuitGuard(buddyService.agents.updates, async()=>{
  const lang=getMenuLanguage()
  const text=lang==='en'?['Agent update in progress','The current installation will finish and be verified before quitting. Remaining updates will be cancelled.','Keep updating in background','Finish current update and quit']:lang==='zh-TW'?['Agent 正在更新','退出前會完成目前安裝及驗證，並取消剩餘更新。','繼續背景更新','完成目前項目後退出']:['Agent 正在更新','退出前会完成当前安装及验证，并取消剩余更新。','继续后台更新','完成当前项后退出']
  const result=await dialog.showMessageBox({type:'question',message:text[0],detail:text[1],buttons:text.slice(2),defaultId:0,cancelId:0})
  return result.response===1?'finish':'background'
})
app.on('before-quit',event=>{
  if(allowAgentQuit)return
  event.preventDefault()
  void agentQuitGuard.request(()=>{allowAgentQuit=true;app.quit()}).catch(error=>dialog.showErrorBox('Buddy',String(error)))
})
const sendAgentState=(channel:string,state:unknown)=>{
  for(const window of BrowserWindow.getAllWindows()) {
    try {if(!window.isDestroyed())window.webContents.send(channel,state)} catch { /* A closing window must not interrupt other subscribers. */ }
  }
}
buddyService.agents.subscribe(state=>sendAgentState('buddy:agent-inventory',state))
const observedBatches=new Set<string>()
buddyService.agents.updates.subscribe(state=>{
  sendAgentState('buddy:agent-update',state)
  if(state.activeBatch)observedBatches.add(state.activeBatch.id)
  const batch=state.lastCompletedBatch
  if(!batch || !observedBatches.delete(batch.id))return
  void (async()=>{
    if(BrowserWindow.getAllWindows().some(window=>window.isFocused()))return
    if(!(await buddyService.getStore().readGlobalSettings()).system_notifications_enabled || !Notification.isSupported())return
    const counts=agentUpdateCounts(batch),lang=getMenuLanguage()
    const title=lang==='en'?'Buddy · Agent updates finished':lang==='zh-TW'?'Buddy · Agent 更新已結束':'Buddy · Agent 更新已结束'
    const body=lang==='en'?`${counts.updated} updated · ${counts.upToDate} up to date · ${counts.failed} failed`:lang==='zh-TW'?`${counts.updated} 項已更新 · ${counts.upToDate} 項已是最新 · ${counts.failed} 項失敗`:`${counts.updated} 项已更新 · ${counts.upToDate} 项已是最新 · ${counts.failed} 项失败`
    const notification=new Notification({title,body})
    notification.on('click',()=>{
      const existing=windowManager.getMainWindow()
      const window=existing && !existing.isDestroyed()?existing:windowManager.createWindow()
      window.show();window.focus()
      if(window.webContents.isLoading())window.webContents.once('did-finish-load',()=>window.webContents.send('buddy:open-agents'))
      else window.webContents.send('buddy:open-agents')
    })
    notification.show()
  })().catch(()=>{})
})
app.setName('Buddy')

registerBuddyHandlers(ipcMain, buddyService)
buddyEvents.subscribe((event) => {
  windowManager.getMainWindow()?.webContents.send('buddy:event', event)
})

app.whenReady().then(async () => {
  await buddyService.recoverInterruptedRuns()
  windowManager.createWindow()
  void buddyService.initializeAgents().catch(error => console.warn('Agent initialization failed', error instanceof Error ? error.message : 'unknown error'))
  const mainWindow = windowManager.getMainWindow()
  if (mainWindow) {
    setupMenu(mainWindow)
    initUpdater(mainWindow)
  }

  ipcMain.handle('updater:check', async () => {
    try {
      await checkForUpdates()
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await downloadUpdate()
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updater:install', async () => {
    try {
      await agentQuitGuard.request(()=>{allowAgentQuit=true;quitAndInstall()})
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
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

  ipcMain.on('menu:updateLanguage', (_event, lang: string) => {
    updateMenuLanguage(lang)
  })

  ipcMain.handle('shell:openInFinder', async (_event, path: string) => {
    await openPathOrThrow(shell.openPath.bind(shell), path)
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
