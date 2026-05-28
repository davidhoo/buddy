import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AttachmentMeta,
  CountdownInput,
  GlobalSettings,
  InstructionQueueItem,
  SendMessageInput,
  StartTaskInput,
  TaskSettings,
  TranscriptEntry,
  TaskState
} from '../../shared/types'
import { buildLauncherCommand, commandKindFor, runLauncher, type LauncherCommandKind } from './launchers'
import { createRunLock, removeRunLock } from './locks'
import { extractActorOutput, parseActorEvents, parseBuddyMessage, ParsedActorLine } from './parsers'
import { buildActorPrompt, hashText, nextActor as nextActorForSettings } from './prompts'
import { BuddyStore } from './store'

const ACTOR_STATUS: Record<string, TaskState['status']> = {
  claude: 'RUNNING_CLAUDE',
  codex: 'RUNNING_CODEX',
  opencode: 'RUNNING_OPENCODE',
  kimi: 'RUNNING_KIMI'
}

interface RunnerOptions {
  executeLaunchers?: boolean
}

export class BuddyRunner {
  private readonly executeLaunchers: boolean

  constructor(
    private readonly store: BuddyStore,
    options: RunnerOptions = {}
  ) {
    this.executeLaunchers = options.executeLaunchers ?? true
  }

  async startTask(taskId: string, input: StartTaskInput): Promise<{ run_id: string }> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const workspaceKey = input.workspace_key
    const detail = await this.store.getTaskDetail(taskId, workspaceKey)
    const globalSettings = await this.store.readGlobalSettings()
    const actor = input.actor
      ?? (detail.state.status === 'FAILED' ? (detail.state.latest_failure?.actor ?? detail.state.last_error?.actor) : undefined)
      ?? detail.state.next_actor
      ?? 'claude'
    const status = ACTOR_STATUS[actor]
    if (!status) throw new Error(`Unsupported actor: ${actor}`)
    if (!canStartFrom(detail.state.status)) {
      throw new Error(`Cannot start task from ${detail.state.status}`)
    }
    const maxRounds = globalSettings.max_rounds ?? 9999
    const roundsInWindow = detail.state.rounds_in_window ?? 0
    if (maxRounds > 0 && roundsInWindow >= maxRounds) {
      await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
        ...state,
        status: 'PAUSED',
        active_run: null,
        countdown: null,
        updated_at: new Date().toISOString()
      }))
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'round_window.paused',
        payload: { max_rounds: maxRounds, rounds_in_window: roundsInWindow }
      })
      throw new Error(`本次自动推进已达到自动轮次上限。点击“继续”可以再推进 ${maxRounds} 轮。`)
    }

    const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    const startedAt = new Date().toISOString()
    const sessionIdBefore = sessionIdForActor(actor, detail.state, detail.settings)

    await this.store.updateTaskState(taskId, workspaceKey, (state) => {
      if (!canStartFrom(state.status)) {
        throw new Error(`Cannot start task from ${state.status}`)
      }
      return {
        ...state,
        status,
        active_run: {
          run_id: runId,
          actor,
          started_at: startedAt,
          status: 'running',
          session_id_before: sessionIdBefore ?? null,
          session_id_after: null
        },
        countdown: null,
        latest_failure: null,
        last_error: null,
        updated_at: startedAt
      }
    })
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: 'actor.started',
      actor,
      run_id: runId,
      payload: { run_id: runId, mode: sessionIdBefore ? 'resume' : 'start' }
    })

    if (!this.executeLaunchers) {
      return { run_id: runId }
    }

    await this.executeActor(taskId, workspaceKey, actor, runId, input.message ?? '')
    return { run_id: runId }
  }

  async sendMessage(taskId: string, input: SendMessageInput): Promise<void> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const message = input.message ?? ''
    if (!message.trim()) throw new Error('message is required')
    const meta: Record<string, unknown> = { source: 'run_once' }
    if (input.attachmentMeta && input.attachmentMeta.length > 0) {
      meta.attachments = input.attachmentMeta
    }
    await this.store.appendTranscript(
      taskId,
      input.workspace_key,
      'human',
      message,
      meta
    )
    await this.store.appendTaskEvent(taskId, input.workspace_key, {
      type: 'human.message',
      actor: input.actor,
      payload: { content: message }
    })
    await this.startTask(taskId, {
      workspace_key: input.workspace_key,
      actor: input.actor,
      message
    })
  }

  async pauseCountdown(taskId: string, input: CountdownInput): Promise<void> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const detail = await this.store.getTaskDetail(taskId, input.workspace_key)
    if (detail.state.status !== 'COUNTDOWN') return
    const actor = input.next_actor ?? detail.state.next_actor ?? detail.state.countdown?.default_next_actor ?? 'claude'
    await this.store.updateTaskState(taskId, input.workspace_key, (state) => {
      const countdown = state.countdown ?? { status: 'running' as const, remaining: 0, default_next_actor: actor }
      return {
        ...state,
        status: 'READY',
        next_actor: actor,
        countdown: { ...countdown, status: 'paused' },
        updated_at: new Date().toISOString()
      }
    })
    await this.store.appendTaskEvent(taskId, input.workspace_key, {
      type: 'countdown.paused',
      payload: { next_actor: actor }
    })
  }

  async skipCountdown(taskId: string, input: CountdownInput): Promise<{ run_id: string }> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const detail = await this.store.getTaskDetail(taskId, input.workspace_key)
    if (detail.state.status !== 'COUNTDOWN') throw new Error(`当前任务不在倒计时中：${taskId}`)
    const actor = input.next_actor ?? detail.state.next_actor ?? detail.state.countdown?.default_next_actor
    if (!actor) throw new Error('next actor is required')
    await this.store.updateTaskState(taskId, input.workspace_key, (state) => ({
      ...state,
      status: 'READY',
      next_actor: actor,
      countdown: state.countdown ? { ...state.countdown, status: 'skipped' } : undefined,
      updated_at: new Date().toISOString()
    }))
    await this.store.appendTaskEvent(taskId, input.workspace_key, {
      type: 'countdown.skipped',
      payload: { next_actor: actor }
    })
    return this.startTask(taskId, { workspace_key: input.workspace_key, actor })
  }

  async interrupt(taskId: string, workspaceKey: string): Promise<void> {
    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      status: 'PAUSED',
      active_run: null,
      updated_at: new Date().toISOString()
    }))
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: 'actor.interrupted',
      payload: {}
    })
  }

  async interruptAndInsert(taskId: string, workspaceKey: string, queueItemId: string): Promise<void> {
    // Remove the instruction from the queue first
    const state = await this.store.readTaskState(taskId, workspaceKey)
    const item = (state.instruction_queue ?? []).find((i) => i.id === queueItemId)
    if (!item) throw new Error('Instruction not found in queue')
    await this.store.dequeueInstruction(taskId, workspaceKey, queueItemId)
    // Interrupt the current actor
    await this.store.updateTaskState(taskId, workspaceKey, (s) => ({
      ...s,
      status: 'PAUSED',
      active_run: null,
      updated_at: new Date().toISOString()
    }))
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: 'actor.interrupted',
      payload: { reason: 'interrupt_and_insert', instruction_id: queueItemId }
    })
    // Send the instruction as a human message and start the next actor
    await this.sendMessage(taskId, {
      workspace_key: workspaceKey,
      message: item.content,
      attachmentMeta: item.attachments
    })
  }

  async enqueueInstruction(taskId: string, workspaceKey: string, content: string, attachments?: AttachmentMeta[]): Promise<InstructionQueueItem> {
    return this.store.enqueueInstruction(taskId, workspaceKey, content, attachments)
  }

  async dequeueInstruction(taskId: string, workspaceKey: string, itemId: string): Promise<void> {
    return this.store.dequeueInstruction(taskId, workspaceKey, itemId)
  }

  async clearInstructionQueue(taskId: string, workspaceKey: string): Promise<void> {
    return this.store.clearInstructionQueue(taskId, workspaceKey)
  }

  private async drainAllInstructions(taskId: string, workspaceKey: string): Promise<InstructionQueueItem[]> {
    const state = await this.store.readTaskState(taskId, workspaceKey)
    const queue = state.instruction_queue ?? []
    if (queue.length === 0) return []
    await this.store.clearInstructionQueue(taskId, workspaceKey)
    return queue
  }

  private async sendQueuedInstructions(
    taskId: string,
    workspaceKey: string,
    items: InstructionQueueItem[],
    nextActor: string
  ): Promise<void> {
    const combinedContent = items.map(item => item.content).join('\n\n')
    for (const item of items) {
      const meta: Record<string, unknown> = { source: 'instruction_queue', queue_item_id: item.id }
      if (item.attachments && item.attachments.length > 0) {
        meta.attachments = item.attachments
      }
      await this.store.appendTranscript(taskId, workspaceKey, 'human', item.content, meta)
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'human.message',
        payload: { content: item.content, source: 'instruction_queue' }
      })
    }
    await this.startTask(taskId, {
      workspace_key: workspaceKey,
      actor: nextActor,
      message: combinedContent
    })
  }

  private async executeActor(taskId: string, workspaceKey: string, actor: string, runId: string, userMessage = ''): Promise<void> {
    const detail = await this.store.getTaskDetail(taskId, workspaceKey)
    const globalSettings = await this.store.readGlobalSettings()
    const launcher = detail.settings.launchers[actor] ?? {
      command: actor,
      env: {},
      timeout_seconds: 600
    }
    const taskDirectory = this.store.taskDirectory(taskId, workspaceKey)
    const artifactsDir = join(taskDirectory, 'artifacts')
    await mkdir(artifactsDir, { recursive: true })
    const prompt = buildActorPrompt({
      actor,
      round: detail.state.round,
      repoRoot: detail.state.repo_root ?? '',
      taskText: detail.task_text,
      contextText: detail.context_text,
      transcript: detail.transcript,
      settings: detail.settings,
      state: detail.state,
      globalSettings,
      userMessage
    })
    const promptFile = join(artifactsDir, `${runId}-prompt.md`)
    const outputFile = join(artifactsDir, `${runId}-output.md`)
    const eventFile = join(artifactsDir, `${runId}-events.jsonl`)
    await writeFile(promptFile, prompt)
    const cwd = await existingCwd(detail.state.repo_root)
    const existingSessionId = sessionIdForActor(actor, detail.state, detail.settings)
    const commandKind = commandKindFor(actor, launcher.command)
    const sessionId = actor === 'kimi' && commandKind === 'native_kimi' && !existingSessionId
      ? randomBytes(8).toString('hex')
      : existingSessionId
    const command = buildLauncherCommand({
      actor,
      command: launcher.command,
      mode: existingSessionId ? 'resume' : 'start',
      promptFile,
      promptText: prompt,
      eventFile,
      outputFile,
      repoRoot: cwd,
      taskDir: taskDirectory,
      runId,
      sessionId
    })
    const outputLines: string[] = []
    const stderrLines: string[] = []
    const lockPath = await createRunLock(this.store.dataRoot, {
      workspace_key: workspaceKey,
      task_id: taskId,
      run_id: runId,
      pid: process.pid
    })

    try {
      const startedAtMs = Date.now()
      const result = await runLauncher({
        command: command.command,
        args: command.args,
        cwd,
        env: { ...launcher.env, ...(command.env ?? {}) },
        stdinText: command.stdinText,
        timeoutMs: launcher.timeout_seconds * 1000,
        onStdout: (line) => {
          outputLines.push(line)
        },
        onStderr: (line) => stderrLines.push(line)
      })
      const elapsedMs = Date.now() - startedAtMs

      const stdoutText = outputLines.join('\n')
      const rawEvents = await collectRawEvents(eventFile, stdoutText, command.kind)
      const outputText = await collectOutputText(actor, command.kind, outputFile, stdoutText)
      const parsedLines = parseActorEvents(actor, rawEvents)
      if (actor === 'kimi' && sessionId && !parsedLines.some((line) => line.sessionId)) {
        parsedLines.push({ sessionId })
      }

      if (result.exitCode !== 0) {
        const parts: string[] = []
        const stderrText = stderrLines.join('\n').trim()
        if (stderrText) parts.push(stderrText)
        const eventError = parsedLines.filter((l) => l.rawType === 'error' && l.text).map((l) => l.text).join('\n')
        if (eventError) parts.push(eventError)
        if (outputText.trim()) parts.push(outputText.trim())
        throw new Error(parts.join('\n\n') || `Actor exited with ${result.exitCode}`)
      }

      await this.completeActor(taskId, workspaceKey, actor, runId, outputText, parsedLines, elapsedMs, result.exitCode ?? 0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failureMessage = stderrLines.join('\n') || message
      await this.markFailed(taskId, workspaceKey, actor, failureMessage, runId)
      throw error
    } finally {
      await removeRunLock(lockPath)
    }
  }

  private async completeActor(
    taskId: string,
    workspaceKey: string,
    actor: string,
    runId: string,
    outputText: string,
    parsedLines: ParsedActorLine[],
    elapsedMs: number,
    exitCode: number
  ): Promise<void> {
    // Guard: if the task was interrupted (active_run cleared or changed), skip completion
    const currentState = await this.store.readTaskState(taskId, workspaceKey)
    if (currentState.active_run?.run_id !== runId) {
      return
    }

    const text = outputText
    const sessionId = lastValue(parsedLines.map((line) => line.sessionId))
    const threadId = lastValue(parsedLines.map((line) => line.threadId))
    const message = parseBuddyMessage(text)
    const detail = await this.store.getTaskDetail(taskId, workspaceKey)
    const globalSettings = await this.store.readGlobalSettings()
    const nextActor = nextActorForSettings(actor, detail.settings)
    const round = (detail.state.round ?? 0) + 1
    const roundsInWindow = (detail.state.rounds_in_window ?? 0) + 1
    const maxRounds = globalSettings.max_rounds ?? 9999
    const roundWindowReached = maxRounds > 0 && roundsInWindow >= maxRounds
    const now = new Date().toISOString()
    const buddyType = message.kind === 'break' ? 'break' : 'chat'
    const transcriptContent = message.kind === 'break' ? message.content : message.text
    const pendingBreak = detail.state.pending_break
    const breakConfirmed = message.kind === 'break' && Boolean(pendingBreak?.actor && pendingBreak.actor !== actor)
    const breakPending = message.kind === 'break' && !breakConfirmed
    const breakRejected = message.kind !== 'break' && Boolean(pendingBreak?.actor)

    await this.store.appendTranscript(taskId, workspaceKey, normalizeActorRole(actor), transcriptContent, {
      round,
      run_id: runId,
      elapsed_ms: elapsedMs,
      buddy_type: buddyType
    })
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: 'actor.completed',
      actor,
      run_id: runId,
      payload: { run_id: runId, text: transcriptContent, raw_text: text, buddy_type: buddyType }
    })

    await this.store.updateTaskState(taskId, workspaceKey, (state) => {
      const contextSent = { ...(state.context_sent ?? {}) }
      contextSent[actor] = true
      const next: TaskState = {
        ...state,
        active_run: null,
        round,
        rounds_in_window: roundsInWindow,
        next_actor: nextActor,
        context_hash: hashText(detail.context_text),
        context_sent: contextSent,
        latest_failure: null,
        last_error: null,
        consecutive_failures: 0,
        updated_at: now
      }
      if (actor === 'claude' && sessionId) next.claude_session_id = sessionId
      if (actor === 'codex' && threadId) next.codex_thread_id = threadId
      if (actor === 'opencode' && sessionId) next.opencode_session_id = sessionId
      if (actor === 'kimi' && sessionId) next.kimi_session_id = sessionId

      if (breakConfirmed) {
        return {
          ...next,
          status: 'DONE',
          countdown: null,
          pending_break: null
        }
      }

      if (breakPending) {
        return {
          ...next,
          status: roundWindowReached ? 'PAUSED' : 'READY',
          pending_break: { actor, round },
          countdown: null
        }
      }

      return {
        ...next,
        status: roundWindowReached ? 'PAUSED' : 'READY',
        pending_break: breakRejected ? null : next.pending_break,
        countdown: null
      }
    })

    if (breakConfirmed) {
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'actor.finished',
        actor,
        run_id: runId,
        payload: { elapsed_ms: elapsedMs, exit_code: exitCode, buddy_type: 'break_confirmed' }
      })
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        `${actorDisplayName(pendingBreak?.actor)} 和 ${actorDisplayName(actor)} 均确认任务完成，任务结束。`,
        { kind: 'round_notice', round }
      )
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'task.done',
        payload: {
          reason: 'dual_break_confirmed',
          first_actor: pendingBreak?.actor,
          second_actor: actor,
          round
        }
      })
      return
    }

    if (breakPending) {
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        `${actorDisplayName(actor)} 请求结束任务，等待 ${actorDisplayName(nextActor)} 确认。`,
        { kind: 'round_notice', round }
      )
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'break.pending',
        actor,
        run_id: runId,
        payload: {
          elapsed_ms: elapsedMs,
          exit_code: exitCode,
          buddy_type: 'break',
          pending_confirmation_from: nextActor
        }
      })
    } else if (breakRejected) {
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'break.rejected',
        actor,
        run_id: runId,
        payload: { rejected_break_from: pendingBreak?.actor }
      })
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        `${actorDisplayName(actor)} 认为任务尚未完成，${actorDisplayName(pendingBreak?.actor)} 的结束请求已撤回。`,
        { kind: 'round_notice', round }
      )
    }

    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: 'actor.finished',
      actor,
      run_id: runId,
      payload: { elapsed_ms: elapsedMs, exit_code: exitCode, buddy_type: buddyType }
    })
    if (roundWindowReached) {
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        `${actorDisplayName(actor)} 已达到轮次上限，暂停等待确认。`,
        { kind: 'round_notice', round }
      )
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'round_window.paused',
        payload: {
          max_rounds: maxRounds,
          rounds_in_window: roundsInWindow,
          next_actor: nextActor
        }
      })
      return
    }
    if (this.executeLaunchers) {
      try {
        const queueItems = await this.drainAllInstructions(taskId, workspaceKey)
        if (queueItems.length > 0) {
          await this.sendQueuedInstructions(taskId, workspaceKey, queueItems, nextActor)
        } else {
          await this.startTask(taskId, { workspace_key: workspaceKey, actor: nextActor })
        }
      } catch {
        // Auto-start of next actor failed; task is already in READY state
      }
    }
  }

  private async markFailed(taskId: string, workspaceKey: string, actor: string, message: string, runId?: string): Promise<void> {
    // Guard: if the task was interrupted (active_run changed), skip marking failed
    if (runId) {
      const currentState = await this.store.readTaskState(taskId, workspaceKey)
      if (currentState.active_run?.run_id !== runId) {
        return
      }
    }
    const failure = {
      message,
      actor,
      ts: new Date().toISOString()
    }
    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      status: 'FAILED',
      active_run: null,
      consecutive_failures: (state.consecutive_failures ?? 0) + 1,
      last_error: failure,
      latest_failure: failure,
      updated_at: failure.ts
    }))
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: 'actor.failed',
      actor,
      run_id: runId,
      payload: { error: message, run_id: runId }
    })
  }
}

