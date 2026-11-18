import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveEffectiveAgentLaunch } from '../../shared/agents'
import { defaultLauncherFor, normalizeGlobalSettings } from '../../shared/defaults'
import { validateTaskId } from '../../shared/task-id'
import type {
  ActiveRun,
  CreateTaskInput,
  Failure,
  GlobalSettings,
  HealthCheckResult,
  Launcher,
  Task,
  TaskDetail,
  TaskStats,
  TaskStatus,
  TranscriptEntry
} from '../../shared/types'
import {
  BuddyCliLocalBackend,
  defaultCliDataRoot,
  isTaskRunActiveOnDisk,
  removeWorkerLock,
  resolveCliBackend,
  workerLockPath,
  type CliBackend
} from './cli-client'
import { installBuddyCli, uninstallBuddyCli, type CliInstallerOptions } from './cli-installer'
import { canonicalRepoRoot, workspaceKeyForRepo } from './paths'
import { actorDisplayName, implementerActor as resolveImplementerActor, reviewerActor as resolveReviewerActor } from './prompts'

export interface CliIO {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  stdin?: NodeJS.ReadableStream | (() => Promise<string>)
  backend?: CliBackend
  cwd?: string
}

export interface TaskProgressSummary {
  task_id: string
  workspace_key: string
  repo_root: string
  status: TaskStatus
  round: number
  next_actor: string
  implementer_actor: string
  reviewer_actor: string
  execution_mode: 'immediate' | 'queued'
  active_run: ActiveRun | null
  pending_break: { actor?: string; round?: number } | null
  latest_failure: Failure | null
  health_check: HealthCheckResult | null
  instruction_queue_length: number
  updated_at: string
  latest_reply: {
    role: string
    round?: number
    ts: string
    buddy_type?: string
    content: string
  } | null
  stats: TaskStats | null
}

export interface ActorOutputSummary {
  actor: string
  round?: number
  ts: string
  buddy_type?: string
  content: string
}

export interface TaskResultSummary {
  task_id: string
  workspace_key: string
  repo_root: string
  status: TaskStatus
  completed: boolean
  timed_out?: boolean
  done_reason: string | null
  round: number
  implementer_actor: string
  reviewer_actor: string
  pending_break: { actor?: string; round?: number } | null
  latest_failure: Failure | null
  actor_outputs: Record<string, ActorOutputSummary>
  final_output: string
  stats: TaskStats | null
  updated_at: string
  transcript?: TranscriptEntry[]
}

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

const VALUE_FLAGS = new Set([
  'data-root',
  'task-id',
  'prompt',
  'file',
  'context',
  'context-file',
  'repo',
  'workspace',
  'implementer',
  'reviewer',
  'implementer-model',
  'reviewer-model',
  'mode',
  'timeout',
  'poll-interval',
  'actor',
  'message',
  'status',
  'limit',
  'reconcile',
  'bin-dir'
])

const SHORT_FLAGS: Record<string, string> = {
  t: 'task-id',
  p: 'prompt',
  f: 'file',
  c: 'context',
  r: 'repo',
  w: 'workspace',
  m: 'message',
  n: 'limit',
  q: 'quiet',
  h: 'help',
  v: 'version'
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['DONE', 'FAILED', 'PAUSED', 'CANCELLED'])

export function deriveTaskId(promptText: string, nowMs = Date.now()): string {
  const firstLine = promptText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''

  const sanitized = firstLine
    .replace(/[\u0000-\u001f\u007f-\u009f/]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')

  const slug = [...sanitized].slice(0, 44).join('').replace(/-+$/g, '')
  const suffix = nowMs.toString(36)
  const candidate = slug ? `${slug}-${suffix}` : `task_${nowMs}`
  const validated = validateTaskId(candidate)
  if (validated.reason === null) return validated.value
  return `task_${nowMs}`
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }

    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eqIndex = body.indexOf('=')
      if (eqIndex !== -1) {
        const key = body.slice(0, eqIndex)
        const val = body.slice(eqIndex + 1)
        flags[key] = val
        continue
      }
      if (body.startsWith('no-')) {
        flags[body] = true
        flags[body.slice(3)] = false
        continue
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1]
        if (next === undefined) {
          throw new Error(`Missing value for --${body}`)
        }
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1)
      if (short.length === 1) {
        const mapped = SHORT_FLAGS[short]
        if (!mapped) throw new Error(`Unknown flag: -${short}`)
        if (VALUE_FLAGS.has(mapped)) {
          const next = argv[i + 1]
          if (next === undefined) {
            throw new Error(`Missing value for -${short}`)
          }
          flags[mapped] = next
          i++
        } else {
          flags[mapped] = true
        }
        continue
      }

      const firstChar = short[0]
      const mappedFirst = SHORT_FLAGS[firstChar]
      if (mappedFirst && VALUE_FLAGS.has(mappedFirst)) {
        flags[mappedFirst] = short.slice(1)
        continue
      }

      for (const ch of short) {
        const mapped = SHORT_FLAGS[ch]
        if (!mapped || VALUE_FLAGS.has(mapped)) {
          throw new Error(`Unknown or non-boolean short flag: -${ch}`)
        }
        flags[mapped] = true
      }
      continue
    }

    positionals.push(token)
  }

  return { positionals, flags }
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const val = flags[name]
  return typeof val === 'string' ? val : undefined
}

function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true
}

function numberFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = stringFlag(flags, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric value for --${name}: ${raw}`)
  }
  return parsed
}

function readPackageVersion(): string {
  const candidates = [
    join(__dirname, '..', '..', 'package.json'),
    join(__dirname, '..', '..', '..', 'package.json'),
    join(process.cwd(), 'package.json')
  ]
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (parsed.name === 'buddy' && typeof parsed.version === 'string') {
        return parsed.version
      }
    } catch {
      // Try next candidate
    }
  }
  return 'unknown'
}

function resolveCliRepoRoot(cwd: string): string | undefined {
  const candidates = [
    join(__dirname, '..', '..'),
    join(__dirname, '..', '..', '..'),
    cwd,
    process.cwd()
  ]
  for (const candidate of candidates) {
    const resolved = resolve(candidate)
    if (resolved.includes('.asar')) continue
    if (existsSync(join(resolved, 'out', 'main', 'cli.js'))) {
      return resolved
    }
  }
  return undefined
}

function buildInstallerOptionsFromCli(
  dataRoot: string,
  cwd: string,
  binDir?: string
): CliInstallerOptions {
  const appExecPath = /\.app\/Contents\/MacOS\//.test(process.execPath)
    ? process.execPath
    : undefined
  const repoRoot = resolveCliRepoRoot(cwd)
  return {
    dataRoot,
    appExecPath,
    repoRoot,
    ...(binDir ? { targetBinDirs: [resolve(cwd, binDir)], updateShellProfile: false } : {})
  }
}

async function readStdinText(stdinSource?: CliIO['stdin']): Promise<string> {
  if (typeof stdinSource === 'function') {
    return stdinSource()
  }
  const stream = stdinSource ?? process.stdin
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function canAutoReadStdin(io?: CliIO): boolean {
  if (io?.stdin) return true
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return false
  return process.stdin.isTTY === false
}

function resolvePromptFromInputs(
  flags: Record<string, string | boolean>,
  restPositionals: string[],
  io?: CliIO
): Promise<string> {
  return (async () => {
    const fileFlag = stringFlag(flags, 'file')
    if (fileFlag) {
      if (fileFlag === '-') {
        return readStdinText(io?.stdin)
      }
      return readFile(resolve(io?.cwd ?? process.cwd(), fileFlag), 'utf8')
    }

    const promptFlag = stringFlag(flags, 'prompt')
    if (promptFlag !== undefined) {
      if (promptFlag === '-') {
        return readStdinText(io?.stdin)
      }
      return promptFlag
    }

    if (restPositionals.length > 0) {
      return restPositionals.join(' ')
    }

    if (canAutoReadStdin(io)) {
      return readStdinText(io?.stdin)
    }

    return ''
  })()
}

async function resolveContextFromInputs(
  flags: Record<string, string | boolean>,
  io?: CliIO
): Promise<string> {
  const contextFile = stringFlag(flags, 'context-file')
  if (contextFile) {
    return readFile(resolve(io?.cwd ?? process.cwd(), contextFile), 'utf8')
  }
  return stringFlag(flags, 'context') ?? ''
}

function buildTaskSettingsForCli(
  globalSettings: GlobalSettings,
  options: {
    implementer: string
    reviewer: string
    implementerModel?: string
    reviewerModel?: string
  }
): Record<string, unknown> {
  const normalized = normalizeGlobalSettings(globalSettings)
  const launchers: Record<string, Launcher> = {}

  for (const [actor, modelOverride] of [
    [options.implementer, options.implementerModel],
    [options.reviewer, options.reviewerModel]
  ] as const) {
    const { protocol, launcher: resolved } = resolveEffectiveAgentLaunch(undefined, {
      agentConfig: globalSettings.agent_management?.[actor],
      savedLauncher: globalSettings.launchers?.[actor] ?? normalized.launchers?.[actor]
    })
    const base = resolved
      ? { ...resolved, protocol }
      : defaultLauncherFor(actor)

    const trimmedModel = modelOverride?.trim()
    launchers[actor] = {
      command: base.command || defaultLauncherFor(actor).command,
      env: { ...(base.env ?? {}) },
      timeout_seconds: base.timeout_seconds ?? defaultLauncherFor(actor).timeout_seconds,
      ...(protocol ? { protocol } : {}),
      ...(Array.isArray(base.args) ? { args: [...base.args] } : {}),
      ...(trimmedModel ? { model: trimmedModel } : base.model ? { model: base.model } : {})
    }
  }

  return {
    protocol_version: normalized.protocol_version ?? '1',
    flow_policy: 'claude_then_codex',
    role_mode:
      options.implementer === 'codex' || options.implementer === 'wecode_codex'
        ? 'codex_implements'
        : 'claude_implements',
    implementer_actor: options.implementer,
    reviewer_actor: options.reviewer,
    max_consecutive_failures: normalized.max_consecutive_failures ?? 10,
    launchers
  }
}

export async function resolveTaskReference(
  backend: CliBackend,
  taskId: string,
  options: { workspaceKey?: string; repoRoot?: string; cwd?: string } = {}
): Promise<{ taskId: string; workspaceKey: string }> {
  if (!taskId.trim()) {
    throw new Error('task_id is required')
  }

  if (options.workspaceKey) {
    await backend.getTaskDetail(taskId, options.workspaceKey)
    return { taskId, workspaceKey: options.workspaceKey }
  }

  const tasks = await backend.getTasks()
  let matches = tasks.filter((task) => task.task_id === taskId)

  if (options.repoRoot) {
    const canonical = canonicalRepoRoot(options.repoRoot)
    const expectedWorkspace = workspaceKeyForRepo(canonical)
    matches = matches.filter(
      (task) => task.workspace_key === expectedWorkspace || task.repo_root === canonical
    )
  }

  if (matches.length === 0) {
    throw new Error(`Task not found: ${taskId}`)
  }

  if (matches.length === 1) {
    return { taskId: matches[0].task_id, workspaceKey: matches[0].workspace_key }
  }

  const cwdCanonical = canonicalRepoRoot(options.cwd ?? process.cwd())
  const cwdWorkspace = workspaceKeyForRepo(cwdCanonical)
  const cwdMatches = matches.filter(
    (task) => task.workspace_key === cwdWorkspace || task.repo_root === cwdCanonical
  )
  if (cwdMatches.length === 1) {
    return { taskId: cwdMatches[0].task_id, workspaceKey: cwdMatches[0].workspace_key }
  }

  const list = matches.map((m) => `  - workspace=${m.workspace_key} repo=${m.repo_root || '(none)'}`).join('\n')
  throw new Error(`Multiple tasks found with ID "${taskId}". Specify --workspace or --repo:\n${list}`)
}

export function buildProgressSummary(detail: TaskDetail, stats: TaskStats | null): TaskProgressSummary {
  const implementer = resolveImplementerActor(detail.settings)
  const reviewer = resolveReviewerActor(detail.settings)
  const actorReplies = detail.transcript.filter((entry) => entry.role !== 'system' && entry.role !== 'human')
  const latest = actorReplies.length > 0 ? actorReplies[actorReplies.length - 1] : null
  const latestMeta = (latest?.meta ?? {}) as Record<string, unknown>

  return {
    task_id: detail.task_id,
    workspace_key: detail.workspace_key,
    repo_root: detail.state.repo_root ?? '',
    status: detail.state.status,
    round: detail.state.round ?? 0,
    next_actor: detail.state.next_actor,
    implementer_actor: implementer,
    reviewer_actor: reviewer,
    execution_mode: detail.state.execution_mode ?? 'immediate',
    active_run: detail.state.active_run ?? null,
    pending_break: detail.state.pending_break ?? null,
    latest_failure: detail.latest_failure ?? detail.state.latest_failure ?? detail.state.last_error ?? null,
    health_check: detail.state.health_check ?? null,
    instruction_queue_length: detail.state.instruction_queue?.length ?? 0,
    updated_at: detail.state.updated_at ?? '',
    latest_reply: latest
      ? {
          role: latest.role,
          round: typeof latestMeta.round === 'number' ? latestMeta.round : latest.round,
          ts: latest.ts,
          buddy_type: typeof latestMeta.buddy_type === 'string' ? latestMeta.buddy_type : undefined,
          content: latest.content
        }
      : null,
    stats
  }
}

export function buildResultSummary(
  detail: TaskDetail,
  stats: TaskStats | null,
  options: { includeTranscript?: boolean; timedOut?: boolean } = {}
): TaskResultSummary {
  const implementer = resolveImplementerActor(detail.settings)
  const reviewer = resolveReviewerActor(detail.settings)
  const doneEvents = detail.events.filter((event) => event.type === 'task.done')
  const latestDoneEvent = doneEvents.length > 0 ? doneEvents[doneEvents.length - 1] : undefined
  const doneReason = typeof latestDoneEvent?.payload?.reason === 'string'
    ? latestDoneEvent.payload.reason
    : null

  const actorOutputs: Record<string, ActorOutputSummary> = {}
  for (const entry of detail.transcript) {
    if (entry.role === 'human' || entry.role === 'system') continue
    const meta = (entry.meta ?? {}) as Record<string, unknown>
    actorOutputs[entry.role] = {
      actor: entry.role,
      round: typeof meta.round === 'number' ? meta.round : entry.round,
      ts: entry.ts,
      buddy_type: typeof meta.buddy_type === 'string' ? meta.buddy_type : undefined,
      content: entry.content
    }
  }

  const implOutput = actorOutputs[implementer]
  const revOutput = actorOutputs[reviewer]
  const actorTranscripts = detail.transcript.filter((e) => e.role !== 'human' && e.role !== 'system')
  const lastActorEntry = actorTranscripts.length > 0 ? actorTranscripts[actorTranscripts.length - 1] : undefined
  const latestFailure = detail.latest_failure ?? detail.state.latest_failure ?? detail.state.last_error ?? null

  let finalOutput = ''
  if (implOutput && revOutput) {
    finalOutput = [
      `[${actorDisplayName(implementer)}]`,
      implOutput.content,
      '',
      `[${actorDisplayName(reviewer)}]`,
      revOutput.content
    ].join('\n')
  } else if (implOutput) {
    finalOutput = implOutput.content
  } else if (revOutput) {
    finalOutput = revOutput.content
  } else if (lastActorEntry) {
    finalOutput = lastActorEntry.content
  } else if (latestFailure?.message) {
    finalOutput = latestFailure.message
  }

  return {
    task_id: detail.task_id,
    workspace_key: detail.workspace_key,
    repo_root: detail.state.repo_root ?? '',
    status: detail.state.status,
    completed: detail.state.status === 'DONE',
    ...(options.timedOut ? { timed_out: true } : {}),
    done_reason: doneReason,
    round: detail.state.round ?? 0,
    implementer_actor: implementer,
    reviewer_actor: reviewer,
    pending_break: detail.state.pending_break ?? null,
    latest_failure: latestFailure,
    actor_outputs: actorOutputs,
    final_output: finalOutput,
    stats,
    updated_at: detail.state.updated_at ?? '',
    ...(options.includeTranscript ? { transcript: detail.transcript } : {})
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join('')
}

function formatStatsLine(stats: TaskStats): string {
  const tokens = `${stats.totalInputTokens.toLocaleString()} in / ${stats.totalOutputTokens.toLocaleString()} out / ${stats.totalCacheReadTokens.toLocaleString()} cache`
  const cost = stats.totalCostUsd !== undefined ? ` / $${stats.totalCostUsd.toFixed(4)}` : ''
  return `${stats.totalRounds} rounds · ${formatDuration(stats.totalDurationMs)} · ${tokens}${cost}`
}

function shouldUseColor(stream: 'stdout' | 'stderr' = 'stdout'): boolean {
  const isTty = stream === 'stderr' ? Boolean(process.stderr.isTTY) : Boolean(process.stdout.isTTY)
  return isTty && !process.env.NO_COLOR
}

function paintText(enabled: boolean, text: string, code: string): string {
  return enabled ? `${code}${text}${ANSI_RESET}` : text
}

function formatProgressText(
  summary: TaskProgressSummary,
  options: { color?: boolean; homeDir?: string; nowMs?: number } = {}
): string {
  const useColor = options.color ?? shouldUseColor('stdout')
  const homeDir = options.homeDir ?? homedir()
  const nowMs = options.nowMs ?? Date.now()
  const statusMeta = formatStatusMeta(summary.status)
  const statusBadge = paintText(useColor, statusMeta.text, ANSI_BY_COLOR[statusMeta.color])
  const repoDisplay = formatRepoDisplay(summary.repo_root, homeDir)
  const updatedText = summary.updated_at
    ? `${formatRelativeUpdatedAt(summary.updated_at, nowMs)} (${summary.updated_at})`
    : '-'
  const divider = paintText(useColor, '─'.repeat(64), ANSI_DIM)

  const lines = [
    `${paintText(useColor, 'Task:', ANSI_BOLD)} ${summary.task_id}`,
    divider,
    `${paintText(useColor, 'Status:', ANSI_DIM)}  ${statusBadge}   ${paintText(useColor, `Round: ${summary.round}`, ANSI_DIM)}   ${paintText(useColor, `Mode: ${summary.execution_mode}`, ANSI_DIM)}`,
    `${paintText(useColor, 'Actors:', ANSI_DIM)}  ${actorDisplayName(summary.implementer_actor)} (implementer) ↔ ${actorDisplayName(summary.reviewer_actor)} (reviewer) · next: ${actorDisplayName(summary.next_actor)}`,
    `${paintText(useColor, 'Repo:', ANSI_DIM)}    ${repoDisplay}  ${paintText(useColor, `(ws: ${summary.workspace_key})`, ANSI_DIM)}`,
    `${paintText(useColor, 'Updated:', ANSI_DIM)} ${updatedText}`
  ]
  if (summary.active_run) {
    lines.push(
      `${paintText(useColor, 'Active:', ANSI_DIM)}  ${paintText(useColor, `${actorDisplayName(summary.active_run.actor)} (${summary.active_run.run_id ?? 'running'})`, ANSI_BY_COLOR.cyan)}`
    )
  }
  if (summary.pending_break?.actor) {
    lines.push(
      `${paintText(useColor, 'Break:', ANSI_DIM)}   ${paintText(useColor, `pending from ${actorDisplayName(summary.pending_break.actor)} (round ${summary.pending_break.round ?? '?'})`, ANSI_BY_COLOR.amber)}`
    )
  }
  if (summary.instruction_queue_length > 0) {
    lines.push(`${paintText(useColor, 'Queue:', ANSI_DIM)}   ${summary.instruction_queue_length} pending instruction(s)`)
  }
  if (summary.latest_failure) {
    lines.push(
      `${paintText(useColor, 'Failure:', ANSI_DIM)} ${paintText(useColor, `[${summary.latest_failure.actor ?? 'unknown'}] ${summary.latest_failure.message}`, ANSI_BY_COLOR.red)}`
    )
  }
  if (summary.stats) {
    lines.push(`${paintText(useColor, 'Stats:', ANSI_DIM)}   ${formatStatsLine(summary.stats)}`)
  }
  if (summary.latest_reply) {
    const preview = summary.latest_reply.content.length > 300
      ? `${summary.latest_reply.content.slice(0, 300)}...`
      : summary.latest_reply.content
    const roundSuffix = summary.latest_reply.round ? `, round ${summary.latest_reply.round}` : ''
    lines.push('')
    lines.push(paintText(useColor, `Latest Reply (${actorDisplayName(summary.latest_reply.role)}${roundSuffix}):`, ANSI_BOLD))
    lines.push(divider)
    lines.push(preview)
  }
  return `${lines.join('\n')}\n`
}

function formatResultText(
  summary: TaskResultSummary,
  options: { color?: boolean; homeDir?: string } = {}
): string {
  const useColor = options.color ?? shouldUseColor('stdout')
  const homeDir = options.homeDir ?? homedir()
  const statusMeta = formatStatusMeta(summary.status)
  const statusBadge = paintText(useColor, statusMeta.text, ANSI_BY_COLOR[statusMeta.color])
  const repoDisplay = summary.repo_root ? formatRepoDisplay(summary.repo_root, homeDir) : '(none)'

  const lines = [
    paintText(useColor, `# Buddy Task Result: ${summary.task_id}`, ANSI_BOLD),
    '',
    `- Status: ${statusBadge}${summary.timed_out ? ' (timed out)' : ''}`,
    `- Rounds: ${summary.round}`
  ]
  if (summary.done_reason) {
    lines.push(`- Done Reason: ${summary.done_reason}`)
  }
  lines.push(
    `- Implementer: ${summary.implementer_actor}`,
    `- Reviewer: ${summary.reviewer_actor}`,
    `- Repo: ${repoDisplay}`,
    `- Workspace: ${summary.workspace_key}`
  )
  if (summary.stats) {
    lines.push(`- Stats: ${formatStatsLine(summary.stats)}`)
  }
  if (summary.latest_failure) {
    lines.push(`- Failure: ${paintText(useColor, `[${summary.latest_failure.actor ?? 'unknown'}] ${summary.latest_failure.message}`, ANSI_BY_COLOR.red)}`)
  }

  lines.push('', paintText(useColor, '## Final Output', ANSI_BOLD), '')
  lines.push(summary.final_output || '(no actor output recorded)')

  if (summary.transcript && summary.transcript.length > 0) {
    lines.push('', paintText(useColor, '## Transcript', ANSI_BOLD), '')
    for (const entry of summary.transcript) {
      const meta = (entry.meta ?? {}) as Record<string, unknown>
      const roundLabel = typeof meta.round === 'number' ? ` (round ${meta.round})` : ''
      const typeLabel = typeof meta.buddy_type === 'string' ? ` [${meta.buddy_type}]` : ''
      lines.push(paintText(useColor, `### ${actorDisplayName(entry.role)}${roundLabel}${typeLabel}`, ANSI_DIM))
      lines.push(entry.content)
      lines.push('')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

type StatusColor = 'green' | 'amber' | 'red' | 'cyan' | 'dim'

const ANSI_RESET = '\x1b[0m'
const ANSI_BOLD = '\x1b[1m'
const ANSI_DIM = '\x1b[2m'
const ANSI_BY_COLOR: Record<StatusColor, string> = {
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

function charDisplayWidth(codePoint: number): number {
  if (
    codePoint === 0 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0
  }

  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3040 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe1f) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
    (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  ) {
    return 2
  }

  return 1
}

function stringDisplayWidth(str: string): number {
  let width = 0
  for (const ch of stripAnsi(str)) {
    width += charDisplayWidth(ch.codePointAt(0) ?? 0)
  }
  return width
}

function truncateDisplay(str: string, maxWidth: number): string {
  if (stringDisplayWidth(str) <= maxWidth) return str
  if (maxWidth <= 0) return ''
  if (maxWidth === 1) return '…'

  let out = ''
  let width = 0
  for (const ch of str) {
    const cw = charDisplayWidth(ch.codePointAt(0) ?? 0)
    if (width + cw > maxWidth - 1) break
    out += ch
    width += cw
  }
  return `${out}…`
}

function truncateMiddleDisplay(str: string, maxWidth: number): string {
  if (stringDisplayWidth(str) <= maxWidth) return str
  if (maxWidth <= 4) return truncateDisplay(str, maxWidth)

  const chars = [...str]
  const rightBudget = Math.max(8, Math.floor((maxWidth - 1) * 0.6))
  const leftBudget = Math.max(2, maxWidth - 1 - rightBudget)

  let left = ''
  let leftWidth = 0
  for (const ch of chars) {
    const cw = charDisplayWidth(ch.codePointAt(0) ?? 0)
    if (leftWidth + cw > leftBudget) break
    left += ch
    leftWidth += cw
  }

  let right = ''
  let rightWidth = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]
    const cw = charDisplayWidth(ch.codePointAt(0) ?? 0)
    if (rightWidth + cw > maxWidth - 1 - leftWidth) break
    right = ch + right
    rightWidth += cw
  }

  return `${left}…${right}`
}

