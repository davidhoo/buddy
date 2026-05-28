import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type {
  CreateTaskInput,
  CreateTaskResult,
  Event,
  GlobalSettings,
  InstructionQueueItem,
  Launcher,
  Task,
  TaskDetail,
  TaskSettings,
  TaskState,
  TranscriptEntry
} from '../../shared/types'
import { normalizeGlobalSettings, normalizeLaunchers } from '../../shared/defaults'
import { canonicalRepoRoot, createBuddyPaths, taskDir, workspaceKeyForRepo } from './paths'
import { redactJsonValue } from './redact'
import { parseEventLine, parseGlobalSettings, parseTaskSettings, parseTaskState } from './schemas'

interface TaskMeta {
  task_text?: string
  context_text?: string
}

const ACTORS = ['claude', 'codex', 'opencode', 'kimi'] as const

export class BuddyStore {
  constructor(public readonly dataRoot: string) {}

  async getTasks(): Promise<Task[]> {
    const paths = createBuddyPaths(this.dataRoot)
    const workspaceKeys = await listDirectoryNames(paths.workspacesDir)
    const tasks: Task[] = []

    for (const workspaceKey of workspaceKeys) {
      const tasksDir = join(paths.workspacesDir, workspaceKey, 'tasks')
      const taskIds = await listDirectoryNames(tasksDir)
      for (const taskId of taskIds) {
        try {
          const state = await this.readTaskState(taskId, workspaceKey)
          tasks.push({
            task_id: taskId,
            workspace_key: workspaceKey,
            status: state.status,
            updated_at: state.updated_at ?? '',
            repo_root: state.repo_root ?? '',
            round: state.round,
            active_run: state.active_run ?? null
          })
        } catch {
          // Ignore unreadable task directories; schema errors surface on detail load.
        }
      }
    }

    return tasks.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  async getTaskDetail(taskId: string, workspaceKey: string): Promise<TaskDetail> {
    const state = await this.readTaskState(taskId, workspaceKey)
    const settings = await this.readTaskSettings(taskId, workspaceKey)
    const meta = await this.readTaskMeta(taskId, workspaceKey)
    const events = await this.readEvents(taskId, workspaceKey)

    return {
      task_id: taskId,
      workspace_key: workspaceKey,
      state,
      settings,
      task_text: meta.task_text ?? '',
      context_text: meta.context_text ?? '',
      transcript: await this.readTranscript(taskId, workspaceKey),
      events,
      latest_failure: state.latest_failure ?? state.last_error ?? null
    }
  }

  async getEvents(taskId: string, since: number, workspaceKey: string): Promise<{ events: Event[] }> {
    const events = await this.readEvents(taskId, workspaceKey)
    return { events: events.filter((event) => event.seq > since) }
  }

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const repoRoot = canonicalRepoRoot(input.repo_root ?? '')
    const workspaceKey = workspaceKeyForRepo(repoRoot || input.task_id)
    const taskId = await deduplicateTaskId(input.task_id, this.taskDirectory.bind(this), workspaceKey)
    const dir = this.taskDirectory(taskId, workspaceKey)
    const now = utcNow()
    const taskText = taskMarkdownContent(input.task_text ?? '')
    const contextText = contextMarkdownContent(input.context_text ?? '')

    const globalSettings = await this.readGlobalSettings()
    const settings = defaultTaskSettings(globalSettings, input.settings)
    const state = defaultTaskState(taskId, repoRoot, settings, contextText, now)
    state.event_seq = 1

    await mkdir(join(dir, 'rounds'), { recursive: true })
    await mkdir(join(dir, 'artifacts'), { recursive: true })
    await this.writeWorkspaceMetadata(workspaceKey, repoRoot, now)
    await atomicWriteText(join(dir, 'task.md'), taskText)
    await atomicWriteText(join(dir, 'context.md'), contextText)
    await atomicWriteJson(join(dir, 'settings.json'), settings)
    await atomicWriteJson(join(dir, 'state.json'), state)
    await atomicWriteText(join(dir, 'status'), `${state.status}\n`)
    await atomicAppendText(join(dir, '.buddy.lock'), '')
    await appendEventLine(join(dir, 'events.jsonl'), {
      seq: 1,
      task_id: taskId,
      type: 'task.created',
      ts: now,
      payload: {
        task_id: taskId
      }
    })

    return { task: taskId, path: dir, workspace_key: workspaceKey }
  }

