import type { BuddyStore } from './store'
import type { BuddyRunner } from './runner'
import type { BuddyEventBus } from './events'
import type { Task, TaskState } from '../../shared/types'

/**
 * Per-project FIFO queue coordinator.
 *
 * A queued task (execution_mode === 'queued') belongs to exactly one workspace_key.
 * Within a workspace, queued tasks form a FIFO ordered by enqueued_at, then created_at, then task_id.
 * At most one queued task may be "active" (running or paused/failed from a prior run) per workspace.
 *
 * Auto-advancement conditions (all must hold) before the earliest waiting queued task starts:
 *  1. No incomplete immediate-execution task in the workspace that blocks the queue.
 *  2. No queued task that is already active or blocking the queue (PAUSED, FAILED, PINGING, RUNNING, COUNTDOWN).
 *  3. The candidate is the earliest waiting queued task.
 *
 * A queued task only allows the next one to start after it reaches DONE. PAUSED/FAILED blocks.
 *
 * Manual start (run now) of any queued task bypasses ordering/blockers: it becomes the new
 * active queue point, and every earlier non-DONE waiting queued task is marked superseded
 * (its data is preserved). After the manual task reaches DONE, advancement resumes from the
 * tasks created after it.
 *
 * Reconcile coalescing: each workspace keeps a single in-flight reconcile. Extra requests
 * arriving while one is running only set a `dirty` flag, so at most one extra re-scan is
 * appended after the current one finishes. Different workspaces reconcile in parallel.
 */

type ActivationSource = 'automatic' | 'manual'

/** Signature identifying a unique blocked state, used to dedupe queue.blocked events. */
interface BlockSignature {
  workspace_key: string
  head_task_id: string
  blocked_task_id: string
  reason: string
}