function padDisplayEnd(str: string, targetWidth: number): string {
  const diff = targetWidth - stringDisplayWidth(str)
  return diff > 0 ? `${str}${' '.repeat(diff)}` : str
}

function formatRepoDisplay(repoRoot: string, homeDir: string): string {
  if (!repoRoot) return '-'
  if (repoRoot === homeDir) return '~'
  if (repoRoot.startsWith(`${homeDir}/`)) {
    return `~${repoRoot.slice(homeDir.length)}`
  }
  return repoRoot
}

function formatRelativeUpdatedAt(iso: string, nowMs = Date.now()): string {
  if (!iso) return '-'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return '-'
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000))
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}d ago`
  return iso.slice(0, 10)
}

function formatStatusMeta(status: TaskStatus): { text: string; color: StatusColor } {
  if (status === 'DONE') return { text: '✓ DONE', color: 'green' }
  if (status === 'PAUSED') return { text: '⏸ PAUSED', color: 'amber' }
  if (status === 'COUNTDOWN') return { text: '⏸ COUNTDOWN', color: 'amber' }
  if (status === 'FAILED') return { text: '✗ FAILED', color: 'red' }
  if (status === 'PINGING') return { text: '● PINGING', color: 'cyan' }
  if (status.startsWith('RUNNING_')) {
    return { text: `● ${status.slice('RUNNING_'.length)}`, color: 'cyan' }
  }
  if (status === 'QUEUED') return { text: '◌ QUEUED', color: 'dim' }
  if (status === 'READY') return { text: '◌ READY', color: 'dim' }
  if (status === 'CANCELLED') return { text: '⊘ CANCELLED', color: 'dim' }
  return { text: `◌ ${status}`, color: 'dim' }
}

export function formatTaskListText(
  tasks: Task[],
  options: { color?: boolean; homeDir?: string; nowMs?: number } = {}
): string {
  if (tasks.length === 0) {
    return 'No tasks found.\n'
  }

  const useColor = options.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR)
  const homeDir = options.homeDir ?? homedir()
  const nowMs = options.nowMs ?? Date.now()
  const paint = (text: string, code: string) => (useColor ? `${code}${text}${ANSI_RESET}` : text)

  const rows = tasks.map((task) => {
    const statusMeta = formatStatusMeta(task.status)
    const roundStr = String(task.round ?? 0)
    const taskRaw = task.task_id
    const projectRaw = formatRepoDisplay(task.repo_root, homeDir)
    const updatedStr = formatRelativeUpdatedAt(task.updated_at, nowMs)
    return { statusMeta, roundStr, taskRaw, projectRaw, updatedStr }
  })

  const statusWidth = Math.max(
    stringDisplayWidth('STATUS'),
    ...rows.map((r) => stringDisplayWidth(r.statusMeta.text))
  )
  const roundWidth = Math.max(
    stringDisplayWidth('ROUND'),
    ...rows.map((r) => r.roundStr.length)
  )
  const taskWidth = Math.min(
    36,
    Math.max(stringDisplayWidth('TASK'), ...rows.map((r) => stringDisplayWidth(r.taskRaw)))
  )
  const projectWidth = Math.min(
    32,
    Math.max(stringDisplayWidth('PROJECT'), ...rows.map((r) => stringDisplayWidth(r.projectRaw)))
  )
  const updatedWidth = Math.max(
    stringDisplayWidth('UPDATED'),
    ...rows.map((r) => r.updatedStr.length)
  )

  const gap = '  '
  const header = [
    padDisplayEnd('STATUS', statusWidth),
    padDisplayEnd('ROUND', roundWidth),
    padDisplayEnd('TASK', taskWidth),
    padDisplayEnd('PROJECT', projectWidth),
    padDisplayEnd('UPDATED', updatedWidth)
  ].join(gap)

  const totalWidth = statusWidth + roundWidth + taskWidth + projectWidth + updatedWidth + gap.length * 4
  const separator = '─'.repeat(totalWidth)

  const bodyLines = rows.map((row) => {
    const statusPadded = padDisplayEnd(row.statusMeta.text, statusWidth)
    const statusCell = paint(statusPadded, ANSI_BY_COLOR[row.statusMeta.color])
    const roundCell = row.roundStr.padStart(roundWidth)
    const taskCell = padDisplayEnd(truncateDisplay(row.taskRaw, taskWidth), taskWidth)
    const projectCell = paint(
      padDisplayEnd(truncateMiddleDisplay(row.projectRaw, projectWidth), projectWidth),
      ANSI_DIM
    )
    const updatedCell = paint(padDisplayEnd(row.updatedStr, updatedWidth), ANSI_DIM)
    return [statusCell, roundCell, taskCell, projectCell, updatedCell].join(gap)
  })

  const counts = {
    done: 0,
    running: 0,
    paused: 0,
    failed: 0,
    queued: 0,
    ready: 0,
    cancelled: 0
  }
  for (const task of tasks) {
    if (task.status === 'DONE') counts.done++
    else if (task.status === 'PAUSED' || task.status === 'COUNTDOWN') counts.paused++
    else if (task.status === 'FAILED') counts.failed++
    else if (task.status === 'QUEUED') counts.queued++
    else if (task.status === 'READY') counts.ready++
    else if (task.status === 'CANCELLED') counts.cancelled++
    else if (task.status.startsWith('RUNNING_') || task.status === 'PINGING') counts.running++
  }

  const summaryParts = (
    [
      ['done', counts.done],
      ['running', counts.running],
      ['paused', counts.paused],
      ['failed', counts.failed],
      ['queued', counts.queued],
      ['ready', counts.ready],
      ['cancelled', counts.cancelled]
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`)

  const footer = `Total: ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}${summaryParts.length > 0 ? ` (${summaryParts.join(', ')})` : ''}`

  return [
    paint(header, `${ANSI_BOLD}${ANSI_DIM}`),
    paint(separator, ANSI_DIM),
    ...bodyLines,
    '',
    paint(footer, ANSI_DIM),
    ''
  ].join('\n')
}

