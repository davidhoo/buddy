import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  BootstrapResponse,
  CountdownInput,
  CreateTaskInput,
  CreateTaskResult,
  Event,
  GlobalSettings,
  SendMessageInput,
  StartTaskInput,
  Task,
  TaskDetail
} from '../../shared/types'
import { BuddyEventBus } from './events'
import { BuddyRunner } from './runner'
import { BuddyStore } from './store'

export interface BuddyCoreServiceOptions {
  dataRoot?: string
  events?: BuddyEventBus
}

export class BuddyCoreService {
  private readonly store: BuddyStore
  private readonly runner: BuddyRunner
  private readonly events?: BuddyEventBus

  constructor(options: BuddyCoreServiceOptions | string = {}) {
    const normalized = typeof options === 'string' ? { dataRoot: options } : options
    this.events = normalized.events
    this.store = new BuddyStore(normalized.dataRoot ?? defaultDataRoot())
    this.runner = new BuddyRunner(this.store)
  }

  async checkHealth(): Promise<boolean> {
    return true
  }

  async bootstrap(): Promise<BootstrapResponse> {
    return {
      version: 'native',
      repo_root: '',
      data_root: this.store.dataRoot,
      tasks: await this.store.getTasks(),
      global_settings: await this.store.readGlobalSettings()
    }
  }

  getTasks(): Promise<Task[]> {
    return this.store.getTasks()
  }

  getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getTaskDetail(taskId, workspaceKey)
  }

  createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    return this.store.createTask(input)
  }

  deleteTask(taskId: string, workspaceKey?: string): Promise<void> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.deleteTask(taskId, workspaceKey)
  }

  async startTask(taskId: string, input: StartTaskInput): Promise<void> {
    await this.runner.startTask(taskId, input)
  }

  sendMessage(taskId: string, input: SendMessageInput): Promise<void> {
    return this.runner.sendMessage(taskId, input)
  }

  async skipCountdown(taskId: string, input: CountdownInput): Promise<void> {
    await this.runner.skipCountdown(taskId, input)
  }

  pauseCountdown(taskId: string, input: CountdownInput): Promise<void> {
    return this.runner.pauseCountdown(taskId, input)
  }

  interrupt(taskId: string, workspaceKey?: string): Promise<void> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.runner.interrupt(taskId, workspaceKey)
  }

  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<{ events: Event[] }> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getEvents(taskId, since, workspaceKey)
  }

  updateGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
    return this.store.updateGlobalSettings(settings)
  }

  async recoverInterruptedRuns(): Promise<void> {
    const tasks = await this.store.getTasks()
    for (const task of tasks) {
      if (task.status.startsWith('RUNNING_')) {
        const event = await this.store.appendTaskEvent(task.task_id, task.workspace_key, {
          type: 'actor.interrupted',
          payload: { reason: 'app_restarted' }
        })
        await this.store.updateTaskState(task.task_id, task.workspace_key, (state) => ({
          ...state,
          status: 'PAUSED',
          active_run: null,
          updated_at: new Date().toISOString()
        }))
        this.events?.publish({
          workspace_key: task.workspace_key,
          task_id: task.task_id,
          event
        })
      }
    }
  }
}

function defaultDataRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'Buddy')
}
