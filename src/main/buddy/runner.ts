import { access, appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AttachmentMeta,
  CountdownInput,
  Failure,
  GlobalSettings,
  InstructionQueueItem,
  Launcher,
  SendMessageInput,
  StartTaskInput,
  TaskSettings,
  TaskStats,
  TranscriptEntry,
  TaskState
} from '../../shared/types'
import { buildLauncherCommand, commandKindFor, kindNeedsPty, parserActorForKind, runLauncher, runLauncherWithPty, type LauncherCommandKind } from './launchers'
import { createRunLock, removeRunLock } from './locks'
import { extractActorOutput, parseActorEvents, parseActorLine, parseBuddyMessage, parseJsonlBuffer, ParsedActorLine } from './parsers'
import { buildActorPrompt, buildPingPrompt, hashText, nextActor as nextActorForSettings, implementerActor as resolveImplementerActor, actorDisplayName } from './prompts'
import { BuddyStore } from './store'
import { BuddyEventBus } from './events'
import type { TaskNotifier } from './notifications'

const PING_TIMEOUT_SECONDS = 120

/** Canonical phrase used in both throw sites and the regex pattern below — keep in sync */
const CONTEXT_EXHAUSTED_PHRASE = 'context window exhausted'

/** Patterns that indicate an actor hit the context window limit */
const CONTEXT_WINDOW_LIMIT_PATTERNS = [
  /context window limit/i,
  /context length exceeded/i,
  /context\.length\.exceeded/i,
  /maximum context length/i,
  /max.*context.*length/i,
  /token limit/i,
  /too many tokens/i,
  /exceeds.*token/i,
  /exceeded.*token/i,
  /input.*too long/i,
  /request too large/i,
  /context window.*exhausted/i,
  // Chinese error messages from models like GLM, Qwen, DeepSeek
  /对话内容太长/i,
  /超出.*处理能力/i,
  /超出.*上下文/i,
  /超出.*模型.*能力/i,
  /上下文.*超限/i,
  /上下文.*超出/i,
  /内容过长/i,
  /超出.*长度/i
]

const DEFAULT_MAX_COMPACT_RETRIES = 3

interface RunnerOptions {
  executeLaunchers?: boolean
  events?: BuddyEventBus
  notifier?: TaskNotifier
}
const DEFAULT_MAX_UPGRADE_RETRIES = 3
const UPGRADE_WAIT_MS = 5000

/** Patterns that indicate the child process exited because it is auto-upgrading */
const UPGRADE_PATTERNS = [
  /upgrade.*complete/i,
  /updated.*restart/i,
  /restart.*required/i,
  /new version/i,
  /auto.?update/i,
  /自动更新/i,
  /自动升级/i,
  /升级完成/i,
  /请重启/i,
  /已更新/i
]

/** Check if an error/stderr message indicates the child exited for an auto-upgrade */
export function isUpgradeExitError(message: string): boolean {
  return UPGRADE_PATTERNS.some((p) => p.test(message))
}

export class BuddyRunner {
  private readonly executeLaunchers: boolean
  private readonly events?: BuddyEventBus
  private readonly notifier?: TaskNotifier
  /** Optional callback invoked after a task reaches a terminal-ish state (DONE/PAUSED/FAILED). */
  onTaskTerminal?: (workspaceKey: string) => void

  constructor(
    private readonly store: BuddyStore,
    options: RunnerOptions = {}
  ) {
    this.executeLaunchers = options.executeLaunchers ?? true
    this.events = options.events
    this.notifier = options.notifier
  }

  async startTask(taskId: string, input: StartTaskInput): Promise<{ run_id: string }> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const workspaceKey = input.workspace_key
    const detail = await this.store.getTaskDetail(taskId, workspaceKey)

