import { existsSync } from 'node:fs'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
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
import {
  discoveryPathForDataRoot,
  socketPathForDataRoot,
  type CliRpcRequest,
  type CliRpcResponse,
  type CliServerDiscoveryInfo
} from './cli-client'
import type { BuddyEventBus } from './events'
import { atomicWriteJson } from './store'

export interface CliServerService {
  getStore(): {
    dataRoot: string
    readGlobalSettings(): Promise<GlobalSettings>
  }
  getTasks(): Promise<Task[]>
  getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail>
  getTaskStats(taskId: string, workspaceKey?: string): Promise<TaskStats | null>
  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<{ events: Event[] }>
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>
  startTask(taskId: string, input: StartTaskInput): Promise<void>
  sendMessage(taskId: string, input: SendMessageInput): Promise<void>
  enqueueInstruction(taskId: string, workspaceKey: string, content: string): Promise<InstructionQueueItem>
  skipCountdown(taskId: string, input: CountdownInput): Promise<void>
  pauseCountdown(taskId: string, input: CountdownInput): Promise<void>
  interrupt(taskId: string, workspaceKey?: string): Promise<void>
  cancelTask(taskId: string, workspaceKey?: string): Promise<void>
  deleteTask(taskId: string, workspaceKey?: string): Promise<void>
}

export interface BuddyCliServerOptions {
  service: CliServerService
  events?: BuddyEventBus
  socketPath?: string
}

async function isSocketResponsive(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false
  return new Promise<boolean>((resolve) => {
    let settled = false
    const socket = createConnection(socketPath)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(false)
    }, 300)

    socket.on('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })

    socket.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error
    }
  }
}

export class BuddyCliServer {
  readonly socketPath: string
  readonly discoveryPath: string
  private readonly service: CliServerService
  private readonly events?: BuddyEventBus
  private server: Server | null = null
  private readonly clients = new Set<Socket>()

  constructor(options: BuddyCliServerOptions) {
    this.service = options.service
    this.events = options.events
    const dataRoot = this.service.getStore().dataRoot
    this.socketPath = options.socketPath ?? socketPathForDataRoot(dataRoot)
    this.discoveryPath = discoveryPathForDataRoot(dataRoot)
  }

  async start(): Promise<void> {
    if (this.server) return

    const dataRoot = this.service.getStore().dataRoot
    await mkdir(dirname(this.socketPath), { recursive: true })
    await mkdir(dirname(this.discoveryPath), { recursive: true })

    if (existsSync(this.socketPath)) {
      const alive = await isSocketResponsive(this.socketPath)
      if (alive) {
        throw new Error(`Buddy CLI IPC socket already active at ${this.socketPath}`)
      }
      await unlinkIfPresent(this.socketPath)
    }

    const server = createServer((socket) => {
      this.handleConnection(socket)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.socketPath)
    })

    await chmod(this.socketPath, 0o600)
    this.server = server