export interface QueueCoordinatorOptions {
  store: BuddyStore
  runner: BuddyRunner
  events?: BuddyEventBus
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export class QueueCoordinator {
  private readonly store: BuddyStore
  private readonly runner: BuddyRunner
  private readonly events?: BuddyEventBus
  /**
   * Per-workspace reconcile state. `running` holds the in-flight promise; `dirty` means a
   * later request arrived during the run and one re-scan must follow. `lastSignature` is the
   * most recent queue.blocked signature emitted, so identical re-blocks don't flood the log.
   */
  private readonly reconcileState = new Map<string, { running: Promise<void>; dirty: boolean }>()
  private readonly lastSignature = new Map<string, BlockSignature>()

  constructor(options: QueueCoordinatorOptions) {
    this.store = options.store
    this.runner = options.runner
    this.events = options.events
  }

  /**
   * Rebuild the per-workspace queue snapshots purely from disk state and run a single safe
   * scheduling pass for every workspace. Called once on app startup, after recovery.
   */
  async rebuildAndReconcileAll(): Promise<void> {
    const tasks = await this.store.getTasks()
    const workspaceKeys = new Set(tasks.map((t) => t.workspace_key))
    await Promise.all(
      Array.from(workspaceKeys).map((ws) => this.reconcile(ws))
    )
  }

  /**
   * Main entry point. Safe to call repeatedly and concurrently — per-workspace serialization
   * guarantees the same waiting task is started at most once, and coalescing collapses bursts
   * of redundant reconcile requests into at most one extra re-scan.
   */
  reconcile(workspaceKey: string): Promise<void> {
    const existing = this.reconcileState.get(workspaceKey)
    if (existing) {
      // A reconcile is already running for this workspace — fold this request into a single
      // follow-up scan instead of queuing another full pass.
      existing.dirty = true
      return existing.running
    }
    const run = this.runReconcileChain(workspaceKey)
    this.reconcileState.set(workspaceKey, { running: run, dirty: false })
    return run
  }

  /**
   * Run reconcileInner, then if a later request marked the workspace dirty during the run,
   * re-scan once. Repeats only while new requests keep arriving mid-scan. Each scan reads the
   * latest disk state, so coalescing never starts a task twice or acts on stale data. The
   * workspace entry is deleted once the chain fully settles, so a request arriving after the
   * last scan starts a clean chain.
   */
  private async runReconcileChain(workspaceKey: string): Promise<void> {
    try {
      await this.reconcileInner(workspaceKey)
      while (this.reconcileState.get(workspaceKey)?.dirty) {
        // Clear dirty while still holding the entry so a request arriving during the re-scan
        // re-sets it instead of starting a competing fresh chain.
        this.reconcileState.get(workspaceKey)!.dirty = false
        await this.reconcileInner(workspaceKey)
      }
    } finally {
      this.reconcileState.delete(workspaceKey)
    }
  }

  private async reconcileInner(workspaceKey: string): Promise<void> {
    const tasks = await this.store.getTasks()
    const workspaceTasks = tasks.filter((t) => t.workspace_key === workspaceKey)
    if (workspaceTasks.length === 0) {
      this.lastSignature.delete(workspaceKey)
      return
    }

    // Load full states for queued/immediate tasks in this workspace.
    const states: Array<{ task: Task; state: TaskState }> = []
    for (const task of workspaceTasks) {
      try {
        const state = await this.store.readTaskState(task.task_id, workspaceKey)
        states.push({ task, state })
      } catch {
        // Unreadable task — skip; detail load surfaces schema errors elsewhere.
      }
    }

    // 1) Incomplete immediate-execution tasks block the queue.
    const hasIncompleteImmediate = states.some(
      (entry) => effectiveMode(entry.state) === 'immediate' && blocksQueue(entry.state)
    )

    const queuedEntries = states.filter((entry) => effectiveMode(entry.state) === 'queued')
    // 2) A queued task that is active (running/paused/failed/countdown/pinging) blocks advancement.
    //    Superseded tasks (queue.state === 'superseded') never block, even if not DONE.
    const hasActiveQueued = queuedEntries.some((entry) =>
      entry.state.queue?.state !== 'superseded' &&
      entry.state.status !== 'QUEUED' &&
      entry.state.status !== 'DONE'
    )

    if (hasIncompleteImmediate || hasActiveQueued) {
      // Record a blocked event (deduped by signature) when a waiting task exists but can't start.
      const blocker = this.findBlocker(states, hasIncompleteImmediate, hasActiveQueued)
      const earliestWaiting = this.earliestWaiting(queuedEntries)
      if (earliestWaiting && blocker) {
        await this.recordBlocked(workspaceKey, earliestWaiting, blocker)
      }
      return
    }

    // 3) Pick the earliest waiting queued task.
    const candidate = this.earliestWaiting(queuedEntries)
    if (!candidate) {
      // Queue successfully idle/advanced — clear any prior blocked signature.
      this.lastSignature.delete(workspaceKey)
      return
    }

    // About to advance — clear the prior blocked signature before starting the next task.
    this.lastSignature.delete(workspaceKey)
    await this.activateAndStart(workspaceKey, candidate, 'automatic')
  }

  private findBlocker(
    states: Array<{ task: Task; state: TaskState }>,
    hasIncompleteImmediate: boolean,
    hasActiveQueued: boolean
  ): { task_id: string; reason: string } | null {
    if (hasActiveQueued) {
      const active = states.find(
        (e) => effectiveMode(e.state) === 'queued' &&
          e.state.queue?.state !== 'superseded' &&
          e.state.status !== 'DONE' && e.state.status !== 'QUEUED'
      )
      if (active) return { task_id: active.task.task_id, reason: 'active_queued_task' }
    }
    if (hasIncompleteImmediate) {
      const imm = states.find(
        (e) => effectiveMode(e.state) === 'immediate' && blocksQueue(e.state)
      )
      if (imm) return { task_id: imm.task.task_id, reason: 'incomplete_immediate_task' }
    }
    return null
  }

  private earliestWaiting(
    entries: Array<{ task: Task; state: TaskState }>
  ): { task: Task; state: TaskState } | null {
    const waiting = entries.filter(
      (e) => e.state.status === 'QUEUED' && e.state.queue?.state === 'waiting'
    )
    if (waiting.length === 0) return null
    waiting.sort((a, b) => compareQueueOrder(a.state, a.task, b.state, b.task))
    return waiting[0]
  }

  /**
   * Activate a waiting queued task (mark queue.state=active) and start it.
   * Used by both automatic advancement and manual "run now".
   */
  private async activateAndStart(
    workspaceKey: string,
    entry: { task: Task; state: TaskState },
    source: ActivationSource
  ): Promise<void> {
    const now = utcNow()
    const taskId = entry.task.task_id
    // Atomically flip queue.state to active + status to READY so the runner can pick it up.
    await this.store.updateTaskState(taskId, workspaceKey, (state) => ({
      ...state,
      status: 'READY',
      queue: {
        ...(state.queue ?? { state: 'waiting' as const, enqueued_at: now }),
        state: 'active',
        activated_at: now,
        activation_source: source
      }
    }))

    await this.appendQueueEvent(workspaceKey, taskId, 'queue.activated', {
      activation_source: source,
      enqueued_at: entry.state.queue?.enqueued_at ?? now
    })

    // Start the task. If the runner throws (e.g. round window), it leaves the task PAUSED which
    // blocks the queue — which is the desired behavior.
    try {
      await this.runner.startTask(taskId, { workspace_key: workspaceKey })
    } catch (error) {
      // Activation already recorded; the runner transitioned to PAUSED/FAILED as appropriate.
      // Surface the failure as a queue event for observability.
      const message = error instanceof Error ? error.message : String(error)
      await this.appendQueueEvent(workspaceKey, taskId, 'queue.blocked', {
        reason: 'start_failed',
        blocked_task_id: taskId,
        error: message.slice(0, 300)
      })
    }
  }

  /**
   * Manual run now: activate a queued task out of order. Every earlier non-DONE queued task is
   * superseded (state preserved, removed from the auto-advancement chain) — whether it was
   * waiting (QUEUED) or already active but blocked (PAUSED/FAILED/COUNTDOWN). This matches the
   * spec: earlier non-completed queued tasks leave the auto-advancement chain on manual start.
   *
   * Bypasses immediate-task blockers and queue ordering. After this task reaches DONE the
   * queue advances from the tasks created after it.
   */
  async startQueuedNow(taskId: string, workspaceKey: string): Promise<void> {
    const state = await this.store.readTaskState(taskId, workspaceKey)
    if (effectiveMode(state) !== 'queued') {
      throw new Error('Task is not a queued task')
    }
    const targetOrderRef = { task_id: taskId } as Task
    // Supersede every earlier non-DONE queued task (waiting OR active-but-blocked).
    const tasks = await this.store.getTasks()
    const queued = tasks.filter((t) => t.workspace_key === workspaceKey)
    for (const t of queued) {
      if (t.task_id === taskId) continue
      try {
        const s = await this.store.readTaskState(t.task_id, workspaceKey)
        if (effectiveMode(s) !== 'queued') continue
        // Only supersede tasks created earlier than the manually-started one.
        if (compareQueueOrder(s, t, state, targetOrderRef) >= 0) continue
        // Skip tasks already DONE (nothing to do) or already superseded (idempotent).
        if (s.status === 'DONE') continue
        if (s.queue?.state === 'superseded') continue
        await this.store.updateTaskState(t.task_id, workspaceKey, (st) => ({
          ...st,
          queue: { ...(st.queue ?? { state: 'waiting' as const, enqueued_at: utcNow() }), state: 'superseded' }
        }))
        await this.appendQueueEvent(workspaceKey, t.task_id, 'queue.superseded', {
          superseded_by: taskId,
          original_enqueued_at: s.queue?.enqueued_at,
          prior_status: s.status,
          prior_queue_state: s.queue?.state
        })
      } catch {
        // Skip unreadable.
      }
    }

    // Activate the chosen task manually. If it was previously waiting (or superseded), flip to
    // active+READY. If it was PAUSED/FAILED/COUNTDOWN (an active task being manually resumed),
    // keep its queue identity active and resume execution.
    const isQueuedWaiting = state.status === 'QUEUED' &&
      (state.queue?.state === 'waiting' || state.queue?.state === 'superseded')
    if (isQueuedWaiting) {
      await this.activateAndStart(workspaceKey, { task: { task_id: taskId, workspace_key: workspaceKey } as Task, state }, 'manual')
    } else {
      // Already active (paused/failed/countdown) — manual resume keeps queue identity.
      const now = utcNow()
      await this.store.updateTaskState(taskId, workspaceKey, (st) => ({
        ...st,
        // If somehow still QUEUED, flip to READY so the runner can start it.
        status: st.status === 'QUEUED' ? 'READY' : st.status,
        queue: {
          ...(st.queue ?? { state: 'active' as const, enqueued_at: now }),
          state: 'active',
          activation_source: 'manual',
          activated_at: st.queue?.activated_at ?? now
        }
      }))
      await this.appendQueueEvent(workspaceKey, taskId, 'queue.activated', {
        activation_source: 'manual',
        enqueued_at: state.queue?.enqueued_at ?? now
      })
      try {
        await this.runner.startTask(taskId, { workspace_key: workspaceKey })
      } catch {
        // Runner sets PAUSED/FAILED; reconcile will block, which is correct.
      }
    }
  }

  /** Called after a task transitions to DONE/PAUSED/FAILED to advance the workspace queue. */
  onTaskTerminal(workspaceKey: string): Promise<void> {
    return this.reconcile(workspaceKey)
  }

  private async recordBlocked(
    workspaceKey: string,
    entry: { task: Task; state: TaskState },
    blocker: { task_id: string; reason: string }
  ): Promise<void> {
    const signature: BlockSignature = {
      workspace_key: workspaceKey,
      head_task_id: entry.task.task_id,
      blocked_task_id: blocker.task_id,
      reason: blocker.reason
    }
    // Dedupe: only emit a new queue.blocked when the blocked signature actually changes.
    if (sameSignature(this.lastSignature.get(workspaceKey), signature)) {
      return
    }
    this.lastSignature.set(workspaceKey, signature)
    await this.appendQueueEvent(workspaceKey, entry.task.task_id, 'queue.blocked', {
      reason: blocker.reason,
      blocked_task_id: blocker.task_id,
      enqueued_at: entry.state.queue?.enqueued_at
    })
  }

  private async appendQueueEvent(
    workspaceKey: string,
    taskId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    // Attach to the task's event log so it flows through redaction and the renderer event view.
    const event = await this.store.appendTaskEvent(taskId, workspaceKey, {
      type,
      payload: { workspace_key: workspaceKey, task_id: taskId, ...payload }
    })
    this.events?.publish({ workspace_key: workspaceKey, task_id: taskId, event })
  }
}

/** Effective execution mode. Legacy tasks without the field default to immediate. */
function effectiveMode(state: TaskState): 'immediate' | 'queued' {
  return state.execution_mode ?? 'immediate'
}

/**
 * Whether a task in a given state blocks the queue's auto-advancement.
 *
 * Two cases differ by execution_mode:
 * - Explicit immediate (state.execution_mode === 'immediate'): any non-DONE state blocks,
 *   matching the contract that an incomplete immediate task prevents queued advancement.
 * - Legacy tasks (state.execution_mode === undefined, pre-queue feature): only actively-running
 *   states block. A leftover READY/PAUSED/FAILED legacy task must NOT permanently block new
 *   queued tasks, since the user never opted that task into the queue discipline.
 *
 * Explicit queued tasks are handled by the hasActiveQueued branch, not this helper.
 */
function blocksQueue(state: TaskState): boolean {
  if (state.execution_mode === undefined) {
    return isActivelyRunning(state.status)
  }
  return state.status !== 'DONE'
}

/** States where a task is genuinely executing or mid-round, and so genuinely holds the queue. */
function isActivelyRunning(status: TaskState['status']): boolean {
  return (
    status === 'PINGING' ||
    status === 'RUNNING_CLAUDE' ||
    status === 'RUNNING_CODEX' ||
    status === 'RUNNING_CURSOR' ||
    status === 'RUNNING_OPENCODE' ||
    status === 'RUNNING_KIMI' ||
    status === 'COUNTDOWN'
  )
}

function sameSignature(a: BlockSignature | undefined, b: BlockSignature): boolean {
  if (!a) return false
  return (
    a.workspace_key === b.workspace_key &&
    a.head_task_id === b.head_task_id &&
    a.blocked_task_id === b.blocked_task_id &&
    a.reason === b.reason
  )
}

/**
 * Stable ordering for queued tasks: enqueued_at, then created_at, then task_id.
 * Lower comes first.
 */
function compareQueueOrder(
  aState: TaskState,
  aTask: { task_id: string },
  bState: TaskState,
  bTask: { task_id: string }
): number {
  const aEnq = aState.queue?.enqueued_at ?? aState.created_at ?? ''
  const bEnq = bState.queue?.enqueued_at ?? bState.created_at ?? ''
  if (aEnq !== bEnq) return aEnq < bEnq ? -1 : 1
  const aCreated = aState.created_at ?? ''
  const bCreated = bState.created_at ?? ''
  if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1
  if (aTask.task_id !== bTask.task_id) return aTask.task_id < bTask.task_id ? -1 : 1
  return 0
}
