import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  CountdownInput,
  CreateTaskInput,
  CreateTaskResult,
  Event,
  GlobalSettings,
  InstructionQueueItem,
  SendMessageInput,
  StartTaskInput,
  Task,
  TaskDetail,
  TaskStats
} from '../../shared/types'
import { BuddyEventBus } from './events'
import { QueueCoordinator } from './queue-coordinator'
import { BuddyRunner } from './runner'
import { BuddyStore } from './store'

export interface CliPingResult {
  ok: true
  pid: number
  dataRoot: string
  mode: 'app' | 'local'
}

export interface CliServerDiscoveryInfo {
  pid: number
  socketPath: string
  dataRoot: string
  startedAt: string
}

export interface CliRpcRequest {
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface CliRpcResponse {
  id: string | null
  ok: boolean
  result?: unknown
  error?: string
}

export interface CliBackend {
  readonly mode: 'app' | 'local'
  readonly dataRoot: string
  ping(): Promise<CliPingResult>
  getTasks(): Promise<Task[]>
  getTaskDetail(taskId: string, workspaceKey: string): Promise<TaskDetail>
  getTaskStats(taskId: string, workspaceKey: string): Promise<TaskStats | null>
  getEvents(taskId: string, since: number, workspaceKey: string): Promise<{ events: Event[] }>
  readGlobalSettings(): Promise<GlobalSettings>
  createTask(
    input: CreateTaskInput,
    options?: { autoStart?: boolean; background?: boolean }
  ): Promise<CreateTaskResult>
  startTask(
    taskId: string,
    input: StartTaskInput,
    options?: { background?: boolean }
  ): Promise<{ started: boolean }>
  sendMessage(
    taskId: string,
    input: SendMessageInput,
    options?: { background?: boolean }
  ): Promise<{ sent: boolean }>
  enqueueInstruction(taskId: string, workspaceKey: string, content: string): Promise<InstructionQueueItem>
  skipCountdown(
    taskId: string,
    input: CountdownInput,
    options?: { background?: boolean }
  ): Promise<void>
  pauseCountdown(taskId: string, input: CountdownInput): Promise<void>
  interrupt(taskId: string, workspaceKey: string): Promise<void>
  cancelTask(taskId: string, workspaceKey: string): Promise<void>
  deleteTask(taskId: string, workspaceKey: string): Promise<void>
  reconcileWorkspace?(workspaceKey: string): Promise<void>
}

export function defaultCliDataRoot(): string {
  return process.env.BUDDY_DATA_ROOT || join(homedir(), 'Library', 'Application Support', 'buddy')
}

export function socketPathForDataRoot(dataRoot: string): string {
  const digest = createHash('sha256').update(resolve(dataRoot)).digest('hex').slice(0, 12)
  return join(tmpdir(), `buddy-ipc-${digest}.sock`)
}

export function discoveryPathForDataRoot(dataRoot: string): string {
  return join(dataRoot, 'runtime', 'cli-server.json')
}

export function workerLockPath(dataRoot: string, workspaceKey: string, taskId: string): string {
  return join(dataRoot, 'runtime', 'tasks', `${workspaceKey}__${taskId}.worker.json`)
}

export function runLockPath(dataRoot: string, workspaceKey: string, taskId: string): string {
  return join(dataRoot, 'runtime', 'tasks', `${workspaceKey}__${taskId}.lock`)
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function readLiveLockPid(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { pid?: unknown }
    if (typeof parsed.pid === 'number') {
      return isPidAlive(parsed.pid)
    }
    return false
  } catch {
    return false
  }
}

export async function isTaskRunActiveOnDisk(
  dataRoot: string,
  workspaceKey: string,
  taskId: string
): Promise<boolean> {
  const [hasRunLock, hasWorkerLock] = await Promise.all([
    readLiveLockPid(runLockPath(dataRoot, workspaceKey, taskId)),
    readLiveLockPid(workerLockPath(dataRoot, workspaceKey, taskId))
  ])
  return hasRunLock || hasWorkerLock
}

export async function writeWorkerLock(
  dataRoot: string,
  workspaceKey: string,
  taskId: string,
  pid: number
): Promise<string> {
  const path = workerLockPath(dataRoot, workspaceKey, taskId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ pid, workspace_key: workspaceKey, task_id: taskId, started_at: new Date().toISOString() }))
  return path
}