    // Health check: on first start (round 0, no sessions, no prior health check), ping both actors.
    // Skip when an explicit actor is requested (caller knows what they want) or in test mode.
    // Also re-run when the previous attempt failed connectivity (FAILED + health_check) so the
    // user can retry connectivity directly without resuming an actor run.
    if (this.executeLaunchers && !input.actor && needsHealthCheck(detail.state, detail.settings)) {
      const implementer = resolveImplementerActor(detail.settings)
      const reviewer = nextActorForSettings(implementer, detail.settings)
      // Clear the stale failed health_check result so the retry can re-trigger.
      await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
        ...state,
        health_check: null,
        latest_failure: null,
        last_error: null
      }))
      const healthRunId = await this.runHealthCheck(taskId, workspaceKey, implementer, reviewer)
      return { run_id: healthRunId }
    }

    const globalSettings = await this.store.readGlobalSettings()
    const actor = input.actor
      ?? (detail.state.status === 'FAILED' ? (detail.state.latest_failure?.actor ?? detail.state.last_error?.actor) : undefined)
      ?? detail.state.next_actor
      ?? 'claude'
    const launcher = detail.settings.launchers[actor]
    const status = statusForActor(actor, launcher)
    if (!status) throw new Error(`Unsupported actor: ${actor}`)
    if (!canStartFrom(detail.state.status)) {
      throw new Error(`Cannot start task from ${detail.state.status}`)
    }
    const maxRounds = globalSettings.max_rounds ?? 9999
    const roundsInWindow = detail.state.rounds_in_window ?? 0
    if (maxRounds > 0 && roundsInWindow >= maxRounds) {
      if (detail.state.status === 'PAUSED') {
        // User is explicitly resuming from a round-window pause - reset the window
        await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
          ...state,
          rounds_in_window: 0,
          updated_at: new Date().toISOString()
        }))
        await this.store.appendTaskEvent(taskId, workspaceKey, {
          type: 'round_window.reset',
          payload: { previous_rounds_in_window: roundsInWindow, max_rounds: maxRounds }
        })
      } else {
        // Auto-start attempted but window is exhausted - pause and wait for manual resume
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

  /**
   * Run an actor command, using PTY when required (e.g. opencode needs a TTY).
   * Centralizes the runLauncher vs runLauncherWithPty decision.
   */
  private async runActorCommand(
    command: { command: string; args: string[]; env?: Record<string, string>; kind: LauncherCommandKind; stdinText?: string },
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    actor: string,
    workspaceKey: string,
    taskId: string,
    runId: string,
    outputLines: string[],
    stderrLines: string[]
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const needsPty = kindNeedsPty(command.kind)
    const parserActor = parserActorForKind(actor, command.kind)
    const parseOptions = {
      cursorPartialOutput: command.kind === 'native_cursor'
        && command.args.includes('--stream-partial-output')
    }

    if (needsPty) {
      return runLauncherWithPty({
        command: command.command,
        args: command.args,
        cwd,
        env: { ...env, ...(command.env ?? {}) },
        timeoutMs,
        onData: (data) => {
          for (const line of data.split(/\r?\n/).filter(Boolean)) {
            outputLines.push(line)
            if (this.events) {
              try {
                const parsed = parseActorLine(parserActor, line, parseOptions)
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
          }
        }
      })
    }

    return runLauncher({
      command: command.command,
      args: command.args,
      cwd,
      env: { ...env, ...(command.env ?? {}) },
      stdinText: command.stdinText,
      timeoutMs,
      onStdout: (line) => {
        outputLines.push(line)
        if (this.events) {
          try {
            const parsed = parseActorLine(parserActor, line, parseOptions)
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
  }

  private async executePing(
    taskId: string,
    workspaceKey: string,
    actor: string
  ): Promise<{ success: boolean; sessionId?: string; threadId?: string; error?: string }> {
    const globalSettings = await this.store.readGlobalSettings()
    const maxUpgradeRetries = globalSettings.max_upgrade_retries ?? DEFAULT_MAX_UPGRADE_RETRIES

    let upgradeRetries = 0
    // wecode/claude and similar CLIs may exit on first launch to auto-upgrade themselves,
    // then expect to be relaunched. A connectivity ping that hits this used to fail the
    // health check outright, forcing a manual retry. Mirror executeActorInner: detect the
    // upgrade exit (across stderr+stdout, since wecode prints upgrade progress to stdout
    // and the failure reason to stderr), wait for it to settle, and retry the ping.
    for (;;) {
      const attempt = await this.executePingAttempt(taskId, workspaceKey, actor)
      if (attempt.success) return attempt

      const combined = `${attempt.stderr ?? ''}\n${attempt.stdout ?? ''}\n${attempt.error ?? ''}`.trim()
      if (upgradeRetries < maxUpgradeRetries && isUpgradeExitError(combined)) {
        upgradeRetries++
        await this.store.appendTaskEvent(taskId, workspaceKey, {
          type: 'health_check.actor_upgrade_retry',
          actor,
          payload: { retry_attempt: upgradeRetries, max_retries: maxUpgradeRetries, error: (attempt.error ?? '').slice(0, 500) }
        })
        await this.store.appendTranscript(
          taskId,
          workspaceKey,
          'system',
          `${actorDisplayName(actor)} 连通性检查检测到自动升级，等待升级完成后重试 (${upgradeRetries}/${maxUpgradeRetries})...`,
          { kind: 'health_check_upgrade_retry', retry_attempt: upgradeRetries, actor }
        )
        await new Promise((resolve) => setTimeout(resolve, UPGRADE_WAIT_MS))
        continue
      }
      return { success: false, error: attempt.error, sessionId: attempt.sessionId, threadId: attempt.threadId }
    }
  }

  private async executePingAttempt(
    taskId: string,
    workspaceKey: string,
    actor: string
  ): Promise<{ success: boolean; sessionId?: string; threadId?: string; error?: string; stderr?: string; stdout?: string }> {
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
    const commandKind = commandKindFor(actor, launcher.command, launcher.backend)
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
      runId,
      backend: launcher.backend,
      model: launcher.model,
      cursor: launcher.cursor
    })

    const outputLines: string[] = []
    const stderrLines: string[] = []

    try {
      const result = await this.runActorCommand(
        command, cwd, launcher.env, PING_TIMEOUT_SECONDS * 1000,
        actor, workspaceKey, taskId, runId,
        outputLines, stderrLines
      )

      const stdoutText = outputLines.join('\n')
      const rawEvents = await collectRawEvents(eventFile, stdoutText, command.kind)
      const cursorPartialOutput = command.kind === 'native_cursor' && launcher.cursor?.stream_partial_output === true
      const outputText = await collectOutputText(actor, command.kind, outputFile, stdoutText, cursorPartialOutput)
      const parsedLines = parseActorEvents(
        parserActorForKind(actor, command.kind),
        rawEvents,
        { cursorPartialOutput }
      )
      const stderrText = stderrLines.join('\n').trim()

      if (result.exitCode !== 0) {
        const error = stderrText || outputText.trim() || exitErrorMessage(result.exitCode, result.signal)
        return { success: false, error: error.slice(0, 300), stderr: stderrText, stdout: stdoutText }
      }

      // Verify the actor responded with a valid buddy message
      const message = parseBuddyMessage(outputText)
      const hasContent = message.kind === 'message'
        ? message.text.trim().length > 0
        : message.content.trim().length > 0
      if (!hasContent) {
        return { success: false, error: 'Actor responded with empty content', stderr: stderrText, stdout: stdoutText }
      }

      const sessionId = lastValue(parsedLines.map((line) => line.sessionId))
      const threadId = lastValue(parsedLines.map((line) => line.threadId))
      return { success: true, sessionId, threadId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stderrText = stderrLines.join('\n').trim()
      const isOnlyWarning = stderrText && isCliWarningOnly(stderrText)
      return {
        success: false,
        error: (message || (!isOnlyWarning ? stderrText : 'Actor exited without producing any output')).slice(0, 300),
        stderr: stderrText,
        stdout: outputLines.join('\n')
      }
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
    const agentSessionUpdates: Record<string, string> = {}

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
        if (displayId) agentSessionUpdates[actor] = displayId
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
        agent_sessions: { ...(state.agent_sessions ?? {}), ...agentSessionUpdates },
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
          const legacySid = a === 'codex'
            ? (sessionUpdates.codex_thread_id)
            : (a === 'claude' ? sessionUpdates.claude_session_id
              : a === 'opencode' ? sessionUpdates.opencode_session_id
                : sessionUpdates.kimi_session_id)
          return { actor: a, session_id: agentSessionUpdates[a] ?? (legacySid as string | undefined) ?? null }
        }) }
      )

      if (this.executeLaunchers) {
        const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
        await this.startTask(taskId, { workspace_key: workspaceKey, actor: implementer })
        return runId
      }
      return `ping_ok_${Date.now()}`
    } else {
      const failedAt = new Date().toISOString()
      const failureRecord: Failure = {
        actor: failedActor ?? undefined,
        message: `连通性检查失败：${failedActor ? actorDisplayName(failedActor) : '未知'} — ${failedReason ?? '未知错误'}`,
        ts: failedAt
      }
      await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
        ...state,
        status: 'FAILED',
        active_run: null,
        latest_failure: failureRecord,
        last_error: failureRecord,
        health_check: { actors: finalResults, failed_actor: failedActor, failed_reason: failedReason },
        ...sessionUpdates,
        agent_sessions: { ...(state.agent_sessions ?? {}), ...agentSessionUpdates },
        updated_at: failedAt
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
      // Send system notification for health check failure
      if (this.notifier) {
        await this.notifier.notifyTaskFailed(taskId, workspaceKey, failedActor ?? 'unknown', `健康检查失败：${failedReason ?? '未知错误'}`)
      }
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

  private async executeActor(taskId: string, workspaceKey: string, actor: string, runId: string, userMessage = '', compactRetries = 0): Promise<void> {
    return this.executeActorInner(taskId, workspaceKey, actor, runId, userMessage, compactRetries, 0)
  }

  private async executeActorInner(taskId: string, workspaceKey: string, actor: string, runId: string, userMessage: string, compactRetries: number, upgradeRetries: number): Promise<void> {
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
    const commandKind = commandKindFor(actor, launcher.command, launcher.backend)
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
      sessionId,
      backend: launcher.backend,
      model: launcher.model,
      cursor: launcher.cursor
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
      const result = await this.runActorCommand(
        command, cwd, launcher.env, launcher.timeout_seconds * 1000,
        actor, workspaceKey, taskId, runId,
        outputLines, stderrLines
      )
      const elapsedMs = Date.now() - startedAtMs

      const stdoutText = outputLines.join('\n')
      const rawEvents = await collectRawEvents(eventFile, stdoutText, command.kind)
      const cursorPartialOutput = command.kind === 'native_cursor' && launcher.cursor?.stream_partial_output === true
      let outputText = await collectOutputText(actor, command.kind, outputFile, stdoutText, cursorPartialOutput)
      const parsedLines = parseActorEvents(
        parserActorForKind(actor, command.kind),
        rawEvents,
        { cursorPartialOutput }
      )
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
      // Skip noise events (system/hook/step_start) that carry no actor content
      const nonNoiseEvents = rawEvents.trim().split(/\r?\n/).filter((line) => {
        if (!line.trim()) return false
        try {
          const obj = JSON.parse(line)
          // Filter out system/hook noise events
          if (obj.type === 'system' && typeof obj.subtype === 'string' && (obj.subtype as string).startsWith('hook_')) return false
          // Filter out other system events that carry no actor content (e.g. init, warning)
          if (obj.type === 'system' && obj.subtype !== undefined) return false
          // Filter out step_start noise events (context-exhausted actors emit only these)
          if (obj.type === 'step_start') return false
          // Filter out step_finish noise events (lifecycle events, no actor content)
          if (obj.type === 'step_finish') return false
          return true
        } catch {
          return true // keep non-JSON lines
        }
      })
      const nonNoiseRaw = nonNoiseEvents.join('\n')
      // Check if the only parsed text comes from noise events (step_start placeholders)
      const nonNoiseParsedText = parsedLines.filter((l) => l.text && !l.noise).map((l) => l.text).join('\n').trim()
      const hasOnlyNoiseOutput = !outputText.trim() && !nonNoiseParsedText && parsedLines.some((l) => l.noise && l.text)
      if (hasOnlyNoiseOutput) {
        throw new Error(`Actor exited with only noise events (likely ${CONTEXT_EXHAUSTED_PHRASE})`)
      } else if (!outputText.trim() && nonNoiseRaw.trim()) {
        const parsedText = nonNoiseParsedText || parsedLines.filter((l) => l.text).map((l) => l.text).join('\n').trim()
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

      // Auto-reset session on context window limit errors
      // Note: /compact does NOT work in -p (pipe) mode — it's treated as plain text input,
      // not a slash command. So we skip /compact entirely and go straight to session reset.
      const maxCompactRetries = globalSettings.max_compact_retries ?? DEFAULT_MAX_COMPACT_RETRIES
      if (isContextWindowLimitError(failureMessage) && compactRetries < maxCompactRetries) {
        const sessionId = sessionIdForActor(actor, detail.state, detail.settings)
        if (sessionId) {
          await this.store.appendTaskEvent(taskId, workspaceKey, {
            type: 'actor.context_limit_detected',
            actor,
            run_id: runId,
            payload: { error: failureMessage, reset_attempt: compactRetries + 1, max_reset_attempts: maxCompactRetries }
          })

          await this.store.appendTranscript(
            taskId,
            workspaceKey,
            'system',
            `${actorDisplayName(actor, detail.settings)} 达到上下文窗口限制，正在重置会话并注入精简上下文 (${compactRetries + 1}/${maxCompactRetries})...`,
            { kind: 'session_reset', reset_attempt: compactRetries + 1 }
          )
          await this.resetSessionForActor(taskId, workspaceKey, actor, detail)
          return this.executeActorInner(taskId, workspaceKey, actor, runId, userMessage, compactRetries + 1, upgradeRetries)
        }
      }

      // Auto-retry when the child process exits due to an auto-upgrade (e.g. wecode/codex).
      // The CLI detects a new version, exits to upgrade itself, then the user restarts.
      // We wait briefly for the upgrade to settle, then retry the same round (keeping
      // the existing session so the conversation continues seamlessly).
      const maxUpgradeRetries = globalSettings.max_upgrade_retries ?? DEFAULT_MAX_UPGRADE_RETRIES
      // Include raw stdout: wecode prints upgrade progress (e.g. "A new version is
      // available", "upgrade complete", "Please run your command again with the new
      // version") to stdout, which extractActorOutput filters out of outputText. Without
      // the raw stdout the upgrade exit goes undetected at runtime and the round fails
      // instead of retrying. Mirrors the executePing combined-message fix.
      const combinedMessage = `${failureMessage}\n${stderrText}\n${outputLines.join('\n')}`.trim()
      if (upgradeRetries < maxUpgradeRetries && isUpgradeExitError(combinedMessage)) {
        await this.store.appendTaskEvent(taskId, workspaceKey, {
          type: 'actor.upgrade_detected',
          actor,
          run_id: runId,
          payload: { retry_attempt: upgradeRetries + 1, max_retries: maxUpgradeRetries, error: failureMessage.slice(0, 500) }
        })
        await this.store.appendTranscript(
          taskId,
          workspaceKey,
          'system',
          `${actorDisplayName(actor, detail.settings)} 检测到自动升级，等待升级完成后重试 (${upgradeRetries + 1}/${maxUpgradeRetries})...`,
          { kind: 'upgrade_retry', retry_attempt: upgradeRetries + 1 }
        )
        await new Promise((resolve) => setTimeout(resolve, UPGRADE_WAIT_MS))
        return this.executeActorInner(taskId, workspaceKey, actor, runId, userMessage, compactRetries, upgradeRetries + 1)
      }

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

    // Degraded response detection: if the output consists only of noise placeholders
    // (e.g. "..." from step_start events) with no buddy protocol JSON, the actor's
    // context is likely exhausted. Treat this as a context window limit error so
    // the session reset / compact logic can kick in, instead of silently accepting
    // a meaningless "chat" message that would block break requests.
    // Skip this check when outputText itself contains a valid buddy message
    // (e.g. contract launchers write buddy JSON directly to the output file).
    const hasNonNoiseContent = parsedLines.some((l) => l.text && !l.noise)
    const hasBuddyJsonInOutput = message.kind === 'message' ? message.text !== text : true
    const isDegradedResponse = !hasNonNoiseContent && !hasBuddyJsonInOutput && message.kind === 'message'
    if (isDegradedResponse) {
      throw new Error(`Actor produced only noise events (${CONTEXT_EXHAUSTED_PHRASE} likely): ${text.slice(0, 200)}`)
    }

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
      buddy_type: buddyType,
      backend: backendForLauncher(actor, detail.settings.launchers[actor]),
      display_name: detail.settings.launchers[actor]?.display_name
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
        compact_retries: 0,
        updated_at: now
      }
      if (actor === 'claude' && sessionId) next.claude_session_id = sessionId
      if (actor === 'codex' && threadId) next.codex_thread_id = threadId
      if (actor === 'opencode' && sessionId) next.opencode_session_id = sessionId
      if (actor === 'kimi' && sessionId) next.kimi_session_id = sessionId
      const stableSessionId = actor === 'codex' ? (threadId ?? sessionId) : sessionId
      if (stableSessionId) {
        next.agent_sessions = { ...(state.agent_sessions ?? {}), [actor]: stableSessionId }
      }

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
          `${actorDisplayName(pendingBreak?.actor, detail.settings)} 和 ${actorDisplayName(actor, detail.settings)} 均确认当前阶段完成，但指令队列中仍有待执行指令，继续执行。`,
          { kind: 'round_notice', round }
        )
        // Fall through to auto-start logic (skip duplicate actor.finished)
      } else {
        const taskStats = await this.store.getTaskStats(taskId, workspaceKey)
        await this.store.appendTranscript(
          taskId,
          workspaceKey,
          'system',
          `${actorDisplayName(pendingBreak?.actor, detail.settings)} 和 ${actorDisplayName(actor, detail.settings)} 均确认任务完成，任务结束。`,
          { kind: 'round_notice', round, done_reason: 'dual_break_confirmed', ...(taskStats ? { stats: taskStats } : {}) }
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
        // Send system notification for task completion
        if (this.notifier) {
          await this.notifier.notifyTaskDone(taskId, workspaceKey, 'dual_break_confirmed', {
            first: pendingBreak?.actor,
            second: actor
          })
        }
        this.onTaskTerminal?.(workspaceKey)
        return
      }
    }

    if (breakPending) {
      await this.store.appendTranscript(
        taskId,
        workspaceKey,
        'system',
        `${actorDisplayName(actor, detail.settings)} 请求结束任务，等待 ${actorDisplayName(nextActor, detail.settings)} 确认。`,
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
        `${actorDisplayName(actor, detail.settings)} 认为任务尚未完成，${actorDisplayName(pendingBreak?.actor, detail.settings)} 的结束请求已撤回。`,
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
        `${actorDisplayName(actor, detail.settings)} 已达到轮次上限，暂停等待确认。`,
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
      this.onTaskTerminal?.(workspaceKey)
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
    // After a round completes (or the auto-advance left the task in a terminal-ish state),
    // let the queue coordinator re-evaluate the workspace. completeActor may have transitioned
    // to DONE/PAUSED; either way the coordinator will no-op if nothing changed.
    this.onTaskTerminal?.(workspaceKey)
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
      // Send system notification for task completion via failure
      if (this.notifier) {
        await this.notifier.notifyTaskDone(taskId, workspaceKey, 'break_confirmed_on_failure', {
          first: otherActorBreak.actor,
          second: actor
        })
      }
      this.onTaskTerminal?.(workspaceKey)
      return
    }

    const newConsecutiveFailures = (stateBefore.consecutive_failures ?? 0) + 1
    const globalSettings = await this.store.readGlobalSettings()
    const maxConsecutiveFailures = globalSettings.max_consecutive_failures ?? 10
    const thresholdReached = newConsecutiveFailures >= maxConsecutiveFailures

    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      status: thresholdReached ? 'PAUSED' : 'FAILED',
      active_run: null,
      consecutive_failures: newConsecutiveFailures,
      last_error: failure,
      latest_failure: failure,
      compact_retries: 0,
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
      // Send system notification for task paused due to consecutive failures
      if (this.notifier) {
        await this.notifier.notifyTaskPaused(taskId, workspaceKey, actor, newConsecutiveFailures, maxConsecutiveFailures)
      }
    } else {
      // Send system notification for regular task failure
      if (this.notifier) {
        await this.notifier.notifyTaskFailed(taskId, workspaceKey, actor, message)
      }
    }
    this.onTaskTerminal?.(workspaceKey)
  }

  /**
   * Reset the session for an actor by clearing the session ID, marking context
   * as unsent, and generating a compact context summary via LLM so the next
   * executeActor call will start a fresh session with a slim, high-quality
   * context instead of the full one.
   */
  private async resetSessionForActor(
    taskId: string,
    workspaceKey: string,
    actor: string,
    detail: { state: TaskState; task_text: string; context_text: string; transcript: TranscriptEntry[]; settings: TaskSettings }
  ): Promise<void> {
    const sessionKey = actor === 'claude' ? 'claude_session_id'
      : actor === 'codex' ? 'codex_thread_id'
      : actor === 'opencode' ? 'opencode_session_id'
      : actor === 'kimi' ? 'kimi_session_id'
      : null

    // Try to generate a summary via LLM first; fall back to simple truncation
    const taskDirectory = this.store.taskDirectory(taskId, workspaceKey)
    const cwd = await existingCwd(detail.state.repo_root)
    const launcher = detail.settings.launchers[actor] ?? {
      command: actor,
      env: {},
      timeout_seconds: 600
    }
    const summaryContext = await this.summarizeContextViaLLM(
      taskId, workspaceKey, actor, detail, cwd, launcher
    )

    // Use LLM summary if available, otherwise fall back to simple truncation
    const compactContext = summaryContext ?? buildCompactContextFallback(
      detail.task_text,
      detail.context_text,
      detail.transcript,
      actor
    )

    await this.store.updateTaskState(taskId, workspaceKey, (state) => {
      const contextSent = { ...(state.context_sent ?? {}) }
      // Mark context as not sent so the fresh session receives the compact context
      contextSent[actor] = false
      return {
        ...state,
        ...(sessionKey ? { [sessionKey]: null } : {}),
        agent_sessions: { ...(state.agent_sessions ?? {}), [actor]: null },
        context_sent: contextSent
      }
    })

    // Write the compact context to context.md so it gets picked up by
    // buildActorPrompt on the next executeActor call.
    // Backup the original context.md first so the full context is not lost.
    const contextFile = join(taskDirectory, 'context.md')
    const backupFile = join(taskDirectory, 'context.full.md')
    try {
      const original = await readFile(contextFile, 'utf-8')
      if (original.trim()) {
        await writeFile(backupFile, original, 'utf-8')
      }
    } catch { /* context.md may not exist yet */ }
    await writeFile(contextFile, compactContext, 'utf-8')

    await this.store.appendTaskEvent(taskId, workspaceKey, {
      type: 'actor.session_reset',
      actor,
      run_id: `reset_${Date.now()}`,
      payload: {
        reason: 'context_window_limit',
        session_key: sessionKey ?? `agent_sessions.${actor}`,
        summary_method: summaryContext ? 'llm' : 'truncation'
      }
    })
  }

  /**
   * Use an LLM to summarize the task context and transcript into a compact
   * summary for the fresh session. Returns the summary text, or null if
   * the LLM call fails (caller should fall back to simple truncation).
   */
  private async summarizeContextViaLLM(
    taskId: string,
    workspaceKey: string,
    actor: string,
    detail: { state: TaskState; task_text: string; context_text: string; transcript: TranscriptEntry[] },
    cwd: string,
    launcher: Launcher
  ): Promise<string | null> {
    // Build the summarization prompt
    const summarizePrompt = buildSummarizePrompt(
      detail.task_text,
      detail.context_text,
      detail.transcript
    )

    // Pre-check: if the prompt is still very large after size limiting,
    // skip LLM summarization entirely and go straight to truncation fallback.
    // This avoids wasting an API call that would likely fail.
    // Rough estimate: 1 token ≈ 4 chars for English, ≈ 2 chars for CJK.
    // 50000 chars ≈ 12500-25000 tokens, which is safe for most models.
    const estimatedTokens = Math.ceil(summarizePrompt.length / 3)
    const maxTokensForSummarize = 100000 // conservative limit for the input
    if (estimatedTokens > maxTokensForSummarize) {
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'actor.summarize_skipped',
        actor,
        run_id: `summarize_${Date.now()}`,
        payload: { reason: 'prompt_too_large', estimated_tokens: estimatedTokens, char_count: summarizePrompt.length }
      })
      return null
    }

    // Launch a fresh session (no --resume) with the summarization prompt.
    // Write the prompt to a temp file so contract launchers can find it too.
    const taskDirectory = this.store.taskDirectory(taskId, workspaceKey)
    const summarizePromptFile = join(taskDirectory, 'artifacts', `summarize_${Date.now()}-prompt.md`)
    await mkdir(join(taskDirectory, 'artifacts'), { recursive: true })
    await writeFile(summarizePromptFile, summarizePrompt, 'utf-8')

    const summarizeCommand = buildLauncherCommand({
      actor,
      command: launcher.command,
      mode: 'start', // fresh session, no resume
      promptText: summarizePrompt,
      promptFile: summarizePromptFile,
      repoRoot: cwd,
      taskDir: taskDirectory,
      runId: `summarize_${Date.now()}`,
      backend: launcher.backend,
      model: launcher.model,
      cursor: launcher.cursor
    })

    const outputLines: string[] = []
    const stderrLines: string[] = []

    try {
      const summarizeRunId = `summarize_${Date.now()}`
      const needsPty = kindNeedsPty(summarizeCommand.kind)
      let result: { exitCode: number | null; signal: string | null }

      if (needsPty) {
        result = await runLauncherWithPty({
          command: summarizeCommand.command,
          args: summarizeCommand.args,
          cwd,
          env: { ...launcher.env, ...(summarizeCommand.env ?? {}) },
          timeoutMs: 120000,
          onData: (data) => {
            for (const line of data.split(/\r?\n/).filter(Boolean)) {
              outputLines.push(line)
            }
          }
        })
      } else {
        result = await runLauncher({
          command: summarizeCommand.command,
          args: summarizeCommand.args,
          cwd,
          env: { ...launcher.env, ...(summarizeCommand.env ?? {}) },
          stdinText: summarizeCommand.stdinText,
          timeoutMs: 120000, // 2 minutes for summarization
          onStdout: (line) => outputLines.push(line),
          onStderr: (line) => stderrLines.push(line)
        })
      }

      if (result.exitCode !== 0) {
        // Log summarization failure
        const stderrText = stderrLines.join('\n').trim()
        await this.store.appendTaskEvent(taskId, workspaceKey, {
          type: 'actor.summarize_failed',
          actor,
          run_id: `summarize_${Date.now()}`,
          payload: { exit_code: result.exitCode, stderr_preview: stderrText.slice(0, 1000) }
        })
        return null
      }

      // Extract text from the LLM output
      const stdoutText = outputLines.join('\n')
      const extracted = extractActorOutput(parserActorForKind(actor, summarizeCommand.kind), stdoutText)

      if (!extracted.trim()) {
        await this.store.appendTaskEvent(taskId, workspaceKey, {
          type: 'actor.summarize_failed',
          actor,
          run_id: `summarize_${Date.now()}`,
          payload: { reason: 'empty_output' }
        })
        return null
      }

      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'actor.summarize_succeeded',
        actor,
        run_id: `summarize_${Date.now()}`,
        payload: { summary_length: extracted.length }
      })

      return extracted.trim()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      await this.store.appendTaskEvent(taskId, workspaceKey, {
        type: 'actor.summarize_failed',
        actor,
        run_id: `summarize_${Date.now()}`,
        payload: { error: errMsg.slice(0, 1000) }
      })
      return null
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

/**
 * Build a summarization prompt that asks the LLM to condense the task context
 * and transcript into a compact summary for the fresh session.
 *
 * Size limits are enforced to prevent the summarize prompt itself from exceeding
 * the model's context window (which would make summarization always fail):
 * - Max 10 most recent transcript entries
 * - Max 2000 chars per entry
 * - Max 50000 chars total for the prompt
 */
const SUMMARIZE_MAX_TRANSCRIPT_ENTRIES = 10
const SUMMARIZE_MAX_ENTRY_CHARS = 2000
const SUMMARIZE_MAX_PROMPT_CHARS = 50000

function buildSummarizePrompt(
  taskText: string,
  contextText: string,
  transcript: TranscriptEntry[]
): string {
  const parts: string[] = []

  parts.push('请将以下任务上下文和对话记录总结为一份精简摘要。')
  parts.push('')
  parts.push('要求：')
  parts.push('1. 保留关键决策、发现和未解决问题')
  parts.push('2. 去除冗余和重复信息')
  parts.push('3. 保持摘要简洁（不超过 2000 字）')
  parts.push('4. 用 markdown 格式输出')
  parts.push('5. 直接输出摘要内容，不要有额外的解释或前言')
  parts.push('')

  if (taskText.trim()) {
    parts.push('## 任务描述')
    parts.push(taskText.trim())
    parts.push('')
  }

  if (contextText.trim()) {
    // Truncate context to avoid prompt being too large
    const ctx = contextText.trim()
    const maxCtxLen = 10000
    if (ctx.length > maxCtxLen) {
      parts.push('## 背景上下文（已截断）')
      parts.push(ctx.slice(0, maxCtxLen))
      parts.push('...（上下文已截断）')
    } else {
      parts.push('## 背景上下文')
      parts.push(ctx)
    }
    parts.push('')
  }

  // Include only the most recent transcript entries, with size limits
  if (transcript.length > 0) {
    parts.push('## 对话记录')
    const recentEntries = transcript.slice(-SUMMARIZE_MAX_TRANSCRIPT_ENTRIES)
    for (const entry of recentEntries) {
      const roleLabel = entry.role === 'human' ? '用户'
        : entry.role === 'system' ? '系统'
        : actorDisplayName(entry.role)
      const content = entry.content.length > SUMMARIZE_MAX_ENTRY_CHARS
        ? entry.content.slice(0, SUMMARIZE_MAX_ENTRY_CHARS) + '...（已截断）'
        : entry.content
      parts.push(`### ${roleLabel}`)
      parts.push(content)
      parts.push('')
    }
  }

  parts.push('## 输出要求')
  parts.push('请输出一份精简的上下文摘要，包含：当前进展、关键发现、待解决问题。不要输出任何其他内容。')

  let result = parts.join('\n')

  // Hard limit: if the prompt exceeds the max size, truncate from the middle
  if (result.length > SUMMARIZE_MAX_PROMPT_CHARS) {
    result = result.slice(0, SUMMARIZE_MAX_PROMPT_CHARS) + '\n\n...（提示词已截断，请基于以上内容总结）'
  }

  return result
}

/**
 * Build a compact context fallback for a fresh session when LLM summarization
 * fails. Uses simple truncation instead of AI-powered summarization.
 */
function buildCompactContextFallback(
  taskText: string,
  contextText: string,
  transcript: TranscriptEntry[],
  _actor: string
): string {
  const parts: string[] = []

  parts.push('> ⚠️ 上一轮会话因上下文窗口限制已重置。以下是精简后的上下文摘要。')
  parts.push('')

  // Include the task text (usually short)
  if (taskText.trim()) {
    parts.push('## 任务')
    parts.push(taskText.trim())
    parts.push('')
  }

  // Condense context text: take first 2000 chars if too long
  if (contextText.trim()) {
    const trimmed = contextText.trim()
    if (trimmed.length > 2000) {
      parts.push('## 背景上下文（已截断）')
      parts.push(trimmed.slice(0, 2000))
      parts.push('...（上下文已截断，详细内容请参考代码库）')
    } else {
      parts.push('## 背景上下文')
      parts.push(trimmed)
    }
    parts.push('')
  }

  // Include only the last 2 transcript entries (most recent actor turns)
  const recentTranscript = transcript.slice(-2)
  if (recentTranscript.length > 0) {
    parts.push('## 最近对话（摘要）')
    for (const entry of recentTranscript) {
      const roleLabel = entry.role === 'human' ? '用户'
        : entry.role === 'system' ? '系统'
        : actorDisplayName(entry.role)
      // Truncate each entry to 500 chars
      const content = entry.content.length > 500
        ? entry.content.slice(0, 500) + '...（已截断）'
        : entry.content
      parts.push(`**${roleLabel}**: ${content}`)
    }
    parts.push('')
  }

  parts.push('请基于以上摘要继续工作。如需更多上下文，请查阅代码库。')

  return parts.join('\n')
}

export function needsHealthCheck(state: TaskState, settings: TaskSettings): boolean {
  if (state.round > 0) return false
  // A partial health-check failure may already have persisted the passing
  // actor's session. The recorded failure must take precedence over sessions
  // so Retry performs connectivity checks again.
  if (state.health_check?.failed_actor) return true
  if (state.health_check) return false
  const implementer = settings.implementer_actor
    ?? (settings.role_mode === 'codex_implements' ? 'codex' : 'claude')
  const reviewer = settings.reviewer_actor
    ?? (settings.role_mode === 'codex_implements' ? 'claude' : 'codex')
  const implSession = sessionIdForActor(implementer, state, settings)
  const revSession = sessionIdForActor(reviewer, state, settings)
  return !implSession && !revSession
}

function statusForActor(actor: string, launcher?: Launcher): TaskState['status'] | undefined {
  const kind = commandKindFor(actor, launcher?.command ?? '', launcher?.backend)
  if (kind === 'native_claude') return 'RUNNING_CLAUDE'
  if (kind === 'native_codex') return 'RUNNING_CODEX'
  if (kind === 'native_opencode') return 'RUNNING_OPENCODE'
  if (kind === 'native_kimi') return 'RUNNING_KIMI'
  if (kind === 'native_cursor') return 'RUNNING_CURSOR'
  if (actor === 'claude') return 'RUNNING_CLAUDE'
  if (actor === 'codex') return 'RUNNING_CODEX'
  if (actor === 'opencode') return 'RUNNING_OPENCODE'
  if (actor === 'kimi') return 'RUNNING_KIMI'
  return undefined
}

function backendForLauncher(actor: string, launcher?: Launcher): string {
  const kind = commandKindFor(actor, launcher?.command ?? '', launcher?.backend)
  return kind.startsWith('native_') ? kind.slice('native_'.length) : 'contract'
}

function sessionIdForActor(actor: string, state: TaskState, settings?: Partial<TaskSettings>): string | undefined {
  if (Object.prototype.hasOwnProperty.call(state.agent_sessions ?? {}, actor)) {
    return state.agent_sessions?.[actor] ?? undefined
  }
  const seededProfileSession = settings?.seed_agent_sessions?.[actor]
  if (seededProfileSession) return seededProfileSession
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
  return actor
}

export function lastValue(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter(Boolean)
  return filtered[filtered.length - 1]
}

/** Check if stderr text contains only known CLI warnings (not real errors) */
export function isCliWarningOnly(stderrText: string): boolean {
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

/** Check if an error message indicates a context window limit error */
export function isContextWindowLimitError(message: string): boolean {
  return CONTEXT_WINDOW_LIMIT_PATTERNS.some((p) => p.test(message))
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

export async function collectRawEvents(
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

export async function collectOutputText(
  actor: string,
  kind: LauncherCommandKind,
  outputFile: string,
  stdoutText: string,
  cursorPartialOutput = false
): Promise<string> {
  if (kind === 'native_claude' || kind === 'native_opencode' || kind === 'native_kimi' || kind === 'native_cursor') {
    const parserActor = parserActorForKind(actor, kind)
    let output = extractActorOutput(parserActor, stdoutText, { cursorPartialOutput })
    let message = parseBuddyMessage(output)

    // Fallback: some models (e.g. DeepSeek via OpenCode/Kimi) output buddy JSON
    // via echo/bash commands. The buddy message appears in part.state.output
    // of tool_use events. extractActorOutput may miss it if the text events
    // contain preamble that masks the break signal.
    if (message.kind !== 'break' && (kind === 'native_opencode' || kind === 'native_kimi')) {
      for (const event of parseJsonlBuffer(stdoutText)) {
        if (event.type === 'tool_use') {
          const part = event.part
          if (part && typeof part === 'object' && !Array.isArray(part)) {
            const state = (part as Record<string, unknown>).state
            if (state && typeof state === 'object' && !Array.isArray(state)) {
              const toolOutput = typeof (state as Record<string, unknown>).output === 'string'
                ? (state as Record<string, unknown>).output as string
                : undefined
              if (toolOutput) {
                const toolMessage = parseBuddyMessage(toolOutput.trim())
                if (toolMessage.kind === 'break') {
                  message = toolMessage
                  break
                }
              }
            }
          }
        }
      }
    }

    // If break was found in tool output but not in extracted text, prepend it
    // so completeActor's parseBuddyMessage call detects it (it finds the first match)
    if (message.kind === 'break' && parseBuddyMessage(output).kind !== 'break') {
      output = JSON.stringify({ type: 'break', content: message.content }) + '\n' + output
    }

    const normalized = JSON.stringify({
      type: message.kind === 'break' ? 'break' : 'chat',
      content: message.kind === 'break' ? (message.content ?? message.reason ?? '') : (message.text ?? '')
    })
    await writeFile(outputFile, normalized)
    return output
  }

  if (await fileExists(outputFile)) return readFile(outputFile, 'utf8')
  const extracted = extractActorOutput(
    parserActorForKind(actor, kind),
    stdoutText,
    { cursorPartialOutput }
  )
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
