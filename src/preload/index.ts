import { contextBridge, ipcRenderer } from 'electron'
import { createBuddyPreloadApi } from './buddy-api'

const api = {
  selectDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory', defaultPath),
  openInFinder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:openInFinder', path),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:openExternal', url),
  onFullScreenChange: (callback: (isFullScreen: boolean) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) => callback(isFullScreen)
    ipcRenderer.on('window:fullScreenChange', handler)
    return () => { ipcRenderer.removeListener('window:fullScreenChange', handler) }
  },
  onMenuAction: (callback: (action: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action)
    ipcRenderer.on('menu:action', handler)
    return () => { ipcRenderer.removeListener('menu:action', handler) }
  },
  isFullScreen: (): Promise<boolean> =>
    ipcRenderer.invoke('window:isFullScreen'),
  updateMenuLanguage: (lang: string): void => {
    ipcRenderer.send('menu:updateLanguage', lang)
  },
  readClipboardFilePaths: (): Promise<Array<{ path: string; size: number }>> =>
    ipcRenderer.invoke('clipboard:readFilePaths'),
  saveAttachmentBuffer: (taskId: string, workspaceKey: string, name: string, bufferBase64: string): Promise<string> =>
    ipcRenderer.invoke('attachment:saveBuffer', taskId, workspaceKey, name, bufferBase64),
  readFileAsDataURL: (filePath: string, mimeType: string): Promise<string> =>
    ipcRenderer.invoke('attachment:readFileAsDataURL', filePath, mimeType),
  checkForUpdates: (): void => {
    ipcRenderer.invoke('updater:check')
  },
  downloadUpdate: (): void => {
    ipcRenderer.invoke('updater:download')
  },
  installUpdate: (): void => {
    ipcRenderer.invoke('updater:install')
  },
  onUpdaterEvent: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('updater:event', handler)
    return () => { ipcRenderer.removeListener('updater:event', handler) }
  }
}

const buddy = createBuddyPreloadApi(ipcRenderer)

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('buddy', buddy)

export type Api = typeof api
export type BuddyApi = typeof buddy
