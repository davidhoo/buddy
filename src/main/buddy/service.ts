import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  AttachmentMeta,
  BootstrapResponse,
  CountdownInput,
  CreateTaskInput,
  CreateTaskResult,
  CursorModelCatalog,
  CursorModelDiscoveryInput,
  Event,
  GlobalSettings,
  InstructionQueueItem,
  Launcher,
  RoundEventSummary,
  SendMessageInput,
  TestLauncherResult,
  StartTaskInput,
  Task,
  TaskDetail,
  TaskStats
} from '../../shared/types'
import { BuddyEventBus } from './events'
import {
  getGitStatus,
  gitStageAll,
  gitCommitAndPush,
  gitDiffForCommitMessage,
  generateCommitMessage
} from './git'
import type { GitStatusResult } from '../../shared/types'
import { BuddyRunner } from './runner'
import { BuddyStore } from './store'
import { QueueCoordinator } from './queue-coordinator'
import { createTaskNotifier } from './notifications'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { buildLauncherCommand, commandKindFor, kindNeedsPty, parserActorForKind, runLauncher, runLauncherWithPty } from './launchers'
import { buildPingPrompt } from './prompts'
import { parseActorEvents, parseBuddyMessage } from './parsers'
import { collectRawEvents, collectOutputText, lastValue, isCliWarningOnly } from './runner'
import { discoverCursorModels } from './cursor-models'

export interface BuddyCoreServiceOptions {
  dataRoot?: string
  events?: BuddyEventBus
}

export class BuddyCoreService {
  private readonly store: BuddyStore
  private readonly runner: BuddyRunner
  private readonly events?: BuddyEventBus
  private coordinator?: QueueCoordinator

  constructor(options: BuddyCoreServiceOptions | string = {}) {
    const normalized = typeof options === 'string' ? { dataRoot: options } : options
    this.events = normalized.events
    this.store = new BuddyStore(normalized.dataRoot ?? defaultDataRoot())
    const notifier = createTaskNotifier(this.store)
    this.runner = new BuddyRunner(this.store, { events: normalized.events, notifier })
    this.coordinator = new QueueCoordinator({ store: this.store, runner: this.runner, events: normalized.events })
    this.runner.onTaskTerminal = (workspaceKey) => {
      void this.coordinator?.onTaskTerminal(workspaceKey)
    }
  }

  getCoordinator(): QueueCoordinator | undefined {
    return this.coordinator
  }

  getStore(): BuddyStore {
    return this.store
  }

  async updateTaskText(taskId: string, workspaceKey: string, taskText: string): Promise<void> {
    return this.store.updateTaskText(taskId, workspaceKey, taskText)
  }

  async checkHealth(): Promise<boolean> {
    return true
  }

  async bootstrap(): Promise<BootstrapResponse> {
    let locale: string | undefined
    try { locale = app?.getLocale() } catch { /* not available in test env */ }
    return {
      version: 'native',
      repo_root: '',
      data_root: this.store.dataRoot,
      home_dir: homedir(),
      locale,
      tasks: await this.store.getTasks(),
      global_settings: await this.store.readGlobalSettings()
    }
  }

  getTasks(): Promise<Task[]> {
    return this.store.getTasks()
  }

