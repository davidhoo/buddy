import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { basename, dirname, resolve } from 'node:path'
import { existsSync, statSync, chmodSync } from 'node:fs'
import { installHintFor, mergeChildEnv } from './shell-path'

export type LauncherCommandKind =
  | 'native_claude'
  | 'native_codex'
  | 'native_cursor'
  | 'native_agy'
  | 'native_opencode'
  | 'native_kimi'
  | 'contract'

export interface LauncherCommandInput {
  actor: string
  command: string
  mode?: string
  promptFile: string
  promptText?: string
  eventFile?: string
  outputFile?: string
  repoRoot?: string
  taskDir?: string
  runId?: string
  sessionId?: string
  /** Buddy launcher timeout; native_agy maps this to --print-timeout (agy default is only 5m). */
  timeoutSeconds?: number
}

export interface LauncherCommand {
  command: string
  args: string[]
  env?: Record<string, string>
  kind: LauncherCommandKind
  stdinText?: string
}

/** Whether the given command kind requires a PTY to function correctly. */
export function kindNeedsPty(kind: LauncherCommandKind): boolean {
  // opencode CLI hangs when spawned with piped stdio (no TTY).
  // It needs a PTY to produce output in --format json mode.
  return kind === 'native_opencode'
}

/** Map a command kind to the parser actor name for correct output parsing.
 * When the command is opencode but the actor is kimi (e.g. opencode -m provider/kimi-k2.6),
 * the output format is opencode's JSON, so we need the opencode parser. */
export function parserActorForKind(actor: string, kind: LauncherCommandKind): string {
  if (kind === 'native_opencode') return 'opencode'
  if (kind === 'native_kimi') return 'kimi'
  if (kind === 'native_claude') return 'claude'
  if (kind === 'native_codex') return 'codex'
  if (kind === 'native_cursor') return 'cursor'
  if (kind === 'native_agy') return 'agy'
  return actor
}

/** ANSI escape sequence pattern for stripping TTY output */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g

/** Exit status shared by pipe and PTY launchers. */
export interface LauncherRunResult {
  exitCode: number | null
  signal: string | null
  /** Set only when Buddy's deadline fired, not on user abort or external signals. */
  timedOut?: boolean
}

export type PtyRunResult = LauncherRunResult

export class LauncherTimeoutError extends Error {
  readonly code = 'LAUNCHER_TIMEOUT'

  constructor(timeoutMs: number) {
    super(`Actor timed out after ${timeoutMs / 1000} seconds`)
    this.name = 'LauncherTimeoutError'
  }
}

/**
 * Ensure node-pty's spawn-helper binary has executable permission (can be 0644 after npm/pnpm extract).
 */
export function ensurePtySpawnHelperExecutable(): void {
  if (process.platform === 'win32') return
  try {
    const unixTermPath = require.resolve('node-pty/lib/unixTerminal')
    const utils = require('node-pty/lib/utils')
    const native = utils.loadNativeModule('pty')
    const helperPath = resolve(dirname(unixTermPath), native.dir + '/spawn-helper')
    if (existsSync(helperPath)) {
      const stats = statSync(helperPath)
      if ((stats.mode & 0o111) === 0) {
        chmodSync(helperPath, 0o755)
      }
    }
  } catch {
    // Ignore if path resolution fails
  }
}

/**
 * Run a launcher command using a PTY (pseudo-terminal).
 * Required for CLI tools (like opencode) that hang when spawned with piped stdio.
 */
