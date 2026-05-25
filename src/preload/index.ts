import { contextBridge, ipcRenderer } from 'electron'

const api = {
  selectDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory', defaultPath)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