    const info: CliServerDiscoveryInfo = {
      pid: process.pid,
      socketPath: this.socketPath,
      dataRoot,
      startedAt: new Date().toISOString()
    }
    await atomicWriteJson(this.discoveryPath, info)
  }

  async close(): Promise<void> {
    const activeServer = this.server
    this.server = null

    for (const socket of this.clients) {
      socket.destroy()
    }
    this.clients.clear()

    if (activeServer) {
      await new Promise<void>((resolve) => {
        activeServer.close(() => resolve())
      })
    }

    await unlinkIfPresent(this.socketPath).catch(() => {})
    await unlinkIfPresent(this.discoveryPath).catch(() => {})
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket)
    let buffer = ''

    socket.on('close', () => {
      this.clients.delete(socket)
    })

    socket.on('error', () => {
      this.clients.delete(socket)
    })

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line) {
          void this.processLine(socket, line)
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    let request: CliRpcRequest
    try {
      request = JSON.parse(line) as CliRpcRequest
    } catch {
      this.writeResponse(socket, {
        id: null,
        ok: false,
        error: 'Invalid JSON request'
      })
      return
    }

    const id = typeof request.id === 'string' ? request.id : null
    if (!request || typeof request.method !== 'string') {
      this.writeResponse(socket, {
        id,
        ok: false,
        error: 'Invalid RPC request: missing method'
      })
      return
    }

    try {
      const result = await this.dispatch(request.method, request.params ?? {})
      this.writeResponse(socket, { id, ok: true, result })
    } catch (error) {
      this.writeResponse(socket, {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private writeResponse(socket: Socket, response: CliRpcResponse): void {
    if (socket.destroyed || !socket.writable) return
    try {
      socket.write(`${JSON.stringify(response)}\n`)
    } catch {
      // Ignore write failures on disconnecting clients
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'ping':
        return {
          ok: true,
          pid: process.pid,
          dataRoot: this.service.getStore().dataRoot,
          mode: 'app'
        }

      case 'getTasks':
        return this.service.getTasks()

      case 'getTaskDetail':
        return this.service.getTaskDetail(
          requireString(params.taskId, 'taskId'),
          requireString(params.workspaceKey, 'workspaceKey')
        )

      case 'getTaskStats':
        return this.service.getTaskStats(
          requireString(params.taskId, 'taskId'),
          requireString(params.workspaceKey, 'workspaceKey')
        )

      case 'getEvents':
        return this.service.getEvents(
          requireString(params.taskId, 'taskId'),
          typeof params.since === 'number' ? params.since : 0,
          requireString(params.workspaceKey, 'workspaceKey')
        )

      case 'readGlobalSettings':
        return this.service.getStore().readGlobalSettings()

      case 'createTask': {
        const input = requireObject(params.input, 'input') as unknown as CreateTaskInput
        const autoStart = params.autoStart !== false
        let emittedCreatedEvent = false
        const unsubscribe = this.events?.subscribe((envelope) => {
          if (envelope.event.type === 'task.created') {
            emittedCreatedEvent = true
          }
        })
        let created: CreateTaskResult
        try {
          created = await this.service.createTask(input)
        } finally {
          unsubscribe?.()
        }

        if (!emittedCreatedEvent) {
          this.events?.publish({
            workspace_key: created.workspace_key,
            task_id: created.task,
            event: {
              seq: 1,
              task_id: created.task,
              type: 'task.created',
              ts: new Date().toISOString(),
              payload: {
                task_id: created.task,
                execution_mode: input.execution_mode ?? 'immediate'
              }
            }
          })
        }

        if (
          autoStart &&
          (input.execution_mode ?? 'immediate') === 'immediate' &&
          (input.task_text ?? '').trim().length > 0
        ) {
          const before = await readKickoffSnapshot(this.service, created.task, created.workspace_key)
          const runPromise = this.service.startTask(created.task, { workspace_key: created.workspace_key })
          await awaitRunKickoff(this.service, created.task, created.workspace_key, before, runPromise).catch(() => {})
        }

        return created
      }

      case 'startTask': {
        const taskId = requireString(params.taskId, 'taskId')
        const input = requireObject(params.input, 'input') as unknown as StartTaskInput
        const background = params.background !== false
        const before = background ? await readKickoffSnapshot(this.service, taskId, input.workspace_key) : null
        const runPromise = this.service.startTask(taskId, input)
        if (background) {
          await awaitRunKickoff(this.service, taskId, input.workspace_key, before, runPromise)
          return { started: true }
        }
        await runPromise
        return { started: true }
      }

      case 'sendMessage': {
        const taskId = requireString(params.taskId, 'taskId')
        const input = requireObject(params.input, 'input') as unknown as SendMessageInput
        const background = params.background !== false
        const before = background ? await readKickoffSnapshot(this.service, taskId, input.workspace_key) : null
        const runPromise = this.service.sendMessage(taskId, input)
        if (background) {
          await awaitRunKickoff(this.service, taskId, input.workspace_key, before, runPromise)
          return { sent: true }
        }
        await runPromise
        return { sent: true }
      }

      case 'enqueueInstruction':
        return this.service.enqueueInstruction(
          requireString(params.taskId, 'taskId'),
          requireString(params.workspaceKey, 'workspaceKey'),
          requireString(params.content, 'content')
        )

      case 'skipCountdown': {
        const taskId = requireString(params.taskId, 'taskId')
        const input = requireObject(params.input, 'input') as unknown as CountdownInput
        const background = params.background !== false
        const before = background ? await readKickoffSnapshot(this.service, taskId, input.workspace_key) : null
        const runPromise = this.service.skipCountdown(taskId, input)
        if (background) {
          await awaitRunKickoff(this.service, taskId, input.workspace_key, before, runPromise)
          return { skipped: true }
        }
        await runPromise
        return { skipped: true }
      }

      case 'pauseCountdown':
        await this.service.pauseCountdown(
          requireString(params.taskId, 'taskId'),
          requireObject(params.input, 'input') as unknown as CountdownInput
        )
        return { paused: true }

      case 'interrupt':
        await this.service.interrupt(
          requireString(params.taskId, 'taskId'),
          requireString(params.workspaceKey, 'workspaceKey')
        )
        return { interrupted: true }

      case 'cancelTask':
        await this.service.cancelTask(
          requireString(params.taskId, 'taskId'),
          requireString(params.workspaceKey, 'workspaceKey')
        )
        return { cancelled: true }

      case 'deleteTask':
        await this.service.deleteTask(
          requireString(params.taskId, 'taskId'),
          requireString(params.workspaceKey, 'workspaceKey')
        )
        return { deleted: true }

      default:
        throw new Error(`Unknown RPC method: ${method}`)
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Missing or invalid string parameter: ${field}`)
  }
  return value
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Missing or invalid object parameter: ${field}`)
  }
  return value as Record<string, unknown>
}

async function readKickoffSnapshot(
  service: CliServerService,
  taskId: string,
  workspaceKey: string | undefined
): Promise<{ round: number; updatedAt: string } | null> {
  if (!workspaceKey) return null
  try {
    const detail = await service.getTaskDetail(taskId, workspaceKey)
    return {
      round: detail.state.round ?? 0,
      updatedAt: detail.state.updated_at ?? ''
    }
  } catch {
    return null
  }
}

async function awaitRunKickoff(
  service: CliServerService,
  taskId: string,
  workspaceKey: string | undefined,
  before: { round: number; updatedAt: string } | null,
  runPromise: Promise<unknown>
): Promise<void> {
  let runSettled = false
  let runError: unknown
  let hasRunError = false

  const observedRun = runPromise.then(
    () => { runSettled = true },
    (err) => {
      runSettled = true
      hasRunError = true
      runError = err
    }
  )
  observedRun.catch(() => {})

  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    if (runSettled) {
      if (hasRunError) throw runError
      return
    }
    if (workspaceKey) {
      try {
        const detail = await service.getTaskDetail(taskId, workspaceKey)
        const status = detail.state.status
        const round = detail.state.round ?? 0
        if (
          status === 'PINGING' ||
          status.startsWith('RUNNING_') ||
          (before !== null && round !== before.round)
        ) {
          return
        }
      } catch {
        // Ignore transient read errors during kickoff
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  if (runSettled && hasRunError) {
    throw runError
  }
}
