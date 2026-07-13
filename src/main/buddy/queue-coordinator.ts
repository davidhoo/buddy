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
 *  1. No incomplete immediate-execution task in the workspace.
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
 * Each workspace has a serial reconcile lock so concurrent reconcile triggers never start the
 * same task twice.
 */

type ActivationSource = 'automatic' | 'manual'

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
  /** Per-workspace serial reconcile locks. A pending chain means a reconcile is in flight. */
  private readonly locks = new Map<string, Promise<void>>()

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
   * guarantees the same waiting task is started at most once.
   */
  reconcile(workspaceKey: string): Promise<void> {
    const previous = this.locks.get(workspaceKey) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.reconcileInner(workspaceKey))
    this.locks.set(workspaceKey, next)
    // Clean up the lock entry once settled so it doesn't retain rejected chains.
    next.finally(() => {
      if (this.locks.get(workspaceKey) === next) {
        this.locks.delete(workspaceKey)
      }
    })
    return next
  }

  private async reconcileInner(workspaceKey: string): Promise<void> {
    const tasks = await this.store.getTasks()
    const workspaceTasks = tasks.filter((t) => t.workspace_key === workspaceKey)
    if (workspaceTasks.length === 0) return

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
      (entry) => effectiveMode(entry.state) === 'immediate' && entry.state.status !== 'DONE'
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
      // Record a blocked event with the blocker id when a waiting task exists but can't start.
      const blocker = this.findBlocker(states, hasIncompleteImmediate, hasActiveQueued)
      const earliestWaiting = this.earliestWaiting(queuedEntries)
      if (earliestWaiting && blocker) {
        await this.recordBlocked(workspaceKey, earliestWaiting, blocker)
      }
      await this.emitReconciled(workspaceKey, states, 'blocked')
      return
    }

    // 3) Pick the earliest waiting queued task.
    const candidate = this.earliestWaiting(queuedEntries)
    if (!candidate) {
      await this.emitReconciled(workspaceKey, states, 'idle')
      return
    }

    await this.activateAndStart(workspaceKey, candidate, 'automatic')
    await this.emitReconciled(workspaceKey, states, 'activated')
  }

  /** Emit a queue.reconciled event summarizing the workspace queue state for observability. */
  private async emitReconciled(
    workspaceKey: string,
    states: Array<{ task: Task; state: TaskState }>,
    outcome: 'blocked' | 'idle' | 'activated'
  ): Promise<void> {
    const waiting = states
      .filter((e) => effectiveMode(e.state) === 'queued' && e.state.queue?.state === 'waiting')
      .sort((a, b) => compareQueueOrder(a.state, a.task, b.state, b.task))
    const head = waiting[0]
    // queue.* events attach to a task's event log, so we need a task id to anchor them. When
    // there is no waiting task to anchor on, attach to the first non-DONE queued task in the
    // workspace (or skip if the workspace has no queued tasks at all).
    const anchorTaskId = head?.task.task_id
      ?? states.find((e) => effectiveMode(e.state) === 'queued')?.task.task_id
    if (!anchorTaskId) return
    await this.appendQueueEvent(workspaceKey, anchorTaskId, 'queue.reconciled', {
      outcome,
      waiting_count: waiting.length,
      head_task_id: head?.task.task_id ?? null,
      head_enqueued_at: head?.state.queue?.enqueued_at ?? null
    })
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
        (e) => effectiveMode(e.state) === 'immediate' && e.state.status !== 'DONE'
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

/** Effective execution mode, defaulting to immediate for legacy tasks without the field. */
function effectiveMode(state: TaskState): 'immediate' | 'queued' {
  return state.execution_mode ?? 'immediate'
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