export async function removeWorkerLock(path: string): Promise<void> {
  await rm(path, { force: true })
}

export class BuddyCliSocketClient implements CliBackend {
  readonly mode = 'app' as const

  constructor(
    readonly dataRoot: string,
    readonly socketPath: string
  ) {}

  private request<T>(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    const id = randomUUID()
    const payload: CliRpcRequest = { id, method, params }
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let settled = false
      let buffer = ''
      const socket = createConnection(this.socketPath)

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        rejectPromise(new Error(`Buddy IPC request timed out (${method})`))
      }, timeoutMs)

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.end()
        fn()
      }

      socket.on('connect', () => {
        socket.write(`${JSON.stringify(payload)}\n`)
      })

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex === -1) return
        const line = buffer.slice(0, newlineIndex).trim()
        if (!line) return
        try {
          const response = JSON.parse(line) as CliRpcResponse
          if (response.ok) {
            finish(() => resolvePromise(response.result as T))
          } else {
            finish(() => rejectPromise(new Error(response.error || `IPC error (${method})`)))
          }
        } catch (err) {
          finish(() => rejectPromise(err instanceof Error ? err : new Error(String(err))))
        }
      })

      socket.on('error', (err) => {
        finish(() => rejectPromise(err))
      })

      socket.on('end', () => {
        if (!settled) {
          finish(() => rejectPromise(new Error(`Buddy IPC connection closed before response (${method})`)))
        }
      })
    })
  }

  ping(): Promise<CliPingResult> {
    return this.request<CliPingResult>('ping', undefined, 500)
  }

  getTasks(): Promise<Task[]> {
    return this.request<Task[]>('getTasks')
  }

  getTaskDetail(taskId: string, workspaceKey: string): Promise<TaskDetail> {
    return this.request<TaskDetail>('getTaskDetail', { taskId, workspaceKey })
  }

  getTaskStats(taskId: string, workspaceKey: string): Promise<TaskStats | null> {
    return this.request<TaskStats | null>('getTaskStats', { taskId, workspaceKey })
  }

  getEvents(taskId: string, since: number, workspaceKey: string): Promise<{ events: Event[] }> {
    return this.request<{ events: Event[] }>('getEvents', { taskId, since, workspaceKey })
  }

  readGlobalSettings(): Promise<GlobalSettings> {
    return this.request<GlobalSettings>('readGlobalSettings')
  }

  createTask(
    input: CreateTaskInput,
    options?: { autoStart?: boolean; background?: boolean }
  ): Promise<CreateTaskResult> {
    return this.request<CreateTaskResult>('createTask', {
      input,
      autoStart: options?.autoStart
    })
  }

  startTask(
    taskId: string,
    input: StartTaskInput,
    options?: { background?: boolean }
  ): Promise<{ started: boolean }> {
    const background = options?.background ?? true
    return this.request<{ started: boolean }>(
      'startTask',
      { taskId, input, background },
      background ? 15000 : 24 * 60 * 60 * 1000
    )
  }

  sendMessage(
    taskId: string,
    input: SendMessageInput,
    options?: { background?: boolean }
  ): Promise<{ sent: boolean }> {
    const background = options?.background ?? true
    return this.request<{ sent: boolean }>(
      'sendMessage',
      { taskId, input, background },
      background ? 15000 : 24 * 60 * 60 * 1000
    )
  }

  enqueueInstruction(taskId: string, workspaceKey: string, content: string): Promise<InstructionQueueItem> {
    return this.request<InstructionQueueItem>('enqueueInstruction', { taskId, workspaceKey, content })
  }

  async skipCountdown(
    taskId: string,
    input: CountdownInput,
    options?: { background?: boolean }
  ): Promise<void> {
    const background = options?.background ?? true
    await this.request('skipCountdown', { taskId, input, background })
  }

  async pauseCountdown(taskId: string, input: CountdownInput): Promise<void> {
    await this.request('pauseCountdown', { taskId, input })
  }

  async interrupt(taskId: string, workspaceKey: string): Promise<void> {
    await this.request('interrupt', { taskId, workspaceKey })
  }

  async cancelTask(taskId: string, workspaceKey: string): Promise<void> {
    await this.request('cancelTask', { taskId, workspaceKey })
  }

  async deleteTask(taskId: string, workspaceKey: string): Promise<void> {
    await this.request('deleteTask', { taskId, workspaceKey })
  }
}