  getTaskDetail(taskId: string, workspaceKey?: string): Promise<TaskDetail> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getTaskDetail(taskId, workspaceKey)
  }

  createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    return this.store.createTask(input)
  }

  async deleteTask(taskId: string, workspaceKey?: string): Promise<void> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    await this.store.deleteTask(taskId, workspaceKey)
    // Removing a blocking task may unblock the queue.
    void this.coordinator?.onTaskTerminal(workspaceKey)
  }

  async startTask(taskId: string, input: StartTaskInput): Promise<void> {
    if (!input.workspace_key) throw new Error('workspace_key is required')
    const state = await this.store.readTaskState(taskId, input.workspace_key).catch(() => null)
    // A queued task must not be started directly by the renderer via runner.startTask, because
    // runner.canStartFrom('QUEUED') is false. Any manual user start on a queued task — whether
    // waiting, superseded, or a blocked active task (PAUSED/FAILED) — goes through the
    // coordinator's manual activation path, which preserves queue identity and supersede logic.
    if (state && state.execution_mode === 'queued') {
      await this.coordinator?.startQueuedNow(taskId, input.workspace_key)
      return
    }
    await this.runner.startTask(taskId, input)
    // After an immediate start, re-evaluate the queue in case this task is itself an
    // immediate-execution task that should block queued advancement.
    void this.coordinator?.reconcile(input.workspace_key)
  }

  sendMessage(taskId: string, input: SendMessageInput): Promise<void> {
    return this.runner.sendMessage(taskId, input)
  }

  async skipCountdown(taskId: string, input: CountdownInput): Promise<void> {
    await this.runner.skipCountdown(taskId, input)
  }

  pauseCountdown(taskId: string, input: CountdownInput): Promise<void> {
    return this.runner.pauseCountdown(taskId, input)
  }

  interrupt(taskId: string, workspaceKey?: string): Promise<void> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.runner.interrupt(taskId, workspaceKey)
  }

  enqueueInstruction(taskId: string, workspaceKey: string, content: string, attachments?: AttachmentMeta[]): Promise<InstructionQueueItem> {
    return this.runner.enqueueInstruction(taskId, workspaceKey, content, attachments)
  }

  dequeueInstruction(taskId: string, workspaceKey: string, itemId: string): Promise<void> {
    return this.runner.dequeueInstruction(taskId, workspaceKey, itemId)
  }

  clearInstructionQueue(taskId: string, workspaceKey: string): Promise<void> {
    return this.runner.clearInstructionQueue(taskId, workspaceKey)
  }

  interruptAndInsert(taskId: string, workspaceKey: string, queueItemId: string): Promise<void> {
    return this.runner.interruptAndInsert(taskId, workspaceKey, queueItemId)
  }

  getEvents(taskId: string, since: number, workspaceKey?: string): Promise<{ events: Event[] }> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getEvents(taskId, since, workspaceKey)
  }

  getRoundEvents(taskId: string, runId: string, workspaceKey?: string, actor?: string, command?: string): Promise<RoundEventSummary | null> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getRoundEvents(taskId, runId, workspaceKey, actor, command)
  }

  getTaskStats(taskId: string, workspaceKey?: string, throughRound?: number): Promise<TaskStats | null> {
    if (!workspaceKey) throw new Error('workspaceKey is required')
    return this.store.getTaskStats(taskId, workspaceKey, throughRound)
  }

  updateGlobalSettings(settings: GlobalSettings): Promise<GlobalSettings> {
    return this.store.updateGlobalSettings(settings)
  }

  listCursorModels(input?: CursorModelDiscoveryInput): Promise<CursorModelCatalog> {
    return discoverCursorModels(input)
  }

  gitStatus(repoRoot: string): Promise<GitStatusResult> {
    return getGitStatus(repoRoot)
  }

  gitStageAll(repoRoot: string): Promise<void> {
    return gitStageAll(repoRoot)
  }

  gitCommitAndPush(repoRoot: string, message: string, remote: string, push?: boolean): Promise<{ commitHash: string }> {
    return gitCommitAndPush(repoRoot, message, remote, push)
  }

  gitDiffForCommitMessage(repoRoot: string): Promise<string> {
    return gitDiffForCommitMessage(repoRoot)
  }

  generateCommitMessage(repoRoot: string, actorCommand?: string, lang?: string): Promise<string> {
    return generateCommitMessage(repoRoot, actorCommand, lang)
  }

  async recoverInterruptedRuns(): Promise<void> {
    const tasks = await this.store.getTasks()
    for (const task of tasks) {
      const wasRunning = task.status.startsWith('RUNNING_') || task.status === 'PINGING'
      if (wasRunning) {
        const event = await this.store.appendTaskEvent(task.task_id, task.workspace_key, {
          type: 'actor.interrupted',
          payload: { reason: 'app_restarted' }
        })
        await this.store.updateTaskState(task.task_id, task.workspace_key, (state) => ({
          ...state,
          status: 'PAUSED',
          active_run: null,
          updated_at: new Date().toISOString()
        }))
        this.events?.publish({
          workspace_key: task.workspace_key,
          task_id: task.task_id,
          event
        })
      }
    }
    // After recovery, rebuild per-workspace queues and run a safe scheduling pass.
    // A previously-running queued task is now PAUSED and blocks its queue — no auto-start.
    // Unblocked workspaces with waiting tasks will start their queue head.
    await this.coordinator?.rebuildAndReconcileAll()
  }

  async testLauncher(
    actor: string,
    command: string,
    env?: Record<string, string>,
    options: Partial<Launcher> = {}
  ): Promise<TestLauncherResult> {
    const PING_TIMEOUT_SECONDS = 120
    const launcher: Launcher = {
      command,
      env: { ...env },
      timeout_seconds: options.timeout_seconds ?? PING_TIMEOUT_SECONDS,
      ...options
    }

    // Phase 1: Tool check - verify the command exists and can be spawned
    try {
      const splitCmd = command.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command]
      const baseExecutable = splitCmd[0]?.replace(/^"|"$/g, '') ?? ''
      await new Promise<void>((resolve, reject) => {
        const child = spawn(baseExecutable, ['--version'], {
          env: { ...process.env, ...env },
          stdio: 'pipe',
          timeout: 10000
        })
        let settled = false
        child.on('error', (err) => {
          if (settled) return
          settled = true
          reject(err)
        })
        child.on('spawn', () => {
          if (settled) return
          settled = true
          child.kill('SIGTERM')
          resolve()
        })
        // Fallback timeout in case spawn event never fires
        setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGTERM')
          resolve()
        }, 8000)
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        actor,
        success: false,
        phase: 'tool_check',
        error: message.slice(0, 300)
      }
    }

    // Phase 2: Ping test - actually invoke the actor with a hello prompt
    const testDir = join(tmpdir(), `buddy-test-${actor}-${Date.now()}`)
    try {
      await mkdir(testDir, { recursive: true })
      const runId = `test_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
      const prompt = buildPingPrompt(actor)
      const promptFile = join(testDir, `${runId}-prompt.md`)
      const outputFile = join(testDir, `${runId}-output.md`)
      const eventFile = join(testDir, `${runId}-events.jsonl`)
      await writeFile(promptFile, prompt, { mode: 0o600 })

      const commandKind = commandKindFor(actor, command, launcher.backend)
      const launcherCommand = buildLauncherCommand({
        actor,
        command,
        mode: 'start',
        promptFile,
        promptText: prompt,
        eventFile,
        outputFile,
        repoRoot: testDir,
        taskDir: testDir,
        runId,
        backend: launcher.backend,
        model: launcher.model,
        cursor: launcher.cursor
      })

      const outputLines: string[] = []
      const stderrLines: string[] = []

      try {
        const needsPty = kindNeedsPty(launcherCommand.kind)
        let result: { exitCode: number | null; signal: string | null }

        if (needsPty) {
          result = await runLauncherWithPty({
            command: launcherCommand.command,
            args: launcherCommand.args,
            cwd: testDir,
            env: { ...env, ...(launcherCommand.env ?? {}) },
            timeoutMs: PING_TIMEOUT_SECONDS * 1000,
            onData: (data) => {
              for (const line of data.split(/\r?\n/).filter(Boolean)) {
                outputLines.push(line)
              }
            }
          })
        } else {
          result = await runLauncher({
            command: launcherCommand.command,
            args: launcherCommand.args,
            cwd: testDir,
            env: { ...env, ...(launcherCommand.env ?? {}) },
            stdinText: launcherCommand.stdinText,
            timeoutMs: PING_TIMEOUT_SECONDS * 1000,
            onStdout: (line) => outputLines.push(line),
            onStderr: (line) => stderrLines.push(line)
          })
        }

        const stdoutText = outputLines.join('\n')
        const rawEvents = await collectRawEvents(eventFile, stdoutText, launcherCommand.kind)
        const cursorPartialOutput = launcherCommand.kind === 'native_cursor'
          && launcher.cursor?.stream_partial_output === true
        const outputText = await collectOutputText(
          actor,
          launcherCommand.kind,
          outputFile,
          stdoutText,
          cursorPartialOutput
        )
        const parsedLines = parseActorEvents(
          parserActorForKind(actor, launcherCommand.kind),
          rawEvents,
          { cursorPartialOutput }
        )

        if (result.exitCode !== 0) {
          const stderrText = stderrLines.join('\n').trim()
          const error = stderrText || outputText.trim() || `Process exited with code ${result.exitCode}`
          return {
            actor,
            success: false,
            phase: 'ping',
            error: error.slice(0, 300)
          }
        }

        // Verify the actor responded with a valid buddy message
        const message = parseBuddyMessage(outputText)
        const hasContent = message.kind === 'message'
          ? message.text.trim().length > 0
          : message.content.trim().length > 0
        if (!hasContent) {
          return {
            actor,
            success: false,
            phase: 'ping',
            error: 'Actor responded with empty content'
          }
        }

        const sessionId = lastValue(parsedLines.map((line: any) => line.sessionId))
        const threadId = lastValue(parsedLines.map((line: any) => line.threadId))
        const preview = message.kind === 'message'
          ? message.text.slice(0, 200)
          : message.content.slice(0, 200)

        return {
          actor,
          success: true,
          phase: 'ping',
          sessionId,
          threadId,
          responsePreview: preview
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const stderrText = stderrLines.join('\n').trim()
        const isOnlyWarning = stderrText && isCliWarningOnly(stderrText)
        return {
          actor,
          success: false,
          phase: 'ping',
          error: (message || (!isOnlyWarning ? stderrText : 'Actor exited without producing any output')).slice(0, 300)
        }
      }
    } finally {
      // Clean up temp directory
      try { await rm(testDir, { recursive: true, force: true }) } catch { /* ignore cleanup errors */ }
    }
  }
}

function defaultDataRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'buddy')
}