  async deleteTask(taskId: string, workspaceKey: string): Promise<void> {
    await rm(this.taskDirectory(taskId, workspaceKey), { recursive: true, force: true })
  }

  async updateGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
    const path = createBuddyPaths(this.dataRoot).globalSettings
    const normalized = normalizeGlobalSettings(settings)
    await atomicWriteJson(path, normalized)
    return normalized
  }

  async readGlobalSettings(): Promise<GlobalSettings> {
    const path = createBuddyPaths(this.dataRoot).globalSettings
    const legacyPath = join(this.dataRoot, 'global_settings.json')
    try {
      const parsed = parseGlobalSettings(await readJson(path)) as GlobalSettings
      return normalizeGlobalSettings(parsed)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }

    try {
      const parsed = parseGlobalSettings(await readJson(legacyPath)) as GlobalSettings
      return normalizeGlobalSettings(parsed)
    } catch (error) {
      if (isNotFoundError(error)) return normalizeGlobalSettings()
      throw error
    }
  }

  async readTaskState(taskId: string, workspaceKey: string): Promise<TaskState> {
    return parseTaskState(await readJson(this.statePath(taskId, workspaceKey))) as TaskState
  }

  async readTaskSettings(taskId: string, workspaceKey: string): Promise<TaskSettings> {
    return parseTaskSettings(await readJson(this.settingsPath(taskId, workspaceKey))) as TaskSettings
  }

  async updateTaskState(
    taskId: string,
    workspaceKey: string,
    update: (state: TaskState) => TaskState
  ): Promise<TaskState> {
    const next = update(await this.readTaskState(taskId, workspaceKey))
    return this.writeTaskState(taskId, workspaceKey, next)
  }

  async appendTaskEvent(
    taskId: string,
    workspaceKey: string,
    event: Omit<Event, 'seq' | 'ts'> & Partial<Pick<Event, 'seq' | 'ts'>>
  ): Promise<Event> {
    const events = await this.readEvents(taskId, workspaceKey)
    const state = await this.readTaskState(taskId, workspaceKey)
    const next: Event = {
      seq: event.seq ?? Math.max(
        state.event_seq ?? 0,
        events.reduce((max, item) => Math.max(max, item.seq), 0)
      ) + 1,
      task_id: taskId,
      ts: event.ts ?? utcNow(),
      type: event.type,
      actor: event.actor,
      run_id: event.run_id,
      payload: event.payload
    }
    const redacted = redactJsonValue(next)
    await appendEventLine(this.eventsPath(taskId, workspaceKey), redacted)
    await this.writeTaskState(taskId, workspaceKey, {
      ...state,
      event_seq: next.seq
    })
    return redacted
  }

  async appendTranscript(
    taskId: string,
    workspaceKey: string,
    role: TranscriptEntry['role'],
    content: string,
    meta: Record<string, unknown> = {}
  ): Promise<TranscriptEntry> {
    const state = await this.readTaskState(taskId, workspaceKey)
    const seq = (state.transcript_seq ?? 0) + 1
    const row = {
      seq,
      ts: utcNow(),
      role,
      content,
      meta
    }
    await atomicAppendText(
      this.transcriptJsonlPath(taskId, workspaceKey),
      `${stringifyPythonJsonLine(row)}\n`
    )
    await this.writeTaskState(taskId, workspaceKey, {
      ...state,
      transcript_seq: seq
    })
    return row
  }

  async enqueueInstruction(
    taskId: string,
    workspaceKey: string,
    content: string
  ): Promise<InstructionQueueItem> {
    const item: InstructionQueueItem = {
      id: `qi_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      content,
      created_at: utcNow()
    }
    await this.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      instruction_queue: [...(state.instruction_queue ?? []), item]
    }))
    return item
  }

  async dequeueInstruction(
    taskId: string,
    workspaceKey: string,
    itemId: string
  ): Promise<void> {
    await this.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      instruction_queue: (state.instruction_queue ?? []).filter((item) => item.id !== itemId)
    }))
  }

  async clearInstructionQueue(
    taskId: string,
    workspaceKey: string
  ): Promise<void> {
    await this.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      instruction_queue: []
    }))
  }

  async drainInstructionQueue(
    taskId: string,
    workspaceKey: string
  ): Promise<InstructionQueueItem[]> {
    const state = await this.readTaskState(taskId, workspaceKey)
    const items = state.instruction_queue ?? []
    if (items.length === 0) return []
    await this.writeTaskState(taskId, workspaceKey, {
      ...state,
      instruction_queue: []
    })
    return items
  }

  taskDirectory(taskId: string, workspaceKey: string): string {
    return taskDir(createBuddyPaths(this.dataRoot), workspaceKey, taskId)
  }

  statePath(taskId: string, workspaceKey: string): string {
    return join(this.taskDirectory(taskId, workspaceKey), 'state.json')
  }

  settingsPath(taskId: string, workspaceKey: string): string {
    return join(this.taskDirectory(taskId, workspaceKey), 'settings.json')
  }

  eventsPath(taskId: string, workspaceKey: string): string {
    return join(this.taskDirectory(taskId, workspaceKey), 'events.jsonl')
  }

  transcriptJsonlPath(taskId: string, workspaceKey: string): string {
    return join(this.taskDirectory(taskId, workspaceKey), 'transcript.jsonl')
  }

  private async writeWorkspaceMetadata(workspaceKey: string, repoRoot: string, now: string): Promise<void> {
    await atomicWriteJson(join(createBuddyPaths(this.dataRoot).workspacesDir, workspaceKey, 'workspace.json'), {
      protocol_version: '1',
      workspace_key: workspaceKey,
      default_repo_root: repoRoot,
      updated_at: now
    })
  }

  private async readTaskMeta(taskId: string, workspaceKey: string): Promise<TaskMeta> {
    const markdown = await this.readMarkdownTaskMeta(taskId, workspaceKey)
    if (markdown) return markdown

    const path = join(this.taskDirectory(taskId, workspaceKey), 'task.json')
    try {
      return await readJson(path) as TaskMeta
    } catch {
      return { task_text: '', context_text: '' }
    }
  }

  private async readMarkdownTaskMeta(taskId: string, workspaceKey: string): Promise<TaskMeta | null> {
    const dir = this.taskDirectory(taskId, workspaceKey)
    const [taskText, contextText] = await Promise.all([
      readOptionalText(join(dir, 'task.md')),
      readOptionalText(join(dir, 'context.md'))
    ])
    if (!taskText && !contextText) return null
    return {
      task_text: taskText,
      context_text: contextText
    }
  }

  private async readEvents(taskId: string, workspaceKey: string): Promise<Event[]> {
    const path = this.eventsPath(taskId, workspaceKey)
    try {
      const text = await readFile(path, 'utf8')
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map(parseEventLine) as Event[]
    } catch {
      return []
    }
  }

  private async readTranscript(
    taskId: string,
    workspaceKey: string
  ): Promise<TranscriptEntry[]> {
    return this.readTranscriptJsonl(taskId, workspaceKey)
  }

  private async readTranscriptJsonl(taskId: string, workspaceKey: string): Promise<TranscriptEntry[]> {
    const text = await readOptionalText(this.transcriptJsonlPath(taskId, workspaceKey))
    if (!text.trim()) return []

    return text.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return []
      try {
        return transcriptEntryFromJson(JSON.parse(line))
      } catch {
        return []
      }
    })
  }

  private async writeTaskState(taskId: string, workspaceKey: string, state: TaskState): Promise<TaskState> {
    const current = await readOptionalJson(this.statePath(taskId, workspaceKey)) as Partial<TaskState>
    const next = {
      ...state,
      protocol_version: '1',
      event_seq: Math.max(numberValue(state.event_seq) ?? 0, numberValue(current?.event_seq) ?? 0),
      transcript_seq: Math.max(numberValue(state.transcript_seq) ?? 0, numberValue(current?.transcript_seq) ?? 0),
      updated_at: utcNow()
    } as TaskState
    await atomicWriteJson(this.statePath(taskId, workspaceKey), next)
    await atomicWriteText(join(this.taskDirectory(taskId, workspaceKey), 'status'), `${next.status}\n`)
    return next
  }
}

const TRANSCRIPT_ROLES = new Set<TranscriptEntry['role']>([
  'human',
  'claude',
  'codex',
  'opencode',
  'kimi',
  'system'
])

function transcriptEntryFromJson(value: unknown): TranscriptEntry[] {
  const row = objectValue(value)
  if (!row) return []
  const role = normalizeTranscriptRole(row.role)
  const content = textValue(row.content)
  if (!role || !content) return []
  const entry: TranscriptEntry & { seq?: number } = {
    role,
    content,
    ts: textValue(row.ts) ?? '',
    meta: objectValue(row.meta) ?? {}
  }
  const seq = numberValue(row.seq)
  if (seq != null) entry.seq = seq
  return [entry]
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeTranscriptRole(value: unknown): TranscriptEntry['role'] | null {
  if (typeof value !== 'string') return null
  const role = value.trim().toLowerCase()
  return TRANSCRIPT_ROLES.has(role as TranscriptEntry['role'])
    ? role as TranscriptEntry['role']
    : null
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function listDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return await readJson(path)
  } catch {
    return {}
  }
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, stringifyJson(value))
}

async function atomicWriteText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(tmp, value)
  await rename(tmp, path)
}

async function appendEventLine(path: string, event: Event): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${stringifyJsonLine(event)}\n`, { flag: 'a' })
}

