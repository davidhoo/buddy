import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { basename } from 'node:path'
import type { CursorLauncherOptions, LauncherBackend } from '../../shared/types'
import { installHintFor } from './shell-path'

export type LauncherCommandKind =
  | 'native_claude'
  | 'native_codex'
  | 'native_opencode'
  | 'native_kimi'
  | 'native_cursor'
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
  backend?: LauncherBackend
  model?: string
  cursor?: CursorLauncherOptions
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
  return actor
}

/** ANSI escape sequence pattern for stripping TTY output */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g
const CURSOR_STDIN_PROMPT_INSTRUCTION = 'Follow the complete Buddy turn instructions provided on stdin.'
const CURSOR_POSITIONAL_PROMPT_MAX_BYTES = 24_000

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
  const kind = commandKindFor(input.actor, baseCmd, input.backend)
  if (!baseCmd[0] && kind !== 'contract') baseCmd = [input.actor]
  const cleanedBaseCmd = kind === 'native_codex'
    ? cleanCodexBaseCommand(baseCmd)
    : kind === 'native_cursor'
      ? cleanCursorBaseCommand(baseCmd)
      : baseCmd
  const [command, ...prefixArgs] = cleanedBaseCmd

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

  if (kind === 'native_cursor') {
    const options = input.cursor ?? {}
    const args = [
      ...prefixArgs,
      '-p',
      '--output-format',
      'stream-json'
    ]
    if (options.stream_partial_output) args.push('--stream-partial-output')
    if (input.repoRoot) args.push('--workspace', input.repoRoot)
    if (input.model?.trim()) args.push('--model', input.model.trim())
    if (options.mode && options.mode !== 'agent') args.push('--mode', options.mode)
    if (options.force) args.push('--force')
    if (options.trust) args.push('--trust')
    if (options.approve_mcps) args.push('--approve-mcps')
    if (options.sandbox && options.sandbox !== 'default') args.push('--sandbox', options.sandbox)
    if (input.sessionId) args.push('--resume', input.sessionId)
    args.push(...(options.extra_args ?? []).filter((arg) => arg.trim() !== ''))
    const promptText = input.promptText ?? ''
    const useStdin = Buffer.byteLength(promptText, 'utf8') > CURSOR_POSITIONAL_PROMPT_MAX_BYTES
    // Cursor's documented print mode takes a positional prompt. Very large
    // Buddy turns would exceed platform argv limits, so those use Cursor's
    // documented pipe-as-context form plus a short positional instruction.
    args.push(useStdin ? CURSOR_STDIN_PROMPT_INSTRUCTION : promptText)

    return {
      command,
      args,
      kind,
      ...(useStdin ? { stdinText: promptText } : {})
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

export function commandKindFor(
  actor: string,
  command: string | string[],
  backend?: LauncherBackend
): LauncherCommandKind {
  const baseCmd = Array.isArray(command) ? command : splitCommand(command)
  const executable = basename(baseCmd[0] ?? '')
  if (backend && backend !== 'auto') {
    if (backend === 'contract') return 'contract'
    return `native_${backend}` as LauncherCommandKind
  }
  // Detect a recognized native CLI by executable name first, regardless of
  // actor name. This allows e.g. actor='kimi' with command='opencode -m
  // provider/kimi-k2.6' to be correctly identified as native_opencode.
  if (executable === 'claude' || (executable === 'wecode' && baseCmd[1] !== 'codex')) return 'native_claude'
  if (executable === 'codex' || (executable === 'wecode' && baseCmd[1] === 'codex')) return 'native_codex'
  if (executable === 'opencode') return 'native_opencode'
  if (executable === 'kimi') return 'native_kimi'
  if (executable === 'cursor-agent') return 'native_cursor'
  if (
    executable === 'agent'
    && (actor === 'cursor' || actor === 'cursor-agent' || actor.startsWith('cursor-agent-'))
  ) return 'native_cursor'
  // Preserve the legacy contract behavior for unrecognized commands. Wrapper
  // commands are indistinguishable from contract launchers, so they opt in to
  // native flags through an explicit backend selection.
  if (executable === '' || executable === 'wecode') {
    if (actor === 'claude') return 'native_claude'
    if (actor === 'codex') return 'native_codex'
    if (actor === 'opencode') return 'native_opencode'
    if (actor === 'kimi') return 'native_kimi'
    if (actor === 'cursor' || actor === 'cursor-agent' || actor.startsWith('cursor-agent-')) return 'native_cursor'
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
  attachLineReader(child.stdout!, input.onStdout)
  attachLineReader(child.stderr!, input.onStderr)

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
  // `close` fires after stdio has been drained; `exit` can race the final
  // stdout chunk and truncate a terminal result event.
  const [exitCode, signal] = await once(child, 'close') as [number | null, string | null]
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

export function splitCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command]
  return matches.map((part) => part.replace(/^"|"$/g, ''))
}

function cleanCodexBaseCommand(baseCmd: string[]): string[] {
  const legacyBareFlags = new Set(['--full-auto'])
  return [baseCmd[0], ...baseCmd.slice(1).filter((part) => !legacyBareFlags.has(part))]
}

function cleanCursorBaseCommand(baseCmd: string[]): string[] {
  const valueOptions = new Set([
    '--output-format',
    '--workspace',
    '--model',
    '--mode',
    '--sandbox',
    '--resume'
  ])
  const bareOptions = new Set([
    '-p',
    '--print',
    '--stream-partial-output',
    '-f',
    '--force',
    '--yolo',
    '--trust',
    '--approve-mcps',
    '--continue'
  ])
  const cleaned = [baseCmd[0]]
  for (let index = 1; index < baseCmd.length; index++) {
    const part = baseCmd[index]
    if (bareOptions.has(part)) continue
    if (valueOptions.has(part)) {
      index += 1
      continue
    }
    if ([...valueOptions].some((option) => part.startsWith(`${option}=`))) continue
    cleaned.push(part)
  }
  return cleaned
}

function attachLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): void {
  let pending = ''
  stream.on('data', (chunk: string | Buffer) => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line) onLine(line)
    }
  })
  stream.on('end', () => {
    if (pending) onLine(pending)
    pending = ''
  })
}