export async function runLauncherWithPty(input: {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  timeoutMs: number
  onData(data: string): void
  signal?: AbortSignal
}): Promise<PtyRunResult> {
  // Lazy-load node-pty so it's only required when actually needed
  let pty: typeof import('node-pty')
  try {
    pty = await import('node-pty')
  } catch {
    throw new Error(
      'node-pty is required for PTY-based launcher but could not be loaded. ' +
      'Please ensure node-pty is installed: pnpm add node-pty'
    )
  }

  ensurePtySpawnHelperExecutable()

  const [command, ...prefixArgs] = splitCommand(input.command)
  const fullArgs = [...prefixArgs, ...input.args]

  const child = pty.spawn(command, fullArgs, {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: input.cwd,
    env: mergeChildEnv(process.env, input.env)
  })

  let exited = false
  let timedOut = false
  let forceKill: ReturnType<typeof setTimeout> | undefined

  // AbortSignal: kill the child when the signal aborts
  const onAbort = () => {
    if (exited) return
    try { child.kill('SIGTERM') } catch { /* already exited */ }
    forceKill ??= setTimeout(() => {
      if (!exited) { try { child.kill('SIGKILL') } catch { /* already exited */ } }
    }, 1500)
    forceKill.unref()
  }
  if (input.signal) {
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
  }

  child.onData((data: string) => {
    // Strip ANSI escape codes and carriage returns before forwarding
    const cleaned = data.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(/\r/g, '')
    if (cleaned) input.onData(cleaned)
  })

  const exitPromise = new Promise<{ exitCode: number | null; signal?: number }>((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      exited = true
      clearTimeout(forceKill)
      resolve({ exitCode, signal })
    })
  })

  // Set timeout
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<{ exitCode: number | null; signal?: number }>((resolve) => {
    timeout = setTimeout(() => {
      if (!exited) {
        timedOut = !input.signal?.aborted
        onAbort()
        resolve({ exitCode: null, signal: 15 })
      }
    }, input.timeoutMs)
  })

  const result = await Promise.race([exitPromise, timeoutPromise])
  clearTimeout(timeout)

  if (input.signal) input.signal.removeEventListener('abort', onAbort)

  return {
    exitCode: result.exitCode,
    signal: result.signal != null ? String(result.signal) : null,
    ...(timedOut ? { timedOut: true } : {})
  }
}

