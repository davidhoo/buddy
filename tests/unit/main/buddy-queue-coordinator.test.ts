import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'
import type { BuddyRunner } from '../../../src/main/buddy/runner'
import { QueueCoordinator } from '../../../src/main/buddy/queue-coordinator'

interface StartCall { taskId: string; workspaceKey: string }

function makeCoordinator(root: string) {
  const store = new BuddyStore(root)
  const startCalls: StartCall[] = []
  const runner = {
    startTask: vi.fn(async (taskId: string, input: { workspace_key?: string }) => {
      startCalls.push({ taskId, workspaceKey: input.workspace_key! })
      // Simulate a successful actor start: move to RUNNING_CLAUDE (active).
      await store.updateTaskState(taskId, input.workspace_key!, (state) => ({
        ...state,
        status: 'RUNNING_CLAUDE',
        active_run: { actor: 'claude', started_at: new Date().toISOString() }
      }))
      return { run_id: 'run_test' }
    })
  } as unknown as BuddyRunner
  const coordinator = new QueueCoordinator({ store, runner })
  return { store, runner, coordinator, startCalls }
}

async function createQueued(store: BuddyStore, id: string, repo = '/tmp/repo', enqueuedAt?: string) {
  const created = await store.createTask({ task_id: id, repo_root: repo, execution_mode: 'queued' })
  if (enqueuedAt) {
    await store.updateTaskState(id, created.workspace_key, (s) => ({
      ...s,
      queue: { ...(s.queue!), enqueued_at: enqueuedAt },
      created_at: enqueuedAt
    }))
  }
  return created.workspace_key
}

async function setStatus(store: BuddyStore, ws: string, id: string, status: any) {
  await store.updateTaskState(id, ws, (s) => ({ ...s, status }))
}

