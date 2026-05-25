import { contextBridge } from 'electron'

const api = {
  // 后续添加 API
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