export function buildLauncherCommand(input: LauncherCommandInput): LauncherCommand {
  let baseCmd = splitCommand(input.command)
  const kind = commandKindFor(input.actor, baseCmd)
  if (!baseCmd[0] && kind !== 'contract') {
    if (input.actor === 'wecode_claude') baseCmd = ['wecode']
    else if (input.actor === 'wecode_codex') baseCmd = ['wecode', 'codex']
    else if (input.actor === 'wecode_opencode') baseCmd = ['wecode', 'opencode']
    else baseCmd = [input.actor]
  }
  const [command, ...prefixArgs] = kind === 'native_codex'
    ? cleanCodexBaseCommand(baseCmd)
    : baseCmd

  if (kind === 'native_claude') {
    const skipPermissions = prefixArgs.includes('--dangerously-skip-permissions')
      ? []
      : ['--dangerously-skip-permissions']
    return {
      command,
      args: [
        ...prefixArgs,
        ...skipPermissions,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--input-format',
        'text',
        ...(input.sessionId ? ['--resume', input.sessionId] : [])
      ],
      kind,
      stdinText: input.promptText
    }
  }

  if (kind === 'native_codex') {
    const args = [
      ...prefixArgs,
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '--skip-git-repo-check'
    ]
    if (input.repoRoot) args.push('-C', input.repoRoot)
    if (input.outputFile) args.push('-o', input.outputFile)
    if (input.sessionId) args.push('resume', input.sessionId)
    args.push('-')

    return {
      command,
      args,
      kind,
      stdinText: input.promptText
    }
  }

  if (kind === 'native_cursor') {
    const promptText = input.promptText?.trim() ?? ''
    return {
      command,
      args: [
        ...prefixArgs,
        '--print',
        '--force',
        '--output-format',
        'stream-json',
        // Re-enabled for live progress. Consumers must coalesce deltas (not one
        // event per UI line) and prefer result.result for the final reply.
        '--stream-partial-output',
        // Buddy owns the next turn. Finish this turn (including subagents)
        // without waiting for background shells. Persistent services must be
        // detached as described in the Cursor turn prompt: CLI cleanup stops
        // shells it still owns on exit.
        '--single-turn',
        ...(input.sessionId ? ['--resume', input.sessionId] : []),
        promptText
      ],
      kind
    }
  }

  if (kind === 'native_agy') {
    // agy requires the prompt attached to -p= / --print=. Bare --print steals the
    // next flag as the prompt. Long Buddy prompts go via stdin stream-json instead.
    // Default print-timeout is only 5m — always override from Buddy's timeout.
    const timeoutSeconds = Math.max(1, Math.floor(input.timeoutSeconds ?? 7200))
    const promptText = input.promptText ?? ''
    const stdinPayload = `${JSON.stringify({
      event: 'user',
      message: { content: promptText }
    })}\n`
    return {
      command,
      args: [
        ...prefixArgs,
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--dangerously-skip-permissions',
        `--print-timeout=${timeoutSeconds}s`,
        ...(input.sessionId ? ['--conversation', input.sessionId] : []),
        '-p='
      ],
      kind,
      stdinText: stdinPayload
    }
  }

  if (kind === 'native_opencode') {
    const args = [
      ...prefixArgs,
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions'
    ]
    if (input.sessionId) args.push('--session', input.sessionId)
    const promptText = input.promptText?.trim()
    if (promptText) args.push(promptText)

    return {
      command,
      args,
      kind
    }
  }

  if (kind === 'native_kimi') {
    const promptText = input.promptText?.trim() ?? ''
    return {
      command,
      args: [
        ...prefixArgs,
        '-p',
        promptText,
        '--output-format',
        'stream-json',
        ...(input.sessionId ? ['-S', input.sessionId] : [])
      ],
      kind
    }
  }

  const mode = input.mode ?? (input.sessionId ? 'resume' : 'start')
  const repoRoot = input.repoRoot ?? ''
  const taskDir = input.taskDir ?? ''
  const runId = input.runId ?? ''
  const outputFile = input.outputFile ?? ''
  const eventFile = input.eventFile ?? ''
  const env = {
    BUDDY_ACTOR: input.actor,
    BUDDY_MODE: mode,
    BUDDY_REPO_ROOT: repoRoot,
    BUDDY_TASK_DIR: taskDir,
    BUDDY_RUN_ID: runId,
    BUDDY_PROMPT_FILE: input.promptFile,
    BUDDY_OUTPUT_FILE: outputFile,
    BUDDY_EVENT_FILE: eventFile,
    BUDDY_SESSION_ID: input.sessionId ?? ''
  }
  const args = [
    ...prefixArgs,
    '--actor',
    input.actor,
    '--mode',
    mode,
    '--repo-root',
    repoRoot,
    '--task-dir',
    taskDir,
    '--run-id',
    runId,
    '--prompt-file',
    input.promptFile,
    '--output-file',
    outputFile,
    '--event-file',
    eventFile
  ]
  if (input.sessionId) args.push('--session-id', input.sessionId)

  return {
    command,
    args,
    env,
    kind
  }
}

