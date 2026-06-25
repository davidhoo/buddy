import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { basename } from 'node:path'
import { installHintFor } from './shell-path'

export type LauncherCommandKind =
  | 'native_claude'
  | 'native_codex'
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
  return actor
}

/** ANSI escape sequence pattern for stripping TTY output */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g

/** Result from a PTY-based launcher run */
export interface PtyRunResult {
  exitCode: number | null
  signal: string | null
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

  const [command, ...prefixArgs] = splitCommand(input.command)
  const fullArgs = [...prefixArgs, ...input.args]

  const child = pty.spawn(command, fullArgs, {
    name: 'xterm-256color',
    cols: 200,
    rows: 50,
    cwd: input.cwd,
    env: { ...process.env, ...input.env }
  })

  let exited = false

  child.onData((data: string) => {
    // Strip ANSI escape codes and carriage returns before forwarding
    const cleaned = data.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(/\r/g, '')
    if (cleaned) input.onData(cleaned)
  })

  const exitPromise = new Promise<{ exitCode: number | null; signal?: number }>((resolve) => {
    child.onExit(({ exitCode, signal }) => {
      exited = true
      resolve({ exitCode, signal })
    })
  })

  // Set timeout
  const timeoutPromise = new Promise<{ exitCode: number | null; signal?: number }>((resolve) => {
    setTimeout(() => {
      if (!exited) {
        child.kill('SIGTERM')
        resolve({ exitCode: null, signal: 15 })
      }
    }, input.timeoutMs)
  })

  const result = await Promise.race([exitPromise, timeoutPromise])

  return {
    exitCode: result.exitCode,
    signal: result.signal != null ? String(result.signal) : null
  }
}

export function buildLauncherCommand(input: LauncherCommandInput): LauncherCommand {
  let baseCmd = splitCommand(input.command)
  const kind = commandKindFor(input.actor, baseCmd)
  if (!baseCmd[0] && kind !== 'contract') baseCmd = [input.actor]
  const [command, ...prefixArgs] = kind === 'native_codex'
    ? cleanCodexBaseCommand(baseCmd)
    : baseCmd

  if (kind === 'native_claude') {
    return {
      command,
      args: [
        ...prefixArgs,
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
  if (executable === 'claude' || (executable === 'wecode' && baseCmd[1] !== 'codex')) return 'native_claude'
  if (executable === 'codex' || (executable === 'wecode' && baseCmd[1] === 'codex')) return 'native_codex'
  if (executable === 'opencode') return 'native_opencode'
  if (executable === 'kimi') return 'native_kimi'
  // Fallback: when no command is specified, infer from actor name
  if (executable === '' || executable === 'wecode') {
    if (actor === 'claude') return 'native_claude'
    if (actor === 'codex') return 'native_codex'
    if (actor === 'opencode') return 'native_opencode'
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
}): Promise<{ exitCode: number | null; signal: string | null }> {
  const [command, ...prefixArgs] = splitCommand(input.command)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, [...prefixArgs, ...input.args], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (error) {
    throw commandNotFoundError(command, error)
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

  if (spawnError) throw spawnError

  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) input.onStdout(line)
  })
  child.stderr!.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) input.onStderr(line)
  })

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

  const timeout = setTimeout(() => child.kill('SIGTERM'), input.timeoutMs)
  const [exitCode, signal] = await once(child, 'exit') as [number | null, string | null]
  clearTimeout(timeout)
  return { exitCode, signal }
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

function splitCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command]
  return matches.map((part) => part.replace(/^"|"$/g, ''))
}

function cleanCodexBaseCommand(baseCmd: string[]): string[] {
  const legacyBareFlags = new Set(['--full-auto'])
  return [baseCmd[0], ...baseCmd.slice(1).filter((part) => !legacyBareFlags.has(part))]
}