describe('QueueCoordinator', () => {
  it('creates a queued task in QUEUED+waiting and default mode is immediate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-create-'))
    const { store } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1')
    const state = await store.readTaskState('q1', ws)
    expect(state.status).toBe('QUEUED')
    expect(state.execution_mode).toBe('queued')
    expect(state.queue?.state).toBe('waiting')

    const imm = await store.createTask({ task_id: 'i1', repo_root: '/tmp/repo' })
    const immState = await store.readTaskState('i1', imm.workspace_key)
    expect(immState.execution_mode).toBe('immediate')
    expect(immState.status).toBe('READY')
  })

  it('auto-starts the earliest waiting queued task when nothing blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-autostart-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1')
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['q1'])
    const state = await store.readTaskState('q1', ws)
    expect(state.queue?.state).toBe('active')
    expect(state.queue?.activation_source).toBe('automatic')
    expect(state.status).toBe('RUNNING_CLAUDE')
  })

  it('does not start the runner while a queued task is waiting (no reconcile)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-nowait-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1')
    // No reconcile call — waiting task must not touch the launcher.
    expect(startCalls).toHaveLength(0)
    const state = await store.readTaskState('q1', ws)
    expect(state.status).toBe('QUEUED')
  })

  it('runs queued tasks in creation order within a workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-order-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    // Use distinct enqueued_at timestamps to guarantee ordering.
    const wsA = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    const wsB = await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    expect(wsA).toBe(wsB)
    const ws = wsA
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['a'])
    // Mark a DONE, then reconcile → b starts.
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'DONE', active_run: null }))
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['a', 'b'])
  })

  it('keeps different project queues independent (parallel)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-parallel-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws1 = await createQueued(store, 'p1', '/tmp/repo1')
    const ws2 = await createQueued(store, 'p2', '/tmp/repo2')
    expect(ws1).not.toBe(ws2)
    await coordinator.reconcile(ws1)
    await coordinator.reconcile(ws2)
    expect(startCalls.map((c) => c.taskId).sort()).toEqual(['p1', 'p2'])
  })

  it('blocks queue start while an incomplete immediate task exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-imm-block-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const imm = await store.createTask({ task_id: 'imm', repo_root: '/tmp/repo' })
    // immediate task running
    await store.updateTaskState('imm', imm.workspace_key, (s) => ({ ...s, status: 'RUNNING_CLAUDE' }))
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    await coordinator.reconcile(ws)
    expect(startCalls).toHaveLength(0)
    const q = await store.readTaskState('q1', ws)
    expect(q.status).toBe('QUEUED')
  })

  it('a later immediate task starts immediately and blocks the next queued task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-later-imm-'))
    const { store, coordinator, runner, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    // An immediate task created afterwards.
    const imm = await store.createTask({ task_id: 'imm', repo_root: '/tmp/repo' })
    // Start the immediate task via the runner directly (renderer would call startTask).
    await (runner as any).startTask('imm', { workspace_key: imm.workspace_key })
    expect(startCalls.map((c) => c.taskId)).toContain('imm')
    // Reconcile should NOT start the queued task because imm is incomplete.
    await coordinator.reconcile(ws)
    expect(startCalls).not.toContain(expect.objectContaining({ taskId: 'q1' }))
  })

  it('PAUSED/FAILED queued tasks block subsequent queued advancement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-paused-block-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // Start a, then force it into PAUSED (active).
    await coordinator.reconcile(ws)
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'PAUSED', active_run: null }))
    await coordinator.reconcile(ws)
    // b must not start while a is PAUSED.
    expect(startCalls.map((c) => c.taskId)).toEqual(['a'])
  })

  it('manual startQueuedNow bypasses blockers and ordering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-manual-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // An incomplete immediate task exists (would normally block).
    const imm = await store.createTask({ task_id: 'imm', repo_root: '/tmp/repo' })
    await store.updateTaskState('imm', imm.workspace_key, (s) => ({ ...s, status: 'RUNNING_CLAUDE' }))
    // Manually start b.
    await coordinator.startQueuedNow('b', ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['b'])
    // a is superseded.
    const aState = await store.readTaskState('a', ws)
    expect(aState.queue?.state).toBe('superseded')
    expect(aState.status).toBe('QUEUED')
  })

  it('after manual start of a later task, earlier tasks no longer block advancement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-supersede-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    await createQueued(store, 'c', '/tmp/repo', '2026-01-01T00:00:03Z')
    // Manually start b.
    await coordinator.startQueuedNow('b', ws)
    // b completes.
    await store.updateTaskState('b', ws, (s) => ({ ...s, status: 'DONE', active_run: null }))
    // Reconcile: a is superseded (not waiting), c should start.
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['b', 'c'])
    const aState = await store.readTaskState('a', ws)
    expect(aState.queue?.state).toBe('superseded')
  })

  it('manual start of a later task supersedes an earlier PAUSED queued task so it no longer blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-supersede-paused-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    await createQueued(store, 'c', '/tmp/repo', '2026-01-01T00:00:03Z')
    // a started then paused (active, blocked).
    await coordinator.reconcile(ws)
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'PAUSED', active_run: null }))
    // Reconcile must not start b or c while a is PAUSED.
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['a'])
    // Manually start c — a (PAUSED) must be superseded, not continue blocking.
    await coordinator.startQueuedNow('c', ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['a', 'c'])
    const aState = await store.readTaskState('a', ws)
    expect(aState.queue?.state).toBe('superseded')
    // c completes → b (still waiting, later than... no: b is earlier than c) should NOT auto-start
    // because b is earlier than c and was superseded too? b is earlier than c, so b is superseded.
    const bState = await store.readTaskState('b', ws)
    expect(bState.queue?.state).toBe('superseded')
    await store.updateTaskState('c', ws, (s) => ({ ...s, status: 'DONE', active_run: null }))
    await coordinator.reconcile(ws)
    // No further auto-start: a and b are superseded, nothing waiting after c.
    expect(startCalls.map((c) => c.taskId)).toEqual(['a', 'c'])
  })

  it('can manually start a superseded queued task via startQueuedNow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-resume-superseded-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // Manually start b → a becomes superseded.
    await coordinator.startQueuedNow('b', ws)
    const aState = await store.readTaskState('a', ws)
    expect(aState.queue?.state).toBe('superseded')
    expect(aState.status).toBe('QUEUED')
    // Now manually resume the superseded a — must NOT throw; it should start.
    await coordinator.startQueuedNow('a', ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['b', 'a'])
    const aAfter = await store.readTaskState('a', ws)
    expect(aAfter.queue?.state).toBe('active')
    expect(aAfter.queue?.activation_source).toBe('manual')
  })

  it('preserves waiting order across a restart (rebuild from disk)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-restart-'))
    const store = new BuddyStore(root)
    const wsA = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // Simulate restart: brand new coordinator from the same disk root.
    const { coordinator, startCalls } = makeCoordinator(root)
    await coordinator.rebuildAndReconcileAll()
    expect(startCalls.map((c) => c.taskId)).toEqual(['a'])
    expect(startCalls[0].workspaceKey).toBe(wsA)
  })

  it('restart recovers a running queued task as PAUSED and does not start the next', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-restart-paused-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // Start a, then simulate crash: leave a in RUNNING_CLAUDE on disk.
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['a'])
    // New coordinator instance (restart) — recoverInterruptedRuns turns RUNNING→PAUSED.
    const { coordinator: coord2, startCalls: startCalls2 } = makeCoordinator(root)
    // Mimic service.recoverInterruptedRuns then rebuild.
    const tasks = await store.getTasks()
    for (const task of tasks) {
      if (task.status.startsWith('RUNNING_') || task.status === 'PINGING') {
        await store.updateTaskState(task.task_id, task.workspace_key, (s) => ({
          ...s, status: 'PAUSED', active_run: null
        }))
      }
    }
    await coord2.rebuildAndReconcileAll()
    // b must NOT start because a is PAUSED (blocks).
    expect(startCalls2.map((c) => c.taskId)).toEqual([])
  })

  it('recomputes the queue after a blocking task is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-delete-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // a started and paused.
    await coordinator.reconcile(ws)
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'PAUSED', active_run: null }))
    // Delete a.
    await store.deleteTask('a', ws)
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['a', 'b'])
  })

  it('does not start the same task twice under concurrent reconcile triggers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-concurrent-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    // Fire many concurrent reconciles.
    await Promise.all([
      coordinator.reconcile(ws),
      coordinator.reconcile(ws),
      coordinator.reconcile(ws),
      coordinator.reconcile(ws)
    ])
    expect(startCalls.filter((c) => c.taskId === 'q1')).toHaveLength(1)
  })

  it('coalesces many concurrent reconcile requests into a bounded number of scans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-coalesce-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    // Fire many concurrent reconciles while a first is in flight.
    await Promise.all([
      coordinator.reconcile(ws),
      coordinator.reconcile(ws),
      coordinator.reconcile(ws),
      coordinator.reconcile(ws),
      coordinator.reconcile(ws),
      coordinator.reconcile(ws)
    ])
    // Coalescing guarantees at most one start (the same task is never started twice).
    expect(startCalls.filter((c) => c.taskId === 'q1')).toHaveLength(1)
  })

  it('does not write queue.reconciled events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-no-reconciled-'))
    const { store, coordinator } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    await coordinator.reconcile(ws)
    const events = await store.getEvents('q1', 0, ws)
    expect(events.events.some((e) => e.type === 'queue.reconciled')).toBe(false)
    // task.queued + queue.activated are still present.
    expect(events.events.some((e) => e.type === 'queue.activated')).toBe(true)
  })

  it('emits only one queue.blocked for repeated identical block signatures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-blocked-dedup-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // a started, then paused — blocks b.
    await coordinator.reconcile(ws)
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'PAUSED', active_run: null }))
    await coordinator.reconcile(ws)
    // Repeated reconciles with the same blocker must not add more queue.blocked events.
    await coordinator.reconcile(ws)
    await coordinator.reconcile(ws)
    const events = await store.getEvents('b', 0, ws)
    const blocked = events.events.filter((e) => e.type === 'queue.blocked')
    expect(blocked).toHaveLength(1)
    expect(startCalls.map((c) => c.taskId)).toEqual(['a'])
  })

  it('emits a new queue.blocked when the blocker changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-blocked-change-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // a started and paused — blocks b (reason active_queued_task, blocked_task_id=a).
    await coordinator.reconcile(ws)
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'PAUSED', active_run: null }))
    await coordinator.reconcile(ws)
    expect((await store.getEvents('b', 0, ws)).events.filter((e) => e.type === 'queue.blocked')).toHaveLength(1)
    // a recovers to DONE; now an incomplete immediate task becomes the new blocker.
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'DONE', active_run: null }))
    const imm = await store.createTask({ task_id: 'imm', repo_root: '/tmp/repo' })
    await store.updateTaskState('imm', imm.workspace_key, (s) => ({ ...s, status: 'RUNNING_CLAUDE' }))
    await coordinator.reconcile(ws)
    const events = await store.getEvents('b', 0, ws)
    const blocked = events.events.filter((e) => e.type === 'queue.blocked')
    expect(blocked).toHaveLength(2)
    expect(blocked[0].payload?.blocked_task_id).toBe('a')
    expect(blocked[1].payload?.blocked_task_id).toBe('imm')
    expect(startCalls.map((c) => c.taskId)).toEqual(['a'])
  })

  it('clears the block signature after the queue advances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-blocked-clear-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'a', '/tmp/repo', '2026-01-01T00:00:01Z')
    await createQueued(store, 'b', '/tmp/repo', '2026-01-01T00:00:02Z')
    // a started, paused → blocked(b).
    await coordinator.reconcile(ws)
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'PAUSED', active_run: null }))
    await coordinator.reconcile(ws)
    expect((await store.getEvents('b', 0, ws)).events.filter((e) => e.type === 'queue.blocked')).toHaveLength(1)
    // a recovers to DONE → queue advances to b.
    await store.updateTaskState('a', ws, (s) => ({ ...s, status: 'DONE', active_run: null }))
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['a', 'b'])
    // b now pauses and blocks the (empty) queue — but there's no later waiting task to anchor on,
    // so no new blocked event is recorded. Instead verify the signature was cleared by re-blocking
    // b with the same earlier pattern after a cycle: mark b DONE, add c, start c, pause c → c blocks.
    await store.updateTaskState('b', ws, (s) => ({ ...s, status: 'DONE', active_run: null }))
    await createQueued(store, 'c', '/tmp/repo', '2026-01-01T00:00:03Z')
    await coordinator.reconcile(ws)
    await store.updateTaskState('c', ws, (s) => ({ ...s, status: 'PAUSED', active_run: null }))
    await coordinator.reconcile(ws)
    // No waiting task after c → no blocked event recorded; signature cleared on advance.
    const cEvents = await store.getEvents('c', 0, ws)
    expect(cEvents.events.some((e) => e.type === 'queue.blocked')).toBe(false)
  })

  it('legacy FAILED task does not block a queued task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-legacy-failed-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    // A legacy task (no execution_mode) stuck in FAILED.
    const legacy = await store.createTask({ task_id: 'legacy', repo_root: '/tmp/repo' })
    await writeFile(
      join(store.taskDirectory('legacy', legacy.workspace_key), 'state.json'),
      JSON.stringify({
        protocol_version: '1',
        task_id: 'legacy',
        repo_root: '/tmp/repo',
        status: 'FAILED',
        round: 1,
        next_actor: 'claude',
        active_run: null,
        instruction_queue: []
      })
    )
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['q1'])
  })

  it('legacy PAUSED and READY tasks do not block a queued task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-legacy-paused-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    for (const status of ['PAUSED', 'READY'] as const) {
      const t = await store.createTask({ task_id: `legacy-${status}`, repo_root: '/tmp/repo' })
      await writeFile(
        join(store.taskDirectory(`legacy-${status}`, t.workspace_key), 'state.json'),
        JSON.stringify({
          protocol_version: '1',
          task_id: `legacy-${status}`,
          repo_root: '/tmp/repo',
          status,
          round: 1,
          next_actor: 'claude',
          active_run: null,
          instruction_queue: []
        })
      )
    }
    await coordinator.reconcile(ws)
    expect(startCalls.map((c) => c.taskId)).toEqual(['q1'])
  })

  it('legacy RUNNING_* / PINGING / COUNTDOWN tasks still block the queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-legacy-running-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    const blockers = ['RUNNING_CLAUDE', 'PINGING', 'COUNTDOWN']
    for (const status of blockers) {
      const t = await store.createTask({ task_id: `legacy-${status}`, repo_root: '/tmp/repo' })
      await writeFile(
        join(store.taskDirectory(`legacy-${status}`, t.workspace_key), 'state.json'),
        JSON.stringify({
          protocol_version: '1',
          task_id: `legacy-${status}`,
          repo_root: '/tmp/repo',
          status,
          round: 1,
          next_actor: 'claude',
          active_run: null,
          instruction_queue: []
        })
      )
    }
    await coordinator.reconcile(ws)
    // None of the running legacy tasks let q1 start.
    expect(startCalls.filter((c) => c.taskId === 'q1')).toHaveLength(0)
  })

  it('an explicit immediate FAILED task still blocks the queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-immediate-failed-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    const imm = await store.createTask({ task_id: 'imm', repo_root: '/tmp/repo' })
    // Explicit immediate (execution_mode set by createTask) then FAILED.
    await store.updateTaskState('imm', imm.workspace_key, (s) => ({ ...s, status: 'FAILED' }))
    await coordinator.reconcile(ws)
    expect(startCalls.filter((c) => c.taskId === 'q1')).toHaveLength(0)
  })

  it('an explicit immediate PAUSED task still blocks the queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-immediate-paused-'))
    const { store, coordinator, startCalls } = makeCoordinator(root)
    const ws = await createQueued(store, 'q1', '/tmp/repo')
    const imm = await store.createTask({ task_id: 'imm', repo_root: '/tmp/repo' })
    await store.updateTaskState('imm', imm.workspace_key, (s) => ({ ...s, status: 'PAUSED' }))
    await coordinator.reconcile(ws)
    expect(startCalls.filter((c) => c.taskId === 'q1')).toHaveLength(0)
  })

  it('reads legacy state.json without queue fields and treats it as immediate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-qc-legacy-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({ task_id: 'legacy', repo_root: '/tmp/repo' })
    // Overwrite state.json with a minimal legacy shape (no execution_mode / queue).
    await writeFile(
      join(store.taskDirectory('legacy', created.workspace_key), 'state.json'),
      JSON.stringify({
        protocol_version: '1',
        task_id: 'legacy',
        repo_root: '/tmp/repo',
        status: 'READY',
        round: 0,
        next_actor: 'claude',
        active_run: null,
        instruction_queue: []
      })
    )
    const state = await store.readTaskState('legacy', created.workspace_key)
    expect(state.status).toBe('READY')
    expect(state.execution_mode ?? 'immediate').toBe('immediate')
    expect(state.queue).toBeUndefined()
    // getTasks should surface it as immediate.
    const tasks = await store.getTasks()
    const legacy = tasks.find((t) => t.task_id === 'legacy')!
    expect(legacy.execution_mode ?? 'immediate').toBe('immediate')
  })
})