export function commandKindFor(actor: string, command: string | string[]): LauncherCommandKind {
  const baseCmd = Array.isArray(command) ? command : splitCommand(command)
  const executable = basename(baseCmd[0] ?? '')
  // Detect native CLI by executable name first, regardless of actor name.
  // This allows e.g. actor='kimi' with command='opencode -m provider/kimi-k2.6'
  // to be correctly identified as native_opencode.
  //
  // WeCode wraps claude, codex, and opencode:
  // `wecode codex ...` runs codex; `wecode opencode ...` runs opencode;
  // otherwise `wecode` (or `wecode ...`) runs claude.
  if (executable === 'claude' || isWecodeClaudeCommand(baseCmd)) return 'native_claude'
  if (executable === 'codex' || isWecodeCodexCommand(baseCmd)) return 'native_codex'
  if (executable === 'cursor-agent' || executable === 'agent') return 'native_cursor'
  if (executable === 'agy' || executable === 'antigravity') return 'native_agy'
  if (executable === 'opencode' || isWecodeOpenCodeCommand(baseCmd)) return 'native_opencode'
  if (executable === 'kimi') return 'native_kimi'
  // Fallback: when no command is specified, infer from actor name.
  // Also: the Antigravity settings card always speaks agy's native protocol.
  // Never fall through to contract flags (--actor, etc.) just because the
  // command string used a wrapper basename we do not recognize — that is
  // exactly what produces "flags provided but not defined: -actor".
  if (executable === '' || executable === 'wecode' || actor === 'agy') {
    if (actor === 'claude' || actor === 'wecode_claude') return 'native_claude'
    if (actor === 'codex' || actor === 'wecode_codex') return 'native_codex'
    if (actor === 'cursor') return 'native_cursor'
    if (actor === 'agy') return 'native_agy'
    if (actor === 'opencode' || actor === 'wecode_opencode') return 'native_opencode'
    if (actor === 'kimi') return 'native_kimi'
  }
  return 'contract'
}

export async function runLauncher(input: {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  stdinText?: string
  timeoutMs: number
  onStdout(line: string): void
  onStderr(line: string): void
  signal?: AbortSignal
}): Promise<LauncherRunResult> {
  const [command, ...prefixArgs] = splitCommand(input.command)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, [...prefixArgs, ...input.args], {
      cwd: input.cwd,
      env: mergeChildEnv(process.env, input.env),
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    throw commandNotFoundError(command, error)
  }

  // Cancellation must settle even when a CLI ignores SIGTERM.
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => {
    try { child.kill('SIGTERM') } catch { /* already exited */ }
    forceKill ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1500)
    forceKill.unref()
  }
  child.once('exit', () => clearTimeout(forceKill))
  child.once('error', () => clearTimeout(forceKill))
  if (input.signal) {
    if (input.signal.aborted) onAbort()
    else input.signal.addEventListener('abort', onAbort, { once: true })
  }

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve(commandNotFoundError(command, err))
      } else {
        resolve(err)
      }
    })
    child.on('spawn', () => resolve(null))
  })

  if (spawnError) {
    if (input.signal) input.signal.removeEventListener('abort', onAbort)
    throw spawnError
  }

  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  const stdoutLines = createLineSplitter(input.onStdout)
  const stderrLines = createLineSplitter(input.onStderr)
  child.stdout!.on('data', (chunk: string) => stdoutLines.push(chunk))
  child.stderr!.on('data', (chunk: string) => stderrLines.push(chunk))

  // Write prompt text to stdin, then close the writable side.
  // The child may exit before we finish writing (e.g. wecode auto-upgrades
  // and relaunches itself, closing the pipe). Guard against EPIPE so the
  // main process does not crash with an uncaught exception.
  child.stdin!.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err
    // EPIPE is expected when the child exits early; swallow silently.
  })
  try {
    child.stdin!.end(input.stdinText ?? '')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err
  }

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = !input.signal?.aborted
    onAbort()
  }, input.timeoutMs)
  const stdoutClosed = once(child.stdout!, 'close').catch(() => undefined)
  const stderrClosed = once(child.stderr!, 'close').catch(() => undefined)
  try {
    const [exitCode, signal] = await once(child, 'exit') as [number | null, string | null]
    // The deadline covers the launcher, not draining inherited pipes after exit.
    clearTimeout(timeout)
    // Bound the drain: grandchildren may keep pipes open after the launcher exits.
    await drainLauncherStreams(child.stdout!, child.stderr!, stdoutClosed, stderrClosed, streamDrainMs(input.timeoutMs))
    stdoutLines.flush()
    stderrLines.flush()
    return { exitCode, signal, ...(timedOut ? { timedOut: true } : {}) }
  } finally {
    clearTimeout(timeout)
    if (input.signal) input.signal.removeEventListener('abort', onAbort)
  }
}