async function atomicAppendText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, { flag: 'a' })
}

function defaultTaskSettings(
  globalSettings: GlobalSettings,
  overrides: Record<string, unknown> = {}
): TaskSettings {
  const normalizedGlobal = normalizeGlobalSettings(globalSettings)
  const { launchers: overrideLaunchers, ...restOverrides } = overrides
  const launchers = normalizeLaunchers({
    ...normalizedGlobal.launchers,
    ...coerceLauncherOverrides(overrideLaunchers)
  })

  return {
    protocol_version: normalizedGlobal.protocol_version ?? '1',
    flow_policy: 'claude_then_codex',
    role_mode: 'claude_implements',
    max_consecutive_failures: normalizedGlobal.max_consecutive_failures,
    launchers,
    seed_claude_session_id: normalizedGlobal.seed_claude_session_id ?? '',
    seed_codex_thread_id: normalizedGlobal.seed_codex_thread_id ?? '',
    seed_opencode_session_id: '',
    seed_kimi_session_id: '',
    ...restOverrides
  } as TaskSettings
}

function coerceLauncherOverrides(value: unknown): Record<string, Partial<Launcher>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const launchers: Record<string, Partial<Launcher>> = {}
  for (const [actor, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const candidate = raw as Partial<Launcher>
    launchers[actor] = {
      command: candidate.command,
      env: candidate.env,
      timeout_seconds: candidate.timeout_seconds
    }
  }
  return launchers
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function deduplicateTaskId(
  baseId: string,
  taskDirOf: (id: string, ws: string) => string,
  workspaceKey: string
): Promise<string> {
  if (!await directoryExists(taskDirOf(baseId, workspaceKey))) return baseId
  for (let i = 2; i <= 999; i++) {
    const candidate = `${baseId}_${i}`
    if (!await directoryExists(taskDirOf(candidate, workspaceKey))) return candidate
  }
  throw new Error(`Cannot deduplicate task ID: ${baseId}`)
}

function defaultTaskState(
  taskId: string,
  repoRoot: string,
  settings: TaskSettings,
  contextText: string,
  now: string
): TaskState {
  const initialActor = settings.implementer_actor
    || (settings.role_mode === 'codex_implements' ? 'codex' : 'claude')
  return {
    protocol_version: '1',
    task_id: taskId,
    repo_root: repoRoot,
    status: 'READY',
    round: 0,
    rounds_in_window: 0,
    next_actor: initialActor,
    claude_session_id: null,
    codex_thread_id: null,
    opencode_session_id: null,
    kimi_session_id: null,
    context_hash: sha256Hex(contextText),
    context_sent: Object.fromEntries(ACTORS.map((actor) => [actor, false])),
    active_run: null,
    instruction_queue: [],
    countdown: null,
    last_error: null,
    latest_failure: null,
    event_seq: 0,
    transcript_seq: 0,
    consecutive_failures: 0,
    created_at: now,
    updated_at: now,
    pending_break: null
  }
}

function taskMarkdownContent(value: string): string {
  return `${value.trimEnd()}\n`
}

function contextMarkdownContent(value: string): string {
  const trimmed = value.trimEnd()
  return trimmed ? `${trimmed}\n` : ''
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`
}

function stringifyJsonLine(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function stringifyPythonJsonLine(value: unknown): string {
  return stringifyPythonJsonValue(sortJsonValue(value))
}

function stringifyPythonJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stringifyPythonJsonValue).join(', ')}]`
  }
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}: ${stringifyPythonJsonValue(item)}`)
    .join(', ')}}`
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, sortJsonValue(item)])
  )
}
