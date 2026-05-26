import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { basename } from 'node:path'

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
    return {
      command,
      args: [
        ...prefixArgs,
        '--print',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        ...(input.sessionId ? ['--session', input.sessionId] : [])
      ],
      kind,
      stdinText: input.promptText
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
  if (actor === 'claude' && (executable === 'claude' || executable === 'wecode')) return 'native_claude'
  if (actor === 'codex' && executable === 'codex') return 'native_codex'
  if (actor === 'codex' && executable === 'wecode' && baseCmd[1] === 'codex') return 'native_codex'
  if (actor === 'opencode' && executable === 'opencode') return 'native_opencode'
  if (actor === 'kimi' && executable === 'kimi') return 'native_kimi'
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
}): Promise<{ exitCode: number | null }> {
  const [command, ...prefixArgs] = splitCommand(input.command)
  const child = spawn(command, [...prefixArgs, ...input.args], {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) input.onStdout(line)
  })
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) input.onStderr(line)
  })

  child.stdin.end(input.stdinText ?? '')

  const timeout = setTimeout(() => child.kill('SIGTERM'), input.timeoutMs)
  const [exitCode] = await once(child, 'exit') as [number | null]
  clearTimeout(timeout)
  return { exitCode }
}

function splitCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command]
  return matches.map((part) => part.replace(/^"|"$/g, ''))
}

function cleanCodexBaseCommand(baseCmd: string[]): string[] {
  const legacyBareFlags = new Set(['--full-auto'])
  return [baseCmd[0], ...baseCmd.slice(1).filter((part) => !legacyBareFlags.has(part))]
}