/** Cap how long we wait for stdout/stderr to close after the child exits. */
export function streamDrainMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 250
  return Math.min(500, Math.max(50, timeoutMs))
}

export async function drainLauncherStreams(
  stdout: NodeJS.ReadableStream,
  stderr: NodeJS.ReadableStream,
  stdoutClosed: Promise<unknown>,
  stderrClosed: Promise<unknown>,
  drainMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([stdoutClosed, stderrClosed]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, drainMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    destroyStream(stdout)
    destroyStream(stderr)
  }
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  const readable = stream as NodeJS.ReadableStream & { destroy?: () => void; destroyed?: boolean }
  if (readable.destroyed) return
  try {
    readable.destroy?.()
  } catch {
    /* ignore */
  }
}

/**
 * Split stdout/stderr chunks into complete lines, keeping a trailing partial
 * line across chunk boundaries so NDJSON events are not broken mid-object.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void
  flush(): void
} {
  let buffer = ''
  return {
    push(chunk: string) {
      if (!chunk) return
      buffer += chunk
      while (true) {
        const match = /\r?\n/.exec(buffer)
        if (!match || match.index === undefined) break
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (line) onLine(line)
      }
    },
    flush() {
      if (!buffer) return
      const line = buffer
      buffer = ''
      if (line) onLine(line)
    }
  }
}

function commandNotFoundError(command: string, cause: unknown): Error {
  const hint = installHintFor(command)
  const msg = hint
    ? `Command '${command}' not found. Install with: ${hint}`
    : `Command '${command}' not found in PATH. Please install it and try again.`
  const err = new Error(msg)
  Object.assign(err, { cause })
  return err
}

export function splitCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command]
  return matches.map((part) => part.replace(/^"|"$/g, ''))
}

/**
 * Whether a command invokes WeCode (the `wecode` executable), regardless of
 * path or arguments. Detection mirrors commandKindFor: split the command,
 * take basename of the first token, compare to `wecode`. Does NOT depend on
 * any permission flag.
 */
export function isWecodeCommand(command: string | string[]): boolean {
  const baseCmd = Array.isArray(command) ? command : splitCommand(command)
  return basename(baseCmd[0] ?? '') === 'wecode'
}

/**
 * Whether a command invokes WeCode Claude (i.e. `wecode` whose second token
 * is NOT `codex` and NOT `opencode`). Mirrors the WeCode-Claude branch of commandKindFor.
 */
export function isWecodeClaudeCommand(command: string | string[]): boolean {
  const baseCmd = Array.isArray(command) ? command : splitCommand(command)
  if (basename(baseCmd[0] ?? '') !== 'wecode') return false
  return baseCmd[1] !== 'codex' && baseCmd[1] !== 'opencode'
}

/**
 * Whether a command invokes WeCode Codex (i.e. `wecode codex ...`).
 * Mirrors the WeCode-Codex branch of commandKindFor.
 */
export function isWecodeCodexCommand(command: string | string[]): boolean {
  const baseCmd = Array.isArray(command) ? command : splitCommand(command)
  return basename(baseCmd[0] ?? '') === 'wecode' && baseCmd[1] === 'codex'
}

/**
 * Whether a command invokes WeCode OpenCode (i.e. `wecode opencode ...`).
 * Mirrors the WeCode-OpenCode branch of commandKindFor.
 */
export function isWecodeOpenCodeCommand(command: string | string[]): boolean {
  const baseCmd = Array.isArray(command) ? command : splitCommand(command)
  return basename(baseCmd[0] ?? '') === 'wecode' && baseCmd[1] === 'opencode'
}

function cleanCodexBaseCommand(baseCmd: string[]): string[] {
  const legacyBareFlags = new Set(['--full-auto'])
  return [baseCmd[0], ...baseCmd.slice(1).filter((part) => !legacyBareFlags.has(part))]
}