function formatHelp(): string {
  return `Buddy CLI - 双 AI 协同编程编排工具

用法:
  buddy <命令> [选项]

命令:
  create [任务描述]      创建新任务（默认立即启动）
  run [任务描述]         创建任务并等待双端轮转完成，直接输出最终结果
  status <task-id>       查看任务当前进度、状态、轮次和最新回复
  wait <task-id>         等待已有任务轮转完成并输出最终结果
  result <task-id>       获取任务的最终结论与各 Actor 输出
  list                   列出所有工作区中的任务
  start <task-id>        启动或继续运行任务
  send <task-id> [消息]  向任务发送消息，或在运行中追加指令到队列
  pause <task-id>        打断/暂停正在运行的任务
  cancel <task-id>       取消任务并清理关联的后台服务
  delete <task-id>       删除任务
  install-cli            将 buddy 命令安装到系统 PATH
  uninstall-cli          从系统 PATH 中卸载 buddy 命令

全局选项:
  --data-root <路径>     指定 Buddy 数据目录
  --local                强制使用本地无头模式（不连接 Buddy App IPC）
  --no-launch            App 未运行时不自动后台拉起 Buddy.app
  --json                 输出机器可读的 JSON 格式
  -q, --quiet            隐藏 stderr 上的实时进度日志
  -h, --help             显示本帮助信息
  -v, --version          查看 Buddy CLI 版本号

创建与运行任务选项:
  -t, --task-id <标题>         任务标题 / ID（支持中文，省略时自动从描述首行生成）
  -p, --prompt <文本>          任务描述文本（传 '-' 表示从标准输入读取）
  -f, --file <路径>            从文件读取任务描述
  -c, --context <文本>         补充背景上下文文本
  --context-file <路径>        从文件读取背景上下文
  -r, --repo <目录>            任务工作目录 / Git 仓库路径（默认当前目录）
  --implementer <actor>        执行者（默认: claude）
  --reviewer <actor>           审查者（默认: codex；若执行者为 codex 则默认 claude）
  --implementer-model <模型>   覆盖执行者使用的模型 ID
  --reviewer-model <模型>      覆盖审查者使用的模型 ID
  --mode <immediate|queued>    执行模式：immediate 立即执行 / queued 排队执行（默认: immediate）
  --no-start                   仅创建任务，不自动启动（仅 create 有效）
  --wait                       创建或启动后阻塞等待任务结束
  --timeout <秒>               等待超时时间（秒）
  --poll-interval <毫秒>       状态轮询间隔（默认: 500 毫秒）
  --transcript                 在结果中附带完整对话记录

支持的 Actor:
  claude, codex, cursor, agy, opencode, kimi, dsh,
  wecode_claude, wecode_codex, wecode_opencode

查询与控制选项:
  -w, --workspace <key>        当存在同名任务时按 workspace key 消歧
  --status <状态>              按任务状态过滤 list 输出（如 DONE / PAUSED / FAILED）
  -n, --limit <数量>           限制 list 返回的任务条数
  --actor <actor>              为 start / send 指定目标 Actor
  -m, --message <文本>         为 start / send 指定消息内容
  --enqueue                    强制将消息加入指令队列（send）

示例:
  # 异步创建任务，完整指定标题、工作目录、执行者、审查者与任务描述
  buddy create -t "修复登录超时" -r ~/Code/my-app --implementer claude --reviewer codex -p "排查重试逻辑并补齐单测"

  # 从 Markdown 文件读取描述，阻塞等待轮转结束并返回 JSON 结果
  buddy run -t "重构订单状态机" -r ~/Code/my-app --implementer wecode_claude --reviewer cursor -f ./spec.md --json

  # 查询任务进度、等待完成并读取完整结果
  buddy status "修复登录超时"
  buddy wait "修复登录超时"
  buddy result "修复登录超时" --transcript
`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForTaskCompletion(
  backend: CliBackend,
  taskId: string,
  workspaceKey: string,
  options: {
    timeoutSeconds?: number
    pollIntervalMs?: number
    includeTranscript?: boolean
    quiet?: boolean
    json?: boolean
    logStderr: (line: string) => void
    initialRunPromise?: Promise<void>
  }
): Promise<{ summary: TaskResultSummary; exitCode: number }> {
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const deadline = options.timeoutSeconds !== undefined
    ? Date.now() + options.timeoutSeconds * 1000
    : undefined

  let lastStatus: TaskStatus | undefined
  let lastRound = -1
  let seenTranscriptCount = 0
  let startedInProcess = Boolean(options.initialRunPromise)
  let skippedCountdownAtRound: number | null = null
  let reconcileAttempted = false
  let inProcessError: Error | null = null
  let inProcessPromise: Promise<void> | null = options.initialRunPromise
    ? options.initialRunPromise.catch((err) => {
        inProcessError = err instanceof Error ? err : new Error(String(err))
      })
    : null

  const useStderrColor = shouldUseColor('stderr')

  const logProgress = (detail: TaskDetail) => {
    if (options.quiet || options.json) return
    if (detail.state.status !== lastStatus || (detail.state.round ?? 0) !== lastRound) {
      lastStatus = detail.state.status
      lastRound = detail.state.round ?? 0
      const meta = formatStatusMeta(detail.state.status)
      const badge = paintText(useStderrColor, meta.text, ANSI_BY_COLOR[meta.color])
      const prefix = paintText(useStderrColor, '[buddy]', ANSI_DIM)
      options.logStderr(
        `${prefix} ${badge}  ${taskId}  round=${lastRound}  next=${actorDisplayName(detail.state.next_actor)}\n`
      )
    }
    if (detail.transcript.length > seenTranscriptCount) {
      const added = detail.transcript.slice(seenTranscriptCount)
      seenTranscriptCount = detail.transcript.length
      const prefix = paintText(useStderrColor, '[buddy]', ANSI_DIM)
      for (const entry of added) {
        const meta = (entry.meta ?? {}) as Record<string, unknown>
        const round = typeof meta.round === 'number' ? meta.round : detail.state.round ?? 0
        const singleLine = entry.content.replace(/\s+/g, ' ').trim()
        const preview = singleLine.length > 140 ? `${singleLine.slice(0, 140)}...` : singleLine
        options.logStderr(`${prefix} ${paintText(useStderrColor, `round=${round}`, ANSI_DIM)}  ${actorDisplayName(entry.role)}: ${preview}\n`)
      }
    }
  }

  for (;;) {
    let detail = await backend.getTaskDetail(taskId, workspaceKey)
    logProgress(detail)

    if (!TERMINAL_STATUSES.has(detail.state.status)) {
      if (detail.state.status === 'COUNTDOWN' && skippedCountdownAtRound !== detail.state.round) {
        skippedCountdownAtRound = detail.state.round
        if (backend.mode === 'local') {
          if (!inProcessPromise) {
            startedInProcess = true
            inProcessPromise = backend
              .skipCountdown(taskId, { workspace_key: workspaceKey }, { background: false })
              .catch((err) => {
                inProcessError = err instanceof Error ? err : new Error(String(err))
              })
          }
        } else {
          await backend.skipCountdown(taskId, { workspace_key: workspaceKey }, { background: true })
        }
      } else if (backend.mode === 'local' && !inProcessPromise) {
        if (detail.state.status === 'QUEUED' && !reconcileAttempted) {
          reconcileAttempted = true
          inProcessPromise = (backend.reconcileWorkspace?.(workspaceKey) ?? Promise.resolve())
            .catch((err) => {
              inProcessError = err instanceof Error ? err : new Error(String(err))
            })
            .finally(() => {
              inProcessPromise = null
            })
        } else if (detail.state.status === 'READY' && !startedInProcess) {
          const activeOnDisk = await isTaskRunActiveOnDisk(backend.dataRoot, workspaceKey, taskId)
          if (!activeOnDisk) {
            startedInProcess = true
            inProcessPromise = backend
              .startTask(taskId, { workspace_key: workspaceKey }, { background: false })
              .then(() => {})
              .catch((err) => {
                inProcessError = err instanceof Error ? err : new Error(String(err))
              })
          }
        }
      }
    }

    if (TERMINAL_STATUSES.has(detail.state.status)) {
      if (inProcessPromise) {
        await inProcessPromise
        detail = await backend.getTaskDetail(taskId, workspaceKey)
      }
      if (detail.state.status === 'DONE' && !detail.events.some((event) => event.type === 'task.done')) {
        // completeActor persists DONE state slightly before appending task.done / final transcript.
        const settleDeadline = Date.now() + 500
        while (
          !detail.events.some((event) => event.type === 'task.done') &&
          Date.now() < settleDeadline
        ) {
          await delay(50)
          detail = await backend.getTaskDetail(taskId, workspaceKey)
        }
      }
      logProgress(detail)
      const stats = await backend.getTaskStats(taskId, workspaceKey).catch(() => null)
      const summary = buildResultSummary(detail, stats, {
        includeTranscript: options.includeTranscript
      })
      return {
        summary,
        exitCode: detail.state.status === 'DONE' ? 0 : 1
      }
    }

    if (startedInProcess && inProcessError) {
      detail = await backend.getTaskDetail(taskId, workspaceKey)
      if (!TERMINAL_STATUSES.has(detail.state.status)) {
        throw inProcessError
      }
      continue
    }

    if (deadline !== undefined && Date.now() >= deadline) {
      const stats = await backend.getTaskStats(taskId, workspaceKey).catch(() => null)
      const summary = buildResultSummary(detail, stats, {
        includeTranscript: options.includeTranscript,
        timedOut: true
      })
      return { summary, exitCode: 1 }
    }

    const waitMs = deadline !== undefined
      ? Math.max(10, Math.min(pollIntervalMs, deadline - Date.now()))
      : pollIntervalMs

    if (inProcessPromise) {
      await Promise.race([delay(waitMs), inProcessPromise])
    } else {
      await delay(waitMs)
    }
  }
}

async function runWorkerCommand(flags: Record<string, string | boolean>): Promise<number> {
  const dataRoot = stringFlag(flags, 'data-root') ?? defaultCliDataRoot()
  const backend = new BuddyCliLocalBackend(dataRoot)
  const reconcileWs = stringFlag(flags, 'reconcile')
  if (reconcileWs) {
    await backend.reconcileWorkspace(reconcileWs)
    return 0
  }

  const taskId = stringFlag(flags, 'task-id')
  const workspaceKey = stringFlag(flags, 'workspace')
  if (!taskId || !workspaceKey) {
    throw new Error('_worker requires --task-id and --workspace (or --reconcile)')
  }

  const lockFile = workerLockPath(dataRoot, workspaceKey, taskId)
  try {
    const actor = stringFlag(flags, 'actor')
    const message = stringFlag(flags, 'message')
    if (boolFlag(flags, 'send')) {
      await backend.sendMessage(
        taskId,
        { workspace_key: workspaceKey, actor, message: message ?? '' },
        { background: false }
      )
    } else if (boolFlag(flags, 'skip-countdown')) {
      await backend.skipCountdown(
        taskId,
        { workspace_key: workspaceKey, next_actor: actor },
        { background: false }
      )
    } else {
      await backend.startTask(
        taskId,
        { workspace_key: workspaceKey, actor, message },
        { background: false }
      )
    }
    return 0
  } finally {
    await removeWorkerLock(lockFile).catch(() => {})
  }
}

export async function runBuddyCli(argv: string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text))

  try {
    const parsed = parseCliArgs(argv)
    const { positionals, flags } = parsed

    if (boolFlag(flags, 'version')) {
      const version = readPackageVersion()
      if (boolFlag(flags, 'json')) {
        stdout(`${JSON.stringify({ name: 'buddy', version }, null, 2)}\n`)
      } else {
        stdout(`buddy ${version}\n`)
      }
      return 0
    }

    if (positionals.length === 0 || positionals[0] === 'help' || boolFlag(flags, 'help')) {
      stdout(formatHelp())
      return 0
    }

    let command = positionals[0]
    let rest = positionals.slice(1)
    if (command === 'task' && rest.length > 0) {
      command = rest[0]
      rest = rest.slice(1)
    }

    if (command === '_worker') {
      return await runWorkerCommand(flags)
    }

    const dataRoot = stringFlag(flags, 'data-root') ?? defaultCliDataRoot()
    const json = boolFlag(flags, 'json')
    const quiet = boolFlag(flags, 'quiet')
    const cwd = io.cwd ?? process.cwd()

    const useStdoutColor = shouldUseColor('stdout')

    if (command === 'install-cli' || command === 'install') {
      const binDir = stringFlag(flags, 'bin-dir')
      const installerOptions = buildInstallerOptionsFromCli(dataRoot, cwd, binDir)
      const status = await installBuddyCli(installerOptions)
      if (json) {
        stdout(`${JSON.stringify(status, null, 2)}\n`)
      } else {
        stdout(`${paintText(useStdoutColor, '✓', ANSI_BY_COLOR.green)} Installed buddy CLI at ${status.commandPath}\n`)
        if (status.shellProfileUpdated && status.shellProfilePath) {
          stdout(`  Updated ${status.shellProfilePath}. Restart your terminal or run "source ${status.shellProfilePath}".\n`)
        }
      }
      return 0
    }

    if (command === 'uninstall-cli' || command === 'uninstall') {
      const binDir = stringFlag(flags, 'bin-dir')
      const installerOptions = buildInstallerOptionsFromCli(dataRoot, cwd, binDir)
      const status = await uninstallBuddyCli(installerOptions)
      if (json) {
        stdout(`${JSON.stringify(status, null, 2)}\n`)
      } else {
        stdout(`${paintText(useStdoutColor, '✓', ANSI_BY_COLOR.green)} Uninstalled buddy CLI from PATH.\n`)
      }
      return 0
    }

    const backend = io.backend ?? await resolveCliBackend({
      dataRoot,
      local: boolFlag(flags, 'local'),
      autoLaunchApp: flags['no-launch'] !== true
    })

    switch (command) {
      case 'create':
      case 'run': {
        const isRun = command === 'run'
        const shouldWait = isRun || boolFlag(flags, 'wait')
        const noStart = !isRun && flags['start'] === false
        const promptText = await resolvePromptFromInputs(flags, rest, io)
        const contextText = await resolveContextFromInputs(flags, io)

        if (!promptText.trim() && (isRun || !noStart)) {
          throw new Error('Task prompt is required (pass positional text, --prompt, --file, or stdin)')
        }

        const explicitTaskId = stringFlag(flags, 'task-id')
        let taskId: string
        if (explicitTaskId !== undefined) {
          const validation = validateTaskId(explicitTaskId)
          if (validation.reason !== null) {
            throw new Error(`Invalid task ID "${explicitTaskId}": ${validation.reason}`)
          }
          taskId = validation.value
        } else {
          taskId = deriveTaskId(promptText)
        }

        const implementer = stringFlag(flags, 'implementer') ?? 'claude'
        const defaultReviewer = implementer === 'codex' ? 'claude' : 'codex'
        const reviewer = stringFlag(flags, 'reviewer') ?? defaultReviewer
        if (implementer === reviewer) {
          throw new Error(`Implementer and reviewer must be different actors (both are "${implementer}")`)
        }

        const modeRaw = stringFlag(flags, 'mode') ?? 'immediate'
        if (modeRaw !== 'immediate' && modeRaw !== 'queued') {
          throw new Error(`Invalid execution mode "${modeRaw}": expected "immediate" or "queued"`)
        }

        const repoInput = stringFlag(flags, 'repo') ?? cwd
        const repoRoot = repoInput ? canonicalRepoRoot(repoInput) : ''
        const globalSettings = await backend.readGlobalSettings()
        const settings = buildTaskSettingsForCli(globalSettings, {
          implementer,
          reviewer,
          implementerModel: stringFlag(flags, 'implementer-model'),
          reviewerModel: stringFlag(flags, 'reviewer-model')
        })

        const input: CreateTaskInput = {
          task_id: taskId,
          repo_root: repoRoot || undefined,
          task_text: promptText,
          context_text: contextText || undefined,
          settings,
          execution_mode: modeRaw
        }

        // For --wait / run in local mode, create without spawning a detached worker so
        // waitForTaskCompletion drives execution directly in-process.
        const autoStart = shouldWait && backend.mode === 'local' ? false : !noStart
        const created = await backend.createTask(input, {
          autoStart,
          background: true
        })

        if (!shouldWait) {
          if (json) {
            stdout(`${JSON.stringify({
              ...created,
              mode: backend.mode,
              execution_mode: modeRaw,
              started: autoStart && (modeRaw === 'queued' || promptText.trim().length > 0)
            }, null, 2)}\n`)
          } else {
            stdout(`${paintText(useStdoutColor, '✓', ANSI_BY_COLOR.green)} Created task ${created.task} (mode=${backend.mode}, workspace=${created.workspace_key})\n`)
          }
          return 0
        }

        const { summary, exitCode } = await waitForTaskCompletion(backend, created.task, created.workspace_key, {
          timeoutSeconds: numberFlag(flags, 'timeout'),
          pollIntervalMs: numberFlag(flags, 'poll-interval'),
          includeTranscript: boolFlag(flags, 'transcript'),
          quiet,
          json,
          logStderr: stderr
        })

        stdout(json ? `${JSON.stringify(summary, null, 2)}\n` : formatResultText(summary))
        return exitCode
      }

      case 'status':
      case 'progress': {
        const targetId = rest[0] ?? stringFlag(flags, 'task-id')
        if (!targetId) throw new Error('Usage: buddy status <task-id>')
        const ref = await resolveTaskReference(backend, targetId, {
          workspaceKey: stringFlag(flags, 'workspace'),
          repoRoot: stringFlag(flags, 'repo'),
          cwd
        })
        const [detail, stats] = await Promise.all([
          backend.getTaskDetail(ref.taskId, ref.workspaceKey),
          backend.getTaskStats(ref.taskId, ref.workspaceKey).catch(() => null)
        ])
        const summary = buildProgressSummary(detail, stats)
        stdout(json ? `${JSON.stringify(summary, null, 2)}\n` : formatProgressText(summary))
        return 0
      }

      case 'wait': {
        const targetId = rest[0] ?? stringFlag(flags, 'task-id')
        if (!targetId) throw new Error('Usage: buddy wait <task-id>')
        const ref = await resolveTaskReference(backend, targetId, {
          workspaceKey: stringFlag(flags, 'workspace'),
          repoRoot: stringFlag(flags, 'repo'),
          cwd
        })
        const { summary, exitCode } = await waitForTaskCompletion(backend, ref.taskId, ref.workspaceKey, {
          timeoutSeconds: numberFlag(flags, 'timeout'),
          pollIntervalMs: numberFlag(flags, 'poll-interval'),
          includeTranscript: boolFlag(flags, 'transcript'),
          quiet,
          json,
          logStderr: stderr
        })
        stdout(json ? `${JSON.stringify(summary, null, 2)}\n` : formatResultText(summary))
        return exitCode
      }

      case 'result': {
        const targetId = rest[0] ?? stringFlag(flags, 'task-id')
        if (!targetId) throw new Error('Usage: buddy result <task-id>')
        const ref = await resolveTaskReference(backend, targetId, {
          workspaceKey: stringFlag(flags, 'workspace'),
          repoRoot: stringFlag(flags, 'repo'),
          cwd
        })
        const [detail, stats] = await Promise.all([
          backend.getTaskDetail(ref.taskId, ref.workspaceKey),
          backend.getTaskStats(ref.taskId, ref.workspaceKey).catch(() => null)
        ])
        const summary = buildResultSummary(detail, stats, {
          includeTranscript: boolFlag(flags, 'transcript')
        })
        stdout(json ? `${JSON.stringify(summary, null, 2)}\n` : formatResultText(summary))
        return 0
      }

      case 'list':
      case 'ls': {
        let tasks = await backend.getTasks()
        const wsFilter = stringFlag(flags, 'workspace')
        const repoFilter = stringFlag(flags, 'repo')
        const statusFilter = stringFlag(flags, 'status')?.toUpperCase()
        const limit = numberFlag(flags, 'limit')

        if (wsFilter) {
          tasks = tasks.filter((t) => t.workspace_key === wsFilter)
        }
        if (repoFilter) {
          const canonical = canonicalRepoRoot(repoFilter)
          const ws = workspaceKeyForRepo(canonical)
          tasks = tasks.filter((t) => t.workspace_key === ws || t.repo_root === canonical)
        }
        if (statusFilter) {
          tasks = tasks.filter((t) => t.status === statusFilter)
        }
        if (limit !== undefined) {
          tasks = tasks.slice(0, Math.floor(limit))
        }

        stdout(json ? `${JSON.stringify(tasks, null, 2)}\n` : formatTaskListText(tasks))
        return 0
      }

      case 'start':
      case 'resume': {
        const targetId = rest[0] ?? stringFlag(flags, 'task-id')
        if (!targetId) throw new Error(`Usage: buddy ${command} <task-id>`)
        const ref = await resolveTaskReference(backend, targetId, {
          workspaceKey: stringFlag(flags, 'workspace'),
          repoRoot: stringFlag(flags, 'repo'),
          cwd
        })
        const actor = stringFlag(flags, 'actor')
        const message = stringFlag(flags, 'message')
        const shouldWait = boolFlag(flags, 'wait')

        if (shouldWait) {
          let initialRunPromise: Promise<void> | undefined
          if (actor || message) {
            if (backend.mode === 'local') {
              initialRunPromise = backend
                .startTask(ref.taskId, { workspace_key: ref.workspaceKey, actor, message }, { background: false })
                .then(() => {})
            } else {
              await backend.startTask(ref.taskId, { workspace_key: ref.workspaceKey, actor, message }, { background: true })
            }
          }
          const { summary, exitCode } = await waitForTaskCompletion(backend, ref.taskId, ref.workspaceKey, {
            timeoutSeconds: numberFlag(flags, 'timeout'),
            pollIntervalMs: numberFlag(flags, 'poll-interval'),
            includeTranscript: boolFlag(flags, 'transcript'),
            quiet,
            json,
            logStderr: stderr,
            initialRunPromise
          })
          stdout(json ? `${JSON.stringify(summary, null, 2)}\n` : formatResultText(summary))
          return exitCode
        }

        await backend.startTask(ref.taskId, { workspace_key: ref.workspaceKey, actor, message }, { background: true })
        if (json) {
          stdout(`${JSON.stringify({ task_id: ref.taskId, workspace_key: ref.workspaceKey, started: true }, null, 2)}\n`)
        } else {
          stdout(`${paintText(useStdoutColor, '●', ANSI_BY_COLOR.cyan)} Started task ${ref.taskId}\n`)
        }
        return 0
      }

      case 'send': {
        const targetId = rest[0] ?? stringFlag(flags, 'task-id')
        if (!targetId) throw new Error('Usage: buddy send <task-id> [message]')
        const ref = await resolveTaskReference(backend, targetId, {
          workspaceKey: stringFlag(flags, 'workspace'),
          repoRoot: stringFlag(flags, 'repo'),
          cwd
        })
        let message = stringFlag(flags, 'message') ?? rest.slice(1).join(' ')
        if (message === '-') {
          message = await readStdinText(io.stdin)
        } else if (!message.trim() && canAutoReadStdin(io)) {
          message = await readStdinText(io.stdin)
        }
        if (!message.trim()) {
          throw new Error('Message content is required')
        }

        const detail = await backend.getTaskDetail(ref.taskId, ref.workspaceKey)
        const isRunning = detail.state.status.startsWith('RUNNING_') || detail.state.status === 'PINGING'
        if (boolFlag(flags, 'enqueue') || isRunning) {
          const item = await backend.enqueueInstruction(ref.taskId, ref.workspaceKey, message)
          if (json) {
            stdout(`${JSON.stringify({ task_id: ref.taskId, workspace_key: ref.workspaceKey, action: 'enqueued', item }, null, 2)}\n`)
          } else {
            stdout(`${paintText(useStdoutColor, '◌', ANSI_DIM)} Enqueued instruction ${item.id} for ${ref.taskId}\n`)
          }
          return 0
        }

        const actor = stringFlag(flags, 'actor')
        const shouldWait = boolFlag(flags, 'wait')

        if (shouldWait) {
          let initialRunPromise: Promise<void> | undefined
          if (backend.mode === 'local') {
            initialRunPromise = backend
              .sendMessage(ref.taskId, { workspace_key: ref.workspaceKey, actor, message }, { background: false })
              .then(() => {})
          } else {
            await backend.sendMessage(
              ref.taskId,
              { workspace_key: ref.workspaceKey, actor, message },
              { background: true }
            )
          }
          const { summary, exitCode } = await waitForTaskCompletion(backend, ref.taskId, ref.workspaceKey, {
            timeoutSeconds: numberFlag(flags, 'timeout'),
            pollIntervalMs: numberFlag(flags, 'poll-interval'),
            includeTranscript: boolFlag(flags, 'transcript'),
            quiet,
            json,
            logStderr: stderr,
            initialRunPromise
          })
          stdout(json ? `${JSON.stringify(summary, null, 2)}\n` : formatResultText(summary))
          return exitCode
        }

        await backend.sendMessage(
          ref.taskId,
          { workspace_key: ref.workspaceKey, actor, message },
          { background: true }
        )

        if (json) {
          stdout(`${JSON.stringify({ task_id: ref.taskId, workspace_key: ref.workspaceKey, action: 'sent' }, null, 2)}\n`)
        } else {
          stdout(`${paintText(useStdoutColor, '●', ANSI_BY_COLOR.cyan)} Sent message to ${ref.taskId}\n`)
        }
        return 0
      }

      case 'pause':
      case 'interrupt': {
        const targetId = rest[0] ?? stringFlag(flags, 'task-id')
        if (!targetId) throw new Error(`Usage: buddy ${command} <task-id>`)
        const ref = await resolveTaskReference(backend, targetId, {
          workspaceKey: stringFlag(flags, 'workspace'),
          repoRoot: stringFlag(flags, 'repo'),
          cwd
        })
        await backend.interrupt(ref.taskId, ref.workspaceKey)
        if (json) {
          stdout(`${JSON.stringify({ task_id: ref.taskId, workspace_key: ref.workspaceKey, paused: true }, null, 2)}\n`)
        } else {
          stdout(`${paintText(useStdoutColor, '⏸', ANSI_BY_COLOR.amber)} Paused task ${ref.taskId}\n`)
        }
        return 0
      }

      case 'cancel': {
        const targetId = rest[0] ?? stringFlag(flags, 'task-id')
        if (!targetId) throw new Error('Usage: buddy cancel <task-id>')
        const ref = await resolveTaskReference(backend, targetId, {
          workspaceKey: stringFlag(flags, 'workspace'),
          repoRoot: stringFlag(flags, 'repo'),
          cwd
        })
        await backend.cancelTask(ref.taskId, ref.workspaceKey)
        if (json) {
          stdout(`${JSON.stringify({ task_id: ref.taskId, workspace_key: ref.workspaceKey, cancelled: true }, null, 2)}\n`)
        } else {
          stdout(`${paintText(useStdoutColor, '⊘', ANSI_DIM)} Cancelled task ${ref.taskId}\n`)
        }
        return 0
      }

      case 'delete':
      case 'rm': {
        const targetId = rest[0] ?? stringFlag(flags, 'task-id')
        if (!targetId) throw new Error(`Usage: buddy ${command} <task-id>`)
        const ref = await resolveTaskReference(backend, targetId, {
          workspaceKey: stringFlag(flags, 'workspace'),
          repoRoot: stringFlag(flags, 'repo'),
          cwd
        })
        await backend.deleteTask(ref.taskId, ref.workspaceKey)
        if (json) {
          stdout(`${JSON.stringify({ task_id: ref.taskId, workspace_key: ref.workspaceKey, deleted: true }, null, 2)}\n`)
        } else {
          stdout(`${paintText(useStdoutColor, '✓', ANSI_BY_COLOR.green)} Deleted task ${ref.taskId}\n`)
        }
        return 0
      }

      default:
        throw new Error(`Unknown command: ${command}. Run "buddy --help" for usage.`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const wantsJson = argv.includes('--json')
    if (wantsJson) {
      stdout(`${JSON.stringify({ error: message }, null, 2)}\n`)
    } else {
      const label = paintText(shouldUseColor('stderr'), '✗ Error:', ANSI_BY_COLOR.red)
      stderr(`${label} ${message}\n`)
    }
    return 1
  }
}
