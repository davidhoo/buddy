import axios, { AxiosInstance } from 'axios'
import { spawn, ChildProcess } from 'child_process'
import {
  Task,
  TaskDetail,
  HealthResponse,
  BootstrapResponse
} from '../shared/types'

export class BuddyService {
  private client: AxiosInstance
  private baseUrl: string
  private process: ChildProcess | null = null
  private isRunning = false

  constructor(host = '127.0.0.1', port = 8765) {
    this.baseUrl = `http://${host}:${port}`
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000
    })
  }

  async checkHealth(): Promise<HealthResponse | null> {
    try {
      const response = await this.client.get<HealthResponse>('/api/health')
      return response.data
    } catch {
      return null
    }
  }

  async start(): Promise<boolean> {
    const health = await this.checkHealth()
    if (health) {
      this.isRunning = true
      return true
    }

    try {
      this.process = spawn('buddy', ['serve', '--foreground'], {
        detached: true,
        stdio: 'ignore'
      })
      this.process.unref()

      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const health = await this.checkHealth()
        if (health) {
          this.isRunning = true
          return true
        }
      }
    } catch (error) {
      console.error('Failed to start buddy service:', error)
    }

    return false
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this.isRunning = false
  }

  async bootstrap(): Promise<BootstrapResponse> {
    const response = await this.client.get<BootstrapResponse>('/api/bootstrap')
    return response.data
  }

  async getTasks(): Promise<Task[]> {
    const response = await this.client.get<{ tasks: Task[] }>('/api/tasks')
    return response.data.tasks
  }

  async getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    const response = await this.client.get<TaskDetail>(
      `/api/tasks/${encodeURIComponent(taskId)}`,
      { params }
    )
    return response.data
  }

  async createTask(data: {
    task_id: string
    repo_root?: string
    task_text?: string
    context_text?: string
    settings?: Record<string, unknown>
  }): Promise<{ task: string; path: string; workspace_key: string }> {
    const response = await this.client.post('/api/tasks', data)
    return response.data
  }

  async deleteTask(taskId: string, workspaceKey?: string): Promise<void> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    await this.client.delete(`/api/tasks/${encodeURIComponent(taskId)}`, {
      params
    })
  }

  async startTask(
    taskId: string,
    data: { actor?: string; message?: string; workspace_key?: string }
  ): Promise<void> {
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/start`,
      data
    )
  }

  async sendMessage(
    taskId: string,
    data: { actor?: string; message?: string; workspace_key?: string }
  ): Promise<void> {
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/message`,
      data
    )
  }

  async skipCountdown(
    taskId: string,
    data: { next_actor?: string; workspace_key?: string }
  ): Promise<void> {
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/skip-countdown`,
      data
    )
  }

  async pauseCountdown(
    taskId: string,
    data: { next_actor?: string; workspace_key?: string }
  ): Promise<void> {
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/pause-countdown`,
      data
    )
  }

  async interrupt(taskId: string, workspaceKey?: string): Promise<void> {
    const params = workspaceKey ? { workspace: workspaceKey } : {}
    await this.client.post(
      `/api/tasks/${encodeURIComponent(taskId)}/interrupt`,
      {},
      { params }
    )
  }

  async getEvents(
    taskId: string,
    since: number,
    workspaceKey?: string
  ): Promise<{
    events: {
      seq: number
      type: string
      actor?: string
      ts: string
      payload: Record<string, unknown>
    }[]
  }> {
    const params: Record<string, string | number> = {
      task: taskId,
      since
    }
    if (workspaceKey) {
      params.workspace = workspaceKey
    }
    const response = await this.client.get('/api/events', { params })
    return response.data
  }

  isConnected(): boolean {
    return this.isRunning
  }
}
