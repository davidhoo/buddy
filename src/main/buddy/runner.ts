import { access, appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
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
import { extractActorOutput, parseActorEvents, parseActorLine, parseBuddyMessage, ParsedActorLine } from './parsers'
import { buildActorPrompt, buildPingPrompt, hashText, nextActor as nextActorForSettings, implementerActor as resolveImplementerActor, actorDisplayName } from './prompts'
import { BuddyStore } from './store'
import { BuddyEventBus } from './events'

const ACTOR_STATUS: Record<string, TaskState['status']> = {
  claude: 'RUNNING_CLAUDE',
  codex: 'RUNNING_CODEX',
  opencode: 'RUNNING_OPENCODE',
  kimi: 'RUNNING_KIMI'
}

const PING_TIMEOUT_SECONDS = 120

interface RunnerOptions {
  executeLaunchers?: boolean
  events?: BuddyEventBus
}

export class BuddyRunner {
  private readonly executeLaunchers: boolean
  private readonly events?: BuddyEventBus

  constructor(
    private readonly store: BuddyStore,
    options: RunnerOptions = {}
  ) {
    this.executeLaunchers = options.executeLaunchers ?? true
    this.events = options.events
  }

  async startTask(taskId: string, input: StartTaskInput): Promise<{ run_id: string }> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const workspaceKey = input.workspace_key
    const detail = await this.store.getTaskDetail(taskId, workspaceKey)

    // Health check: on first start (round 0, no sessions, no prior health check), ping both actors.
    // Skip when an explicit actor is requested (caller knows what they want) or in test mode.
    if (this.executeLaunchers && !input.actor && needsHealthCheck(detail.state, detail.settings)) {
      const implementer = resolveImplementerActor(detail.settings)
      const reviewer = nextActorForSettings(implementer, detail.settings)
      const healthRunId = await this.runHealthCheck(taskId, workspaceKey, implementer, reviewer)
      return { run_id: healthRunId }
    }

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

  private async executePing(
    taskId: string,
    workspaceKey: string,
    actor: string
  ): Promise<{ success: boolean; sessionId?: string; threadId?: string; error?: string }> {
    const detail = await this.store.getTaskDetail(taskId, workspaceKey)
    const launcher = detail.settings.launchers[actor] ?? {
      command: actor,
      env: {},
      timeout_seconds: PING_TIMEOUT_SECONDS
    }
    const taskDirectory = this.store.taskDirectory(taskId, workspaceKey)
    const artifactsDir = join(taskDirectory, 'artifacts')
    await mkdir(artifactsDir, { recursive: true })

    const runId = `ping_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    const prompt = buildPingPrompt(actor)
    const promptFile = join(artifactsDir, `${runId}-prompt.md`)
    const outputFile = join(artifactsDir, `${runId}-output.md`)
    const eventFile = join(artifactsDir, `${runId}-events.jsonl`)
    await writeFile(promptFile, prompt)

    const cwd = await existingCwd(detail.state.repo_root)
    const commandKind = commandKindFor(actor, launcher.command)
    const command = buildLauncherCommand({
      actor,
      command: launcher.command,
      mode: 'start',
      promptFile,
      promptText: prompt,
      eventFile,
      outputFile,
      repoRoot: cwd,
      taskDir: taskDirectory,
      runId
    })

    const outputLines: string[] = []
    const stderrLines: string[] = []

    try {
      const result = await runLauncher({
        command: command.command,
        args: command.args,
        cwd,
        env: { ...launcher.env, ...(command.env ?? {}) },
        stdinText: command.stdinText,
        timeoutMs: PING_TIMEOUT_SECONDS * 1000,
        onStdout: (line) => outputLines.push(line),
        onStderr: (line) => stderrLines.push(line)
      })

      const stdoutText = outputLines.join('\n')
      const rawEvents = await collectRawEvents(eventFile, stdoutText, command.kind)
      const outputText = await collectOutputText(actor, command.kind, outputFile, stdoutText)
      const parsedLines = parseActorEvents(actor, rawEvents)

      if (result.exitCode !== 0) {
        const stderrText = stderrLines.join('\n').trim()
        const error = stderrText || outputText.trim() || exitErrorMessage(result.exitCode, result.signal)
        return { success: false, error: error.slice(0, 300) }
      }

      // Verify the actor responded with a valid buddy message
      const message = parseBuddyMessage(outputText)
      const hasContent = message.kind === 'message'
        ? message.text.trim().length > 0
        : message.content.trim().length > 0
      if (!hasContent) {
        return { success: false, error: 'Actor responded with empty content' }
      }

      const sessionId = lastValue(parsedLines.map((line) => line.sessionId))
      const threadId = lastValue(parsedLines.map((line) => line.threadId))
      return { success: true, sessionId, threadId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stderrText = stderrLines.join('\n').trim()
      const isOnlyWarning = stderrText && isCliWarningOnly(stderrText)
      return { success: false, error: (message || (!isOnlyWarning ? stderrText : 'Actor exited without producing any output')).slice(0, 300) }
    }
  }

  private async runHealthCheck(
    taskId: string,
    workspaceKey: string,
    implementer: string,
    reviewer: string
  ): Promise<string> {
    const actors = [implementer, reviewer]
    const actorResults: Record<string, 'pending' | 'running' | 'passed' | 'failed'> = {}
    for (const a of actors) actorResults[a] = 'pending'

    const now = new Date().toISOString()
    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      status: 'PINGING' as const,
      health_check: { actors: actorResults },
      updated_at: now
    }))
    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: 'health_check.started',
      payload: { actors }
    })
    await this.store.appendTranscript(
      taskId,
      workspaceKey,
      'system',
      'health_check.started',
      { kind: 'health_check', actors }
    )

    const runningResults = { ...actorResults }
    for (const a of actors) runningResults[a] = 'running'
    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      health_check: { actors: runningResults },
      updated_at: new Date().toISOString()
    }))

    const pingResults = await Promise.allSettled(
      actors.map((actor) => this.executePing(taskId, workspaceKey, actor))
    )

    let allPassed = true
    let failedActor: string | undefined
    let failedReason: string | undefined
    const finalResults = { ...runningResults }
    const sessionUpdates: Partial<TaskState> = {}

    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]
      const settled = pingResults[i]
      if (settled.status === 'fulfilled' && settled.value.success) {
        finalResults[actor] = 'passed'
        const sid = settled.value.sessionId
        const tid = settled.value.threadId
        if (actor === 'claude' && sid) sessionUpdates.claude_session_id = sid
        if (actor === 'codex' && (tid ?? sid)) sessionUpdates.codex_thread_id = tid ?? sid
        if (actor === 'opencode' && sid) sessionUpdates.opencode_session_id = sid
        if (actor === 'kimi' && sid) sessionUpdates.kimi_session_id = sid
        const displayId = actor === 'codex' ? (tid ?? sid) : sid
        await this.store.appendTaskEvent(taskId, workspaceKey, {
          type: 'health_check.actor_passed',
          actor,
          payload: { session_id: displayId ?? null }
        })
      } else {
        allPassed = false
        finalResults[actor] = 'failed'
        if (!failedActor) {
          failedActor = actor
          failedReason = settled.status === 'fulfilled'
            ? settled.value.error
            : (settled.reason instanceof Error ? settled.reason.message : String(settled.reason))
        }
        await this.store.appendTaskEvent(taskId, workspaceKey, {
          type: 'health_check.actor_failed',
          actor,
          payload: { error: failedReason ?? 'Unknown error' }
        })
      }
    }

    if (allPassed) {
      await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
        ...state,
        status: 'READY',
        health_check: null,
        ...sessionUpdates,
        updated_at: new Date().toISOString()
      }))
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'health_check.passed',
        payload: {}
      })
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        'health_check.passed',
        { kind: 'health_check', actors, session_ids: actors.map(a => {
          const sid = a === 'codex'
            ? (sessionUpdates.codex_thread_id)
            : (a === 'claude' ? sessionUpdates.claude_session_id
              : a === 'opencode' ? sessionUpdates.opencode_session_id
                : sessionUpdates.kimi_session_id)
          return { actor: a, session_id: (sid as string | undefined) ?? null }
        }) }
      )

      if (this.executeLaunchers) {
        const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
        await this.startTask(taskId, { workspace_key: workspaceKey, actor: implementer })
        return runId
      }
      return `ping_ok_${Date.now()}`
    } else {
      await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
        ...state,
        status: 'DONE',
        active_run: null,
        health_check: { actors: finalResults, failed_actor: failedActor, failed_reason: failedReason },
        ...sessionUpdates,
        updated_at: new Date().toISOString()
      }))
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'health_check.failed',
        payload: { failed_actor: failedActor, failed_reason: failedReason }
      })
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        'health_check.failed',
        { kind: 'health_check_failed', failed_actor: failedActor ?? '', failed_reason: failedReason ?? '' }
      )
      throw new Error(`连通性检查失败：${actorDisplayName(failedActor)} — ${failedReason ?? '未知错误'}`)
    }
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
    const sessionId = actor === 'kimi' && commandKind === 'native_kimi'
      ? existingSessionId
      : (existingSessionId ?? undefined)
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
          if (this.events) {
            try {
              const parsed = parseActorLine(actor, line)
              if (parsed.text) {
                this.events.publish({
                  workspace_key: workspaceKey,
                  task_id: taskId,
                  event: {
                    seq: 0,
                    type: 'actor.stdout',
                    actor,
                    ts: new Date().toISOString(),
                    run_id: runId,
                    payload: { text: parsed.text }
                  }
                })
              }
            } catch { /* ignore parse errors for streaming */ }
          }
        },
        onStderr: (line) => stderrLines.push(line)
      })
      const elapsedMs = Date.now() - startedAtMs

      const stdoutText = outputLines.join('\n')
      const rawEvents = await collectRawEvents(eventFile, stdoutText, command.kind)
      let outputText = await collectOutputText(actor, command.kind, outputFile, stdoutText)
      const parsedLines = parseActorEvents(actor, rawEvents)
      if (actor === 'kimi' && sessionId && !parsedLines.some((line) => line.sessionId)) {
        parsedLines.push({ sessionId })
      }

      const errorOnlyOutput = parsedLines.some((l) => l.rawType === 'error')
        && !parsedLines.some((l) => l.rawType !== 'error' && l.text)
      if (result.exitCode !== 0 || errorOnlyOutput) {
        const parts: string[] = []
        const stderrText = stderrLines.join('\n').trim()
        if (stderrText) parts.push(stderrText)
        const eventError = parsedLines.filter((l) => l.rawType === 'error' && l.text).map((l) => l.text).join('\n')
        if (eventError) parts.push(eventError)
        if (outputText.trim()) parts.push(outputText.trim())
        throw new Error(parts.join('\n\n') || exitErrorMessage(result.exitCode, result.signal))
      }

      // Ghost output: raw events exist but nothing was extracted (unrecognized error format)
      // However, if parsedLines contain text (e.g. step_start placeholders), use those instead of throwing
      // Skip noise events (system/hook) that carry no actor content
      const nonNoiseEvents = rawEvents.trim().split(/\r?\n/).filter((line) => {
        if (!line.trim()) return false
        try {
          const obj = JSON.parse(line)
          // Filter out system/hook noise events
          if (obj.type === 'system' && typeof obj.subtype === 'string' && (obj.subtype as string).startsWith('hook_')) return false
          // Filter out other system events that carry no actor content (e.g. init, warning)
          if (obj.type === 'system' && obj.subtype !== undefined) return false
          return true
        } catch {
          return true // keep non-JSON lines
        }
      })
      const nonNoiseRaw = nonNoiseEvents.join('\n')
      if (!outputText.trim() && nonNoiseRaw.trim()) {
        const parsedText = parsedLines.filter((l) => l.text).map((l) => l.text).join('\n').trim()
        if (parsedText) {
          outputText = parsedText
        } else {
          throw new Error(nonNoiseRaw.trim().slice(0, 500))
        }
      } else if (!outputText.trim() && rawEvents.trim() && !nonNoiseRaw.trim()) {
        // All events were noise (e.g. only system/hook events) — actor produced no real output
        throw new Error('Actor exited without producing any output')
      }

      await this.completeActor(taskId, workspaceKey, actor, runId, outputText, parsedLines, elapsedMs, result.exitCode ?? 0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Prefer the actual error message over stderr; only use stderr as fallback
      // and filter out known CLI warnings that are not real errors
      const stderrText = stderrLines.join('\n').trim()
      const isOnlyWarning = stderrText && isCliWarningOnly(stderrText)
      const failureMessage = message || (!isOnlyWarning ? stderrText : 'Actor exited without producing any output')
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
    const hasQueuedInstructions = (currentState.instruction_queue?.length ?? 0) > 0

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
          status: hasQueuedInstructions ? 'READY' : 'DONE',
          countdown: null,
          pending_break: null,
          break_rejected_by: null
        }
      }

      if (breakPending) {
        return {
          ...next,
          status: roundWindowReached ? 'PAUSED' : 'READY',
          pending_break: { actor, round },
          break_rejected_by: null,
          countdown: null
        }
      }

      return {
        ...next,
        status: roundWindowReached ? 'PAUSED' : 'READY',
        pending_break: breakRejected ? null : next.pending_break,
        break_rejected_by: breakRejected ? { actor, round } : null,
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

      if (hasQueuedInstructions) {
        await this.store.appendTranscript(
          taskId,
          workspaceKey,
          'system',
          `${actorDisplayName(pendingBreak?.actor)} 和 ${actorDisplayName(actor)} 均确认当前阶段完成，但指令队列中仍有待执行指令，继续执行。`,
          { kind: 'round_notice', round }
        )
        // Fall through to auto-start logic (skip duplicate actor.finished)
      } else {
        await this.store.appendTranscript(
          taskId,
          workspaceKey,
          'system',
          `${actorDisplayName(pendingBreak?.actor)} 和 ${actorDisplayName(actor)} 均确认任务完成，任务结束。`,
          { kind: 'round_notice', round, done_reason: 'dual_break_confirmed' }
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

    if (!breakConfirmed) {
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'actor.finished',
        actor,
        run_id: runId,
        payload: { elapsed_ms: elapsedMs, exit_code: exitCode, buddy_type: buddyType }
      })
    }
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
    const stateBefore = await this.store.readTaskState(taskId, workspaceKey)
    const pendingBreak = stateBefore.pending_break
    const otherActorBreak = pendingBreak?.actor && pendingBreak.actor !== actor ? pendingBreak : null

    if (otherActorBreak) {
      const round = stateBefore.round ?? 0
      await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
        ...state,
        status: 'DONE',
        active_run: null,
        pending_break: null,
        updated_at: failure.ts
      }))
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'actor.failed',
        actor,
        run_id: runId,
        payload: { error: message, run_id: runId }
      })
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        `${actorDisplayName(otherActorBreak.actor)} 请求结束任务，${actorDisplayName(actor)} 因错误无法继续，自动确认结束。`,
        { kind: 'round_notice', round }
      )
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'task.done',
        payload: {
          reason: 'break_confirmed_on_failure',
          first_actor: otherActorBreak.actor,
          second_actor: actor,
          round
        }
      })
      return
    }

    const newConsecutiveFailures = (stateBefore.consecutive_failures ?? 0) + 1
    const globalSettings = await this.store.readGlobalSettings()
    const maxConsecutiveFailures = globalSettings.max_consecutive_failures ?? 3
    const thresholdReached = newConsecutiveFailures >= maxConsecutiveFailures

    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      status: thresholdReached ? 'PAUSED' : 'FAILED',
      active_run: null,
      consecutive_failures: newConsecutiveFailures,
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
    if (thresholdReached) {
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        `${actorDisplayName(actor)} 连续失败 ${newConsecutiveFailures} 次，已达到上限 (${maxConsecutiveFailures})，暂停等待用户处理。`,
        { kind: 'round_notice', round: stateBefore.round ?? 0 }
      )
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'failure_threshold.reached',
        payload: { consecutive_failures: newConsecutiveFailures, max_consecutive_failures: maxConsecutiveFailures }
      })
    }
  }
}

function canStartFrom(status: TaskState['status']): boolean {
  return (
    status === 'READY' ||
    status === 'PAUSED' ||
    status === 'FAILED' ||
    status === 'COUNTDOWN' ||
    status === 'DONE' ||
    status === 'PINGING'
  )
}

function needsHealthCheck(state: TaskState, settings: TaskSettings): boolean {
  if (state.round > 0) return false
  if (state.health_check !== null && state.health_check !== undefined) return false
  const implementer = settings.implementer_actor
    ?? (settings.role_mode === 'codex_implements' ? 'codex' : 'claude')
  const reviewer = settings.reviewer_actor
    ?? (settings.role_mode === 'codex_implements' ? 'claude' : 'codex')
  const implSession = sessionIdForActor(implementer, state, settings)
  const revSession = sessionIdForActor(reviewer, state, settings)
  return !implSession && !revSession
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

function lastValue(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter(Boolean)
  return filtered[filtered.length - 1]
}

/** Check if stderr text contains only known CLI warnings (not real errors) */
function isCliWarningOnly(stderrText: string): boolean {
  // Known CLI warnings that should not be treated as errors
  const warningPatterns = [
    /Running with --dangerously-skip-permissions/i,
    /Warning:.*skip.*permission/i,
    /bypass.*approval/i,
    /bypass.*sandbox/i
  ]
  const lines = stderrText.split(/\r?\n/).filter((l) => l.trim())
  return lines.length > 0 && lines.every((line) =>
    warningPatterns.some((p) => p.test(line))
  )
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
    const message = parseBuddyMessage(output)
    const normalized = JSON.stringify({
      type: message.kind === 'break' ? 'break' : 'chat',
      content: message.kind === 'break' ? (message.content ?? message.reason ?? '') : (message.text ?? '')
    })
    await writeFile(outputFile, normalized)
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

export function exitErrorMessage(exitCode: number | null, signal: string | null): string {
  if (exitCode === null) {
    if (signal) return `Actor was killed by signal ${signal} (possible timeout)`
    return 'Actor exited unexpectedly (no exit code)'
  }
  return `Actor exited with code ${exitCode}`
}