export interface LocalBackendOptions {
  executeLaunchers?: boolean
  spawnWorker?: (args: string[], taskMeta?: { workspaceKey: string; taskId: string }) => Promise<void>
}

export class BuddyCliLocalBackend implements CliBackend {
  readonly mode = 'local' as const
  readonly store: BuddyStore
  readonly events: BuddyEventBus
  readonly runner: BuddyRunner
  readonly coordinator: QueueCoordinator
  private readonly spawnWorkerImpl: (args: string[], taskMeta?: { workspaceKey: string; taskId: string }) => Promise<void>

  constructor(
    readonly dataRoot: string,
    options: LocalBackendOptions = {}
  ) {
    this.store = new BuddyStore(dataRoot)
    this.events = new BuddyEventBus()
    this.runner = new BuddyRunner(this.store, {
      executeLaunchers: options.executeLaunchers,
      events: this.events
    })
    this.coordinator = new QueueCoordinator({
      store: this.store,
      runner: this.runner,
      events: this.events
    })
    this.runner.onTaskTerminal = (workspaceKey) => {
      void this.coordinator.onTaskTerminal(workspaceKey)
    }
    this.spawnWorkerImpl = options.spawnWorker ?? ((args, taskMeta) => this.spawnDetachedWorker(args, taskMeta))
  }

  async ping(): Promise<CliPingResult> {
    return {
      ok: true,
      pid: process.pid,
      dataRoot: this.dataRoot,
      mode: 'local'
    }
  }

  getTasks(): Promise<Task[]> {
    return this.store.getTasks()
  }

  getTaskDetail(taskId: string, workspaceKey: string): Promise<TaskDetail> {
    return this.store.getTaskDetail(taskId, workspaceKey)
  }

  getTaskStats(taskId: string, workspaceKey: string): Promise<TaskStats | null> {
    return this.store.getTaskStats(taskId, workspaceKey)
  }

  getEvents(taskId: string, since: number, workspaceKey: string): Promise<{ events: Event[] }> {
    return this.store.getEvents(taskId, since, workspaceKey)
  }

  readGlobalSettings(): Promise<GlobalSettings> {
    return this.store.readGlobalSettings()
  }

  async createTask(
    input: CreateTaskInput,
    options?: { autoStart?: boolean; background?: boolean }
  ): Promise<CreateTaskResult> {
    const created = await this.store.createTask(input)
    const shouldAutoStart = options?.autoStart !== false
    const background = options?.background ?? true

    if (shouldAutoStart) {
      if ((input.execution_mode ?? 'immediate') === 'queued') {
        if (background) {
          await this.spawnWorkerImpl([
            '_worker',
            '--data-root', this.dataRoot,
            '--reconcile', created.workspace_key
          ])
        } else {
          await this.coordinator.reconcile(created.workspace_key)
        }
      } else if ((input.task_text ?? '').trim().length > 0) {
        if (background) {
          await this.spawnWorkerImpl(
            [
              '_worker',
              '--data-root', this.dataRoot,
              '--task-id', created.task,
              '--workspace', created.workspace_key
            ],
            { workspaceKey: created.workspace_key, taskId: created.task }
          )
        } else {
          await this.startTask(
            created.task,
            { workspace_key: created.workspace_key },
            { background: false }
          )
        }
      }
    }

    return created
  }