function canStartFrom(status: TaskState['status']): boolean {
  return (
    status === 'READY' ||
    status === 'PAUSED' ||
    status === 'FAILED' ||
    status === 'COUNTDOWN' ||
    status === 'DONE'
  )
}

function sessionIdForActor(actor: string, state: TaskState, settings?: Partial<TaskSettings>): string | undefined {
  if (actor === 'claude') return state.claude_session_id ?? stringSetting(settings, 'seed_claude_session_id')
  if (actor === 'codex') return state.codex_thread_id ?? stringSetting(settings, 'seed_codex_thread_id')
  if (actor === 'opencode') return state.opencode_session_id ?? stringSetting(settings, 'seed_opencode_session_id')
  if (actor === 'kimi') return state.kimi_session_id ?? stringSetting(settings, 'seed_kimi_session_id')
  return undefined
}

function stringSetting(settings: Partial<TaskSettings> | undefined, key: keyof TaskSettings): string | undefined {
  const value = settings?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function normalizeActorRole(actor: string): TranscriptEntry['role'] {
  if (actor === 'claude' || actor === 'codex' || actor === 'opencode' || actor === 'kimi') return actor
  return 'system'
}

function actorDisplayName(actor: unknown): string {
  if (actor === 'claude') return 'Claude Code'
  if (actor === 'codex') return 'Codex'
  if (actor === 'opencode') return 'OpenCode'
  if (actor === 'kimi') return 'Kimi'
  return typeof actor === 'string' && actor ? actor : 'Unknown'
}

function lastValue(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter(Boolean)
  return filtered[filtered.length - 1]
}

async function existingCwd(path?: string): Promise<string> {
  if (!path) return process.cwd()
  try {
    await access(path)
    return path
  } catch {
    return process.cwd()
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function collectRawEvents(
  eventFile: string,
  stdoutText: string,
  kind: LauncherCommandKind
): Promise<string> {
  if (kind !== 'contract') {
    if (stdoutText) await writeFile(eventFile, stdoutText)
    return stdoutText
  }

  const fileText = await readOptionalText(eventFile)
  if (fileText && stdoutText) return `${fileText.trimEnd()}\n${stdoutText}`
  if (fileText) return fileText
  if (stdoutText) {
    await writeFile(eventFile, stdoutText)
    return stdoutText
  }
  return ''
}

async function collectOutputText(
  actor: string,
  kind: LauncherCommandKind,
  outputFile: string,
  stdoutText: string
): Promise<string> {
  if (kind === 'native_claude' || kind === 'native_opencode' || kind === 'native_kimi') {
    const output = extractActorOutput(actor, stdoutText)
    await writeFile(outputFile, output)
    return output
  }

  if (await fileExists(outputFile)) return readFile(outputFile, 'utf8')
  const extracted = extractActorOutput(actor, stdoutText)
  return extracted || stdoutText
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
