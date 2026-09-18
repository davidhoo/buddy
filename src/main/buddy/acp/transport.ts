import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { mergeChildEnv } from '../shell-path'
import { splitCommand } from '../launchers'
import type { JsonRpcMessage } from './types'

export interface AcpTransport {
  send(message: JsonRpcMessage): Promise<void>
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void
  onClose(handler: (code: number | null, signal: string | null) => void): () => void
  onError(handler: (err: Error) => void): () => void
  close(): Promise<void>
  getStderr?(): string
}

export interface StdioTransportOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  onStderr?: (chunk: string) => void
}

export class AcpStdioTransport implements AcpTransport {
  private child: ChildProcess | null = null
  private rl: ReadlineInterface | null = null
  private readonly messageHandlers = new Set<(msg: JsonRpcMessage) => void>()
  private readonly closeHandlers = new Set<(code: number | null, signal: string | null) => void>()
  private readonly errorHandlers = new Set<(err: Error) => void>()
  private readonly stderrChunks: string[] = []
  private closed = false

  constructor(private readonly options: StdioTransportOptions) {}

  /**
   * Start the subprocess and attach stdio handlers
   */
  start(): void {
    if (this.child) return

    const [cmd, ...prefixArgs] = splitCommand(this.options.command)
    const fullArgs = [...prefixArgs, ...(this.options.args ?? [])]
    const childEnv = mergeChildEnv(process.env, this.options.env)
    const child = spawn(cmd, fullArgs, {
      cwd: this.options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.child = child

    if (!child.stdout || !child.stdin) {
      throw new Error(`Failed to create stdio pipes for ${this.options.command}`)
    }

    this.rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    })

    this.rl.on('line', (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        const parsed = JSON.parse(trimmed) as JsonRpcMessage
        for (const handler of this.messageHandlers) {
          try {
            handler(parsed)
          } catch (err) {
            this.notifyError(err instanceof Error ? err : new Error(String(err)))
          }
        }
      } catch {
        // Ignore non-JSON lines (e.g. startup banners or debug logs)
      }
    })

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const str = chunk.toString('utf8')
        this.stderrChunks.push(str)
        if (this.stderrChunks.length > 50) this.stderrChunks.shift()
        this.options.onStderr?.(str)
      })
    }

    child.on('error', (err) => {
      this.notifyError(err)
    })

    child.on('close', (code, signal) => {
      this.closed = true
      for (const handler of this.closeHandlers) {
        try {
          handler(code, signal)
        } catch {
          // Ignore handler errors on close
        }
      }
    })
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.child || this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('Transport is closed')
    }

    const payload = JSON.stringify(message) + '\n'
    return new Promise((resolve, reject) => {
      this.child?.stdin?.write(payload, 'utf8', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onClose(handler: (code: number | null, signal: string | null) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  private notifyError(err: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(err)
      } catch {
        // Suppress secondary handler error
      }
    }
  }

  getStderr(): string {
    return this.stderrChunks.join('')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    if (this.rl) {
      this.rl.close()
      this.rl = null
    }

    if (this.child) {
      const child = this.child
      this.child = null
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        // Give it 1 second to exit cleanly, then SIGKILL
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
          }
        }, 1000).unref?.()
      }
    }
  }
}
