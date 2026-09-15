import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import clientSource from './service-client.cjs?raw'
import supervisorSource from './service-supervisor.cjs?raw'
import { BuddyStore } from './store'
import { serviceRequestSchema, serviceStatusSchema, serviceTaskManifestSchema, taskServiceSchema, type TaskServiceRecord } from './schemas'

const terminal = (status: string) => ['stopped', 'exited', 'failed'].includes(status)
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}

async function socketRequest(socketPath: string, token: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { authorization: `Bearer ${token}` } }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try {
          const result = JSON.parse(body)
          if (res.statusCode !== 200) reject(new Error(result.error || `Supervisor HTTP ${res.statusCode}`))
          else resolve(result)
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(5000, () => req.destroy(new Error('Service supervisor did not respond')))
    req.on('error', reject)
    req.end()
  })
}

export interface ServiceRun {
  env: Record<string, string>
  close(): void
}

/** A task-scoped broker. Actor shells never own the long-lived processes. */
export class TaskServiceManager {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly leases = new Map<string, Set<ServiceRun>>()
  private readonly closed = new Set<string>()
  private toolsPromise?: Promise<{ client: string; supervisor: string }>

  constructor(private readonly store: BuddyStore) {}

  private directory(taskId: string, workspaceKey: string): string {
    return join(this.store.dataRoot, 'runtime', 'services', hash(`${workspaceKey}\0${taskId}`))
  }

  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.locks.set(key, next)
    try { return await next } finally { if (this.locks.get(key) === next) this.locks.delete(key) }
  }

  private tools(): Promise<{ client: string; supervisor: string }> {
    return this.toolsPromise ??= (async () => {
      const root = join(this.store.dataRoot, 'runtime', 'service-tools')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const client = join(root, `client-${hash(clientSource)}.cjs`)
      const supervisor = join(root, `supervisor-${hash(supervisorSource)}.cjs`)
      await Promise.all([writeFile(client, clientSource, { mode: 0o600 }), writeFile(supervisor, supervisorSource, { mode: 0o600 })])
      return { client, supervisor }
    })()
  }

  private async records(directory: string): Promise<TaskServiceRecord[]> {
    let files: string[]
    try { files = await readdir(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return Promise.all(files.filter(name => name.endsWith('.service.json')).map(async name =>
      taskServiceSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))))
  }

  private recordPath(directory: string, name: string): string { return join(directory, `${name}.service.json`) }

  private async status(record: TaskServiceRecord) {
    if (record.owner === 'external') return { status: 'external', pid: record.pid }
    try {
      return serviceStatusSchema.parse(await socketRequest(record.socket, record.token, '/status'))
    } catch (error) {
      // A recorded PID is not authority to signal anything. Only a live,
      // authenticated supervisor can stop its own process group.
      const saved = await readFile(record.status_path, 'utf8').then(text => serviceStatusSchema.parse(JSON.parse(text))).catch(() => null)
      if (saved && terminal(saved.status)) return saved
      throw new Error(`Cannot verify service ${record.name}: ${error instanceof Error ? error.message : error}`)
    }
  }

  private async describe(directory: string, record: TaskServiceRecord) {
    const status = await this.status(record).catch(error => ({ status: 'unreachable', error: error.message }))
    const tools = await this.tools()
    return {
      name: record.name, owner: record.owner, keep_reason: record.keep_reason, ...status,
      ...(record.owner === 'buddy' ? {
        command: record.command, cwd: record.cwd, log_path: record.log_path,
        stop_command: `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(tools.client)} stop-owned ${quote(join(directory, `${record.id}.control.json`))}`
      } : {})
    }
  }

  private async stop(record: TaskServiceRecord): Promise<void> {
    if (record.owner === 'external') throw new Error('Existing external services are never stopped by Buddy')
    const status = await this.status(record)
    if (terminal(status.status)) return
    const result = serviceStatusSchema.parse(await socketRequest(record.socket, record.token, '/stop'))
    if (!terminal(result.status)) throw new Error(`Service ${record.name} did not stop`)
  }

  async openRun(taskId: string, workspaceKey: string, runId: string, env: Record<string, string>): Promise<ServiceRun> {
    const directory = this.directory(taskId, workspaceKey)
    const tools = await this.tools()
    const socketDir = await mkdtemp(join(tmpdir(), 'br-'))
    const socket = join(socketDir, 's')
    const token = randomBytes(32).toString('hex')
    let active = true
    const server = createServer(async (req, res) => {
      if (!active || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return }
      try {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 65536) throw new Error('Service request is too large')
        }
        const input = serviceRequestSchema.parse(JSON.parse(body))
        const value = await this.locked(directory, async () => {
          const state = await this.store.readTaskState(taskId, workspaceKey)
          if (!active || this.closed.has(directory) || state.active_run?.run_id !== runId) throw new Error('This actor run has ended')
          const records = await this.records(directory)
          if (input.action === 'list') return Promise.all(records.map(record => this.describe(directory, record)))
          if (!input.name) throw new Error('Service name is required')
          const existing = records.find(record => record.name === input.name)
          if (input.action === 'stop') {
            if (!existing) throw new Error('Service not found')
            await this.stop(existing)
            await this.store.appendTaskEvent(taskId, workspaceKey, { type: 'service.stopped', run_id: runId, payload: { name: input.name } })
            return this.describe(directory, existing)
          }
          if (input.action === 'keep') {
            if (!existing || !input.keepReason) throw new Error('Service and explicit retention reason are required')
            const kept = { ...existing, keep_reason: input.keepReason }
            await atomicJson(this.recordPath(directory, input.name), kept)
            return this.describe(directory, kept)
          }
          if (existing) {
            const status = await this.status(existing)
            if (!terminal(status.status)) {
              if (input.action === 'external' && existing.owner === 'external' && input.pid === existing.pid) return this.describe(directory, existing)
              if (input.action !== 'start' || existing.owner !== 'buddy' || JSON.stringify(input.command) !== JSON.stringify(existing.command) || resolve(input.cwd ?? '') !== existing.cwd) {
                throw new Error('Service name already belongs to another command or external service')
              }
              const reused = input.keepReason ? { ...existing, keep_reason: input.keepReason } : existing
              if (input.keepReason) await atomicJson(this.recordPath(directory, input.name), reused)
              return { ...await this.describe(directory, reused), reused: true }
            }
          }
          const base = { id: randomUUID(), name: input.name, task_id: taskId, workspace_key: workspaceKey, created_at: new Date().toISOString(), keep_reason: input.keepReason }
          if (input.action === 'external') {
            if (!input.pid) throw new Error('External PID is required')
            const record: TaskServiceRecord = { ...base, owner: 'external', pid: input.pid }
            await atomicJson(this.recordPath(directory, input.name), record)
            return this.describe(directory, record)
          }
          if (!input.command?.length || !input.cwd) throw new Error('Command and working directory are required')
          const supervisorSocketDir = await mkdtemp(join(tmpdir(), 'bs-'))
          const record: TaskServiceRecord = {
            ...base, owner: 'buddy', command: input.command, cwd: resolve(input.cwd),
            socket: join(supervisorSocketDir, 's'), token: randomBytes(32).toString('hex'),
            status_path: join(directory, `${base.id}.status.json`), log_path: join(directory, `${base.id}.log`)
          }
          // Persist ownership before spawn, so a Buddy crash cannot lose a service.
          await atomicJson(this.recordPath(directory, input.name), record)
          await atomicJson(join(directory, `${record.id}.control.json`), record)
          const log = await open(join(directory, `${base.id}.supervisor.log`), 'a', 0o600)
          const child = spawn(process.execPath, [tools.supervisor], {
            detached: true, env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
            stdio: ['pipe', log.fd, log.fd]
          })
          let spawnError: Error | undefined
          child.once('error', error => { spawnError = error })
          child.stdin!.on('error', () => {})
          child.stdin!.end(JSON.stringify({ socket: record.socket, token: record.token, command: record.command, cwd: record.cwd, logPath: record.log_path, statusPath: record.status_path }))
          child.unref()
          await log.close()
          const until = Date.now() + 7000
          while (Date.now() < until) {
            if (spawnError) {
              await atomicJson(record.status_path, { status: 'failed', error: spawnError.message })
              throw spawnError
            }
            const status = await this.status(record).catch(() => null)
            if (status && status.status !== 'starting') {
              if (status.status !== 'running') throw new Error(`Service ${input.name} failed to stay running; see ${record.log_path}`)
              await this.store.appendTaskEvent(taskId, workspaceKey, { type: 'service.started', run_id: runId, payload: { name: record.name, pid: status.pid, log_path: record.log_path, keep_reason: record.keep_reason } })
              return this.describe(directory, record)
            }
            await delay(30)
          }
          // Do not discard the record on ambiguous startup; cleanup can retry it.
          throw new Error(`Service startup was not confirmed; inspect ${record.log_path} before retrying`)
        })
        res.end(JSON.stringify(value))
      } catch (error) { res.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })) }
    })
    await this.locked(directory, async () => {
      const state = await this.store.readTaskState(taskId, workspaceKey)
      if (state.active_run?.run_id !== runId) throw new Error('Actor run is no longer active')
      await atomicJson(join(directory, 'task.json'), { task_id: taskId, workspace_key: workspaceKey })
      this.closed.delete(directory)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    server.unref()
    const lease: ServiceRun = {
      env: { BUDDY_SERVICE_SOCKET: socket, BUDDY_SERVICE_TOKEN: token, BUDDY_SERVICE_NODE: process.execPath, BUDDY_SERVICE_CLI: tools.client },
      close: () => {
        active = false
        this.leases.get(directory)?.delete(lease)
        server.close(() => { void rm(socketDir, { recursive: true, force: true }) })
      }
    }
    const leases = this.leases.get(directory) ?? new Set<ServiceRun>()
    leases.add(lease); this.leases.set(directory, leases)
    return lease
  }

  async cleanupTask(taskId: string, workspaceKey: string): Promise<string[]> {
    const directory = this.directory(taskId, workspaceKey)
    // Revoke leases immediately, including an actor still draining output.
    for (const lease of this.leases.get(directory) ?? []) lease.close()
    return this.locked(directory, async () => {
      this.closed.add(directory)
      const failures: string[] = []
      const records = await this.records(directory)
      for (const record of records) {
        if (record.owner === 'external' || record.keep_reason) continue
        try { await this.stop(record) } catch (error) {
          failures.push(`${record.name}: ${error instanceof Error ? error.message : error}`)
        }
      }
      return failures
    })
  }

  async recover(): Promise<string[]> {
    const root = join(this.store.dataRoot, 'runtime', 'services')
    const directories = await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const errors: string[] = []
    for (const directory of directories) {
      try {
        const task = serviceTaskManifestSchema.parse(JSON.parse(await readFile(join(root, directory, 'task.json'), 'utf8')))
        const state = await this.store.readTaskState(task.task_id, task.workspace_key).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (!state || state.status === 'DONE' || state.status === 'CANCELLED' || state.service_cleanup_pending) {
          const failures = await this.cleanupTask(task.task_id, task.workspace_key)
          if (failures.length) {
            errors.push(...failures)
            if (state) {
              await this.store.updateTaskState(task.task_id, task.workspace_key, current => ({ ...current, status: 'PAUSED', active_run: null, service_cleanup_pending: true }))
              await this.store.appendTranscript(task.task_id, task.workspace_key, 'system', `后台服务恢复清理失败，已保留记录并暂停任务：${failures.join('; ')}`, { kind: 'service_cleanup_failed' })
            }
            continue
          }
          if (state?.service_cleanup_pending) await this.store.updateTaskState(task.task_id, task.workspace_key, current => ({ ...current, service_cleanup_pending: false }))
        }
      } catch (error) { errors.push(`${directory}: ${error instanceof Error ? error.message : error}`) }
    }
    await atomicJson(join(this.store.dataRoot, 'runtime', 'service-recovery-errors.json'), errors)
    return errors
  }
}