  async startTask(
    taskId: string,
    input: StartTaskInput,
    options?: { background?: boolean }
  ): Promise<{ started: boolean }> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const state = await this.store.readTaskState(taskId, input.workspace_key).catch(() => null)
    if (state?.status === 'CANCELLED') throw new Error('Task has been cancelled')

    const background = options?.background ?? true
    if (background) {
      const workerArgs = [
        '_worker',
        '--data-root', this.dataRoot,
        '--task-id', taskId,
        '--workspace', input.workspace_key
      ]
      if (input.actor) workerArgs.push('--actor', input.actor)
      if (input.message) workerArgs.push('--message', input.message)
      await this.spawnWorkerImpl(workerArgs, { workspaceKey: input.workspace_key, taskId })
      return { started: true }
    }

    if (state && state.execution_mode === 'queued') {
      await this.coordinator.startQueuedNow(taskId, input.workspace_key)
      return { started: true }
    }

    await this.runner.startTask(taskId, input)
    await this.coordinator.reconcile(input.workspace_key)
    return { started: true }
  }

  async sendMessage(
    taskId: string,
    input: SendMessageInput,
    options?: { background?: boolean }
  ): Promise<{ sent: boolean }> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const background = options?.background ?? true
    if (background) {
      const workerArgs = [
        '_worker',
        '--data-root', this.dataRoot,
        '--task-id', taskId,
        '--workspace', input.workspace_key,
        '--send',
        '--message', input.message ?? ''
      ]
      if (input.actor) workerArgs.push('--actor', input.actor)
      await this.spawnWorkerImpl(workerArgs, { workspaceKey: input.workspace_key, taskId })
      return { sent: true }
    }

    await this.runner.sendMessage(taskId, input)
    return { sent: true }
  }

  enqueueInstruction(taskId: string, workspaceKey: string, content: string): Promise<InstructionQueueItem> {
    return this.runner.enqueueInstruction(taskId, workspaceKey, content)
  }

  async skipCountdown(
    taskId: string,
    input: CountdownInput,
    options?: { background?: boolean }
  ): Promise<void> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const background = options?.background ?? true
    if (background) {
      const workerArgs = [
        '_worker',
        '--data-root', this.dataRoot,
        '--task-id', taskId,
        '--workspace', input.workspace_key,
        '--skip-countdown'
      ]
      if (input.next_actor) workerArgs.push('--actor', input.next_actor)
      await this.spawnWorkerImpl(workerArgs, { workspaceKey: input.workspace_key, taskId })
      return
    }

    await this.runner.skipCountdown(taskId, input)
  }

  pauseCountdown(taskId: string, input: CountdownInput): Promise<void> {
    return this.runner.pauseCountdown(taskId, input)
  }

  async interrupt(taskId: string, workspaceKey: string): Promise<void> {
    await this.runner.interrupt(taskId, workspaceKey)
    await this.coordinator.onTaskTerminal(workspaceKey)
  }

  cancelTask(taskId: string, workspaceKey: string): Promise<void> {
    return this.runner.cancelTask(taskId, workspaceKey)
  }

  async deleteTask(taskId: string, workspaceKey: string): Promise<void> {
    await this.runner.cancelTask(taskId, workspaceKey)
    await this.store.deleteTask(taskId, workspaceKey)
    await this.coordinator.onTaskTerminal(workspaceKey)
  }

  async reconcileWorkspace(workspaceKey: string): Promise<void> {
    await this.coordinator.reconcile(workspaceKey)
  }

  private async spawnDetachedWorker(
    workerArgs: string[],
    taskMeta?: { workspaceKey: string; taskId: string }
  ): Promise<void> {
    const cliScript = resolveCliWorkerScript()
    if (!cliScript) {
      throw new Error('Cannot locate Buddy CLI script for background worker execution')
    }

    const child = spawn(process.execPath, [cliScript, ...workerArgs], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BUDDY_DATA_ROOT: this.dataRoot
      }
    })
    if (taskMeta && child.pid) {
      await writeWorkerLock(this.dataRoot, taskMeta.workspaceKey, taskMeta.taskId, child.pid)
    }
    child.unref()
  }
}

