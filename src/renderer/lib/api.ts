import axios from 'axios'
import { Task, TaskDetail, BootstrapResponse, Event, GlobalSettings } from '../../shared/types'

const client = axios.create({
  baseURL: '/api',
  timeout: 10000
})

// 添加请求拦截器用于调试
client.interceptors.request.use(
  (config) => {
    console.log('[API] Request:', config.method?.toUpperCase(), config.url)
    return config
  },
  (error) => {
    console.error('[API] Request Error:', error)
    return Promise.reject(error)
  }
)

// 添加响应拦截器用于调试
client.interceptors.response.use(
  (response) => {
    console.log('[API] Response:', response.status, response.config.url)
    return response
  },
  (error) => {
    console.error('[API] Response Error:', error.message, error.config?.url)
    return Promise.reject(error)
  }
)

export const api = {
  async checkHealth(): Promise<boolean> {
    try {
      const response = await client.get('/health')
      console.log('[API] Health check success:', response.data)
      return true
    } catch (error) {
      console.error('[API] Health check failed:', error)
      return false
    }
  },

  async bootstrap(): Promise<BootstrapResponse> {
    const response = await client.get('/bootstrap')
    return response.data
  },

  async getTasks(): Promise<Task[]> {
    const response = await client.get('/tasks')
    return response.data.tasks
  },

  async getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    const response = await client.get(`/tasks/${encodeURIComponent(taskId)}`, { params })
    return response.data
  },

  async createTask(data: {
    task_id: string
    repo_root?: string
    task_text?: string
    context_text?: string
    settings?: Record<string, unknown>
  }): Promise<{ task: string; path: string; workspace_key: string }> {
    const response = await client.post('/tasks', data)
    return response.data
  },

  async deleteTask(taskId: string, workspaceKey?: string): Promise<void> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    await client.delete(`/tasks/${encodeURIComponent(taskId)}`, { params })
  },

  async startTask(
    taskId: string,
    data: { actor?: string; message?: string; workspace_key?: string }
  ): Promise<void> {
    await client.post(`/tasks/${encodeURIComponent(taskId)}/start`, data)
  },

  async sendMessage(
    taskId: string,
    data: { actor?: string; message?: string; workspace_key?: string }
  ): Promise<void> {
    await client.post(`/tasks/${encodeURIComponent(taskId)}/message`, data)
  },

  async skipCountdown(
    taskId: string,
    data: { next_actor?: string; workspace_key?: string }
  ): Promise<void> {
    await client.post(`/tasks/${encodeURIComponent(taskId)}/skip-countdown`, data)
  },

  async pauseCountdown(
    taskId: string,
    data: { next_actor?: string; workspace_key?: string }
  ): Promise<void> {
    await client.post(`/tasks/${encodeURIComponent(taskId)}/pause-countdown`, data)
  },

  async interrupt(taskId: string, workspaceKey?: string): Promise<void> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    await client.post(`/tasks/${encodeURIComponent(taskId)}/interrupt`, {}, { params })
  },

  async getEvents(
    taskId: string,
    since: number,
    workspaceKey?: string
  ): Promise<{ events: Event[] }> {
    const params: Record<string, string | number> = { task: taskId, since }
    if (workspaceKey) params.workspace = workspaceKey
    const response = await client.get('/events', { params })
    return response.data
  },

  async updateGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
    const response = await client.post('/global-settings', settings)
    return response.data
  }
}
