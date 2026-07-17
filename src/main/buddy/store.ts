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
  AttachmentMeta,
  CreateTaskResult,
  Event,
  GlobalSettings,
  InstructionQueueItem,
  Launcher,
  RoundEventEntry,
  RoundEventSummary,
  Task,
  TaskActorStats,
  TaskDetail,
  TaskSettings,
  TaskState,
  TaskStats,
  TranscriptEntry
} from '../../shared/types'
import { normalizeGlobalSettings, normalizeLaunchers } from '../../shared/defaults'
import { canonicalRepoRoot, createBuddyPaths, taskDir, workspaceKeyForRepo } from './paths'
import { redactJsonValue } from './redact'
import { detectModelFromConfig } from './model-detect'
import { parseJsonlBuffer } from './parsers'
import { parseEventLine, parseGlobalSettings, parseTaskSettings, parseTaskState } from './schemas'

interface TaskMeta {
  task_text?: string
  context_text?: string
}

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
            active_run: state.active_run ?? null,
            execution_mode: state.execution_mode ?? 'immediate',
            queue: state.queue,
            created_at: state.created_at
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
    const executionMode: 'immediate' | 'queued' = input.execution_mode ?? 'immediate'
    const state = defaultTaskState(taskId, repoRoot, settings, contextText, now)
    if (executionMode === 'queued') {
      state.status = 'QUEUED'
      state.execution_mode = 'queued'
      state.queue = {
        state: 'waiting',
        enqueued_at: now
      }
    } else {
      state.execution_mode = 'immediate'
    }
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
    const initialEvent: Omit<Event, 'seq' | 'ts'> & Partial<Pick<Event, 'seq' | 'ts'>> = {
      task_id: taskId,
      type: 'task.created',
      payload: {
        task_id: taskId,
        execution_mode: executionMode
      }
    }
    await appendEventLine(join(dir, 'events.jsonl'), {
      ...initialEvent,
      seq: 1,
      ts: now
    } as Event)
    if (executionMode === 'queued') {
      await appendEventLine(join(dir, 'events.jsonl'), {
        seq: 2,
        task_id: taskId,
        type: 'task.queued',
        ts: now,
        payload: {
          workspace_key: workspaceKey,
          task_id: taskId,
          enqueued_at: now
        }
      })
    }

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
    content: string,
    attachments?: AttachmentMeta[]
  ): Promise<InstructionQueueItem> {
    const item: InstructionQueueItem = {
      id: `qi_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      content,
      created_at: utcNow(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined
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

  async getRoundEvents(taskId: string, runId: string, workspaceKey: string, actor?: string, command?: string): Promise<RoundEventSummary | null> {
    const dir = this.taskDirectory(taskId, workspaceKey)
    const eventsPath = join(dir, 'artifacts', `${runId}-events.jsonl`)
    const raw = await readOptionalText(eventsPath)
    if (!raw.trim()) return null
    let configuredLauncher: Launcher | undefined
    if (actor) {
      try {
        const settings = await this.readTaskSettings(taskId, workspaceKey)
        configuredLauncher = settings.launchers?.[actor]
        if (!command && configuredLauncher?.command) command = configuredLauncher.command
      } catch {
        // Legacy/incomplete task settings do not block artifact inspection.
      }
    }
    const cursorPartialOutput = configuredLauncher?.cursor?.stream_partial_output === true

    const events: RoundEventEntry[] = []
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let durationMs: number | undefined
    let costUsd: number | undefined
    let model: string | undefined
    let firstTs: number | undefined
    let lastTs: number | undefined

    for (const event of parseJsonlBuffer(raw)) {
      // Track timestamps for duration calculation
      const ts = event.timestamp ?? event.ts
      if (typeof ts === 'number') {
        if (firstTs == null || ts < firstTs) firstTs = ts
        if (lastTs == null || ts > lastTs) lastTs = ts
      } else if (typeof ts === 'string') {
        const ms = new Date(ts).getTime()
        if (!Number.isNaN(ms)) {
          if (firstTs == null || ms < firstTs) firstTs = ms
          if (lastTs == null || ms > lastTs) lastTs = ms
        }
      }

      // Claude stream-json format
      if (event.type === 'system' && event.subtype === 'init') {
        model = event.model as string | undefined
      }

      const duplicateCursorPartial = cursorPartialOutput
        && (event.model_call_id != null || typeof event.timestamp_ms !== 'number')
      if (event.type === 'assistant' && !duplicateCursorPartial && Array.isArray((event.message as Record<string, unknown>)?.content)) {
        for (const part of (event.message as Record<string, unknown>).content as Record<string, unknown>[]) {
          if (part.type === 'thinking') {
            events.push({ type: 'thinking', thinkingLength: (part.thinking as string)?.length ?? 0 })
          } else if (part.type === 'text') {
            events.push({ type: 'text', text: part.text as string })
          } else if (part.type === 'tool_use') {
            events.push({ type: 'tool_use', toolName: part.name as string, toolInput: part.input as Record<string, unknown> })
          }
        }
      }

      // Cursor Agent stream-json tool events.
      if (event.type === 'tool_call') {
        const toolCall = objectValue(event.tool_call)
        const [toolKind, payloadValue] = Object.entries(toolCall ?? {})[0] ?? []
        const payload = objectValue(payloadValue)
        const args = objectValue(payload?.args)
        const toolName = toolKind?.replace(/ToolCall$/, '') || 'tool'
        if (event.subtype === 'started') {
          events.push({ type: 'tool_use', toolName, toolInput: args })
        } else if (event.subtype === 'completed') {
          const result = payload?.result
          const preview = result == null
            ? ''
            : (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 200)
          events.push({ type: 'tool_result', toolResultPreview: preview })
        }
      }

      if (event.type === 'user' && Array.isArray((event.message as Record<string, unknown>)?.content)) {
        for (const part of (event.message as Record<string, unknown>).content as Record<string, unknown>[]) {
          if (part.type === 'tool_result') {
            const preview = typeof part.content === 'string'
              ? part.content.slice(0, 200)
              : JSON.stringify(part.content).slice(0, 200)
            events.push({ type: 'tool_result', toolResultPreview: preview, isError: part.is_error as boolean | undefined })
          }
        }
      }

      if (event.type === 'result') {
        if (event.usage) {
          const u = event.usage as Record<string, unknown>
          inputTokens = (u.input_tokens as number) ?? inputTokens
          outputTokens = (u.output_tokens as number) ?? outputTokens
          cacheReadTokens = (u.cache_read_input_tokens as number) ?? cacheReadTokens
        }
        if (event.duration_ms != null) durationMs = event.duration_ms as number
        if (event.total_cost_usd != null) costUsd = event.total_cost_usd as number
        if (event.model) model = event.model as string
        // Claude's result event has modelUsage with model name as key
        // e.g. modelUsage: { "thudm-glm-5.1": { inputTokens: ..., ... } }
        if (!model && event.modelUsage && typeof event.modelUsage === 'object') {
          const keys = Object.keys(event.modelUsage as Record<string, unknown>)
          if (keys.length > 0) model = keys[0]
        }
      }

      // Codex format: content array with tool_call / text
      if (Array.isArray(event.content)) {
        for (const part of event.content as Record<string, unknown>[]) {
          if (part.type === 'tool_call' && part.name) {
            events.push({ type: 'tool_use', toolName: part.name as string, toolInput: part.input as Record<string, unknown> | undefined })
          } else if (part.type === 'text' && part.text) {
            events.push({ type: 'text', text: part.text as string })
          }
        }
      }
      if (event.type === 'response.completed' && event.response) {
        const resp = event.response as Record<string, unknown>
        if (resp.usage) {
          inputTokens = (resp.usage as Record<string, unknown>).input_tokens as number ?? inputTokens
          outputTokens = (resp.usage as Record<string, unknown>).output_tokens as number ?? outputTokens
        }
        if (resp.model) model = resp.model as string
      }

      // Kimi format: role=assistant with content
      if (event.role === 'assistant' && typeof event.content === 'string' && event.content.trim()) {
        events.push({ type: 'text', text: event.content })
      }
      // Kimi tool calls
      if (Array.isArray(event.tool_calls)) {
        for (const tc of event.tool_calls as Record<string, unknown>[]) {
          events.push({ type: 'tool_use', toolName: (tc.function ?? tc.name) as string | undefined, toolInput: tc.arguments as Record<string, unknown> | undefined })
        }
      }
      // Kimi/OpenAI-compatible: usage and model in final response
      if (event.usage && typeof event.usage === 'object') {
        const u = event.usage as Record<string, unknown>
        if (u.input_tokens != null) inputTokens = (u.input_tokens as number) ?? inputTokens
        if (u.prompt_tokens != null) inputTokens = (u.prompt_tokens as number) ?? inputTokens
        if (u.output_tokens != null) outputTokens = (u.output_tokens as number) ?? outputTokens
        if (u.completion_tokens != null) outputTokens = (u.completion_tokens as number) ?? outputTokens
      }
      if (event.model && typeof event.model === 'string' && !model) {
        model = event.model as string
      }

      // OpenCode format: tool_use events with part.tool, input in part.state.input
      if (event.type === 'tool_use') {
        const part = objectValue(event.part)
        const toolName = (part?.tool ?? 'tool') as string
        // OpenCode stores tool input in part.state.input, not part.input
        const state = objectValue(part?.state)
        const toolInput = (state?.input ?? part?.input) as Record<string, unknown> | undefined
        events.push({ type: 'tool_use', toolName, toolInput })
        // OpenCode tool result is in part.state.output
        if (state?.output) {
          const preview = typeof state.output === 'string'
            ? state.output.slice(0, 200)
            : JSON.stringify(state.output).slice(0, 200)
          const isError = state.status === 'error' || (state.metadata as Record<string, unknown>)?.exit !== 0 && (state.metadata as Record<string, unknown>)?.exit != null
          events.push({ type: 'tool_result', toolResultPreview: preview, isError: isError as boolean | undefined })
        }
      }
      if (event.type === 'text') {
        const part = objectValue(event.part)
        const t = part?.text as string | undefined
        if (t) events.push({ type: 'text', text: t })
      }
      // OpenCode step_finish: tokens in part.tokens, cost in part.cost, model in part.respondedModelID
      if (event.type === 'step_finish') {
        const part = objectValue(event.part)
        const tokens = objectValue(part?.tokens)
        if (tokens) {
          const cacheRead = (objectValue(tokens.cache)?.read as number) ?? 0
          inputTokens = (tokens.input as number) ?? 0
          cacheReadTokens = cacheRead
          outputTokens = (tokens.output as number) ?? outputTokens
        }
        if (part?.cost != null) costUsd = part.cost as number
        if (part?.respondedModelID) model = part.respondedModelID as string
        else if (part?.requestedModelID) model = part.requestedModelID as string
      }

      // Generic: item.text
      if (event.item && typeof event.item === 'object' && !Array.isArray(event.item)) {
        const itemText = (event.item as Record<string, unknown>).text as string | undefined
        if (itemText) events.push({ type: 'text', text: itemText })
      }
    }

    // Fallback: compute duration from event timestamps if not provided by actor
    if (durationMs == null && firstTs != null && lastTs != null && lastTs > firstTs) {
      durationMs = lastTs - firstTs
    }

    // Fallback: use the explicit profile model, then inspect legacy CLI config.
    if (!model && actor) {
      if (configuredLauncher?.model?.trim()) model = configuredLauncher.model.trim()
      if (!model) model = await detectModelFromConfig(actor, command)
    }

    return { runId, events, inputTokens, outputTokens, cacheReadTokens, durationMs, costUsd, model }
  }

  async getTaskStats(taskId: string, workspaceKey: string): Promise<TaskStats | null> {
    const transcript = await this.readTranscriptJsonl(taskId, workspaceKey)
    if (transcript.length === 0) return null

    // Collect run_ids grouped by actor, and track elapsed_ms per run
    const actorRuns = new Map<string, { runId: string; elapsedMs: number }[]>()

    for (const entry of transcript) {
      if (entry.role === 'human' || entry.role === 'system') continue
      const meta = entry.meta as Record<string, unknown> | undefined
      const runId = meta?.run_id as string | undefined
      if (!runId) continue
      const elapsedMs = (meta?.elapsed_ms as number) ?? 0
      if (!actorRuns.has(entry.role)) {
        actorRuns.set(entry.role, [])
      }
      actorRuns.get(entry.role)!.push({ runId, elapsedMs })
    }

    if (actorRuns.size === 0) return null

    const actors: TaskActorStats[] = []

    for (const [actor, runs] of actorRuns) {
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let durationMs = 0
      let costUsd: number | undefined
      let model: string | undefined

      for (const run of runs) {
        durationMs += run.elapsedMs
        const summary = await this.getRoundEvents(taskId, run.runId, workspaceKey, actor)
        if (summary) {
          inputTokens += summary.inputTokens
          outputTokens += summary.outputTokens
          cacheReadTokens += summary.cacheReadTokens
          if (summary.durationMs != null && summary.durationMs > 0) {
            // Use actor-reported duration if available, otherwise fall back to elapsed_ms
            durationMs = durationMs - run.elapsedMs + summary.durationMs
          }
          if (summary.costUsd != null) {
            costUsd = (costUsd ?? 0) + summary.costUsd
          }
          // Use the latest model reported by the actor
          if (summary.model) model = summary.model
        }
      }

      actors.push({
        actor,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        durationMs,
        costUsd,
        rounds: runs.length
      })
    }

    const totalInputTokens = actors.reduce((s, a) => s + a.inputTokens, 0)
    const totalOutputTokens = actors.reduce((s, a) => s + a.outputTokens, 0)
    const totalCacheReadTokens = actors.reduce((s, a) => s + a.cacheReadTokens, 0)
    const totalDurationMs = actors.reduce((s, a) => s + a.durationMs, 0)
    const totalRounds = actors.reduce((s, a) => s + a.rounds, 0)
    const hasCost = actors.some(a => a.costUsd != null)
    const totalCostUsd = hasCost ? actors.reduce((s, a) => s + (a.costUsd ?? 0), 0) : undefined

    return {
      actors,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalDurationMs,
      totalCostUsd,
      totalRounds
    }
  }

  private async writeWorkspaceMetadata(workspaceKey: string, repoRoot: string, now: string): Promise<void> {
    await atomicWriteJson(join(createBuddyPaths(this.dataRoot).workspacesDir, workspaceKey, 'workspace.json'), {
      protocol_version: '1',
      workspace_key: workspaceKey,
      default_repo_root: repoRoot,
      updated_at: now
    })
  }

  async updateTaskText(taskId: string, workspaceKey: string, taskText: string): Promise<void> {
    const dir = this.taskDirectory(taskId, workspaceKey)
    await atomicWriteText(join(dir, 'task.md'), taskMarkdownContent(taskText))
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

  async readTranscriptJsonl(taskId: string, workspaceKey: string): Promise<TranscriptEntry[]> {
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

const TRANSCRIPT_ROLES = new Set([
  'human',
  'claude',
  'codex',
  'opencode',
  'kimi',
  'cursor',
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
  const role = value.trim()
  if (!role) return null
  const builtin = role.toLowerCase()
  return TRANSCRIPT_ROLES.has(builtin) ? builtin : role
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
    seed_agent_sessions: {},
    prompt_presets: normalizedGlobal.prompt_presets?.map((preset) => ({ ...preset })) ?? [],
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
      ...candidate,
      env: candidate.env ? { ...candidate.env } : undefined,
      cursor: candidate.cursor
        ? {
            ...candidate.cursor,
            extra_args: candidate.cursor.extra_args ? [...candidate.cursor.extra_args] : undefined
          }
        : undefined
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
    agent_sessions: {},
    context_hash: sha256Hex(contextText),
    context_sent: Object.fromEntries(
      [...new Set([
        ...Object.keys(settings.launchers),
        settings.implementer_actor,
        settings.reviewer_actor
      ].filter((actor): actor is string => Boolean(actor)))].map((actor) => [actor, false])
    ),
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
    pending_break: null,
    break_rejected_by: null,
    health_check: null,
    execution_mode: 'immediate'
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