function resolveCliWorkerScript(): string | null {
  if (process.env.BUDDY_CLI_WORKER_SCRIPT && existsSync(process.env.BUDDY_CLI_WORKER_SCRIPT)) {
    return process.env.BUDDY_CLI_WORKER_SCRIPT
  }
  const argv1 = process.argv[1]
  if (argv1 && /cli(?:-entry)?\.(?:js|mjs|cjs|ts)$/.test(argv1) && existsSync(argv1)) {
    return argv1
  }
  const builtCli = join(process.cwd(), 'out', 'main', 'cli.js')
  if (existsSync(builtCli)) return builtCli
  return null
}

async function resolveSocketPath(dataRoot: string): Promise<string> {
  const discoveryPath = discoveryPathForDataRoot(dataRoot)
  try {
    const raw = await readFile(discoveryPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CliServerDiscoveryInfo>
    if (typeof parsed.socketPath === 'string' && parsed.socketPath && existsSync(parsed.socketPath)) {
      return parsed.socketPath
    }
  } catch {
    // Fall back to deterministic socket path
  }
  return socketPathForDataRoot(dataRoot)
}

async function tryConnectAppClient(dataRoot: string): Promise<BuddyCliSocketClient | null> {
  const socketPath = await resolveSocketPath(dataRoot)
  if (!existsSync(socketPath)) return null
  const client = new BuddyCliSocketClient(dataRoot, socketPath)
  try {
    const pong = await client.ping()
    if (pong.ok) return client
  } catch {
    // Socket unreachable or stale
  }
  return null
}

function findBuddyAppBundlePath(): string | null {
  const candidates = [
    process.env.BUDDY_APP_PATH,
    '/Applications/Buddy.app',
    join(homedir(), 'Applications', 'Buddy.app')
  ].filter((item): item is string => typeof item === 'string' && item.length > 0)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ResolveBackendOptions {
  dataRoot?: string
  local?: boolean
  autoLaunchApp?: boolean
}

export async function resolveCliBackend(options: ResolveBackendOptions = {}): Promise<CliBackend> {
  const dataRoot = options.dataRoot || defaultCliDataRoot()

  if (options.local || process.env.BUDDY_CLI_LOCAL === '1') {
    return new BuddyCliLocalBackend(dataRoot)
  }

  const existingClient = await tryConnectAppClient(dataRoot)
  if (existingClient) return existingClient

  const isDefaultDataRoot = resolve(dataRoot) === resolve(join(homedir(), 'Library', 'Application Support', 'buddy'))
  const shouldTryAutoLaunch =
    options.autoLaunchApp !== false &&
    process.env.BUDDY_NO_AUTO_LAUNCH !== '1' &&
    process.platform === 'darwin' &&
    (isDefaultDataRoot || Boolean(process.env.BUDDY_APP_PATH))

  if (shouldTryAutoLaunch) {
    const appPath = findBuddyAppBundlePath()
    if (appPath) {
      try {
        const child = spawn('open', ['-g', '-a', appPath], {
          detached: true,
          stdio: 'ignore'
        })
        child.unref()

        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          await delay(200)
          const client = await tryConnectAppClient(dataRoot)
          if (client) return client
        }
      } catch {
        // Ignore launch failure and fall back to local headless backend
      }
    }
  }

  return new BuddyCliLocalBackend(dataRoot)
}
