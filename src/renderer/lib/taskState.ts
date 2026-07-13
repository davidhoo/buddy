import type { Task, TaskState } from '../../shared/types'

export function isTaskReadyToStart(state: TaskState | null | undefined): boolean {
  return state?.status === 'READY'
}

export function isTaskQueued(state: TaskState | null | undefined): boolean {
  return state?.status === 'QUEUED'
}

/** 1-based position of a waiting queued task within its workspace FIFO list. */
export function queuedPosition(task: Task | null | undefined, allTasks: Task[]): number {
  if (!task || task.execution_mode !== 'queued') return 0
  const sameWorkspace = allTasks.filter(
    (t) => t.workspace_key === task.workspace_key && t.execution_mode === 'queued'
  )
  // Waiting tasks ordered by enqueued_at → created_at → task_id.
  const waiting = sameWorkspace
    .filter((t) => t.status === 'QUEUED')
    .sort((a, b) => {
      const aEnq = a.queue?.enqueued_at ?? a.created_at ?? ''
      const bEnq = b.queue?.enqueued_at ?? b.created_at ?? ''
      if (aEnq !== bEnq) return aEnq < bEnq ? -1 : 1
      const aC = a.created_at ?? ''
      const bC = b.created_at ?? ''
      if (aC !== bC) return aC < bC ? -1 : 1
      return a.task_id < b.task_id ? -1 : 1
    })
  const idx = waiting.findIndex((t) => t.task_id === task.task_id)
  return idx >= 0 ? idx + 1 : 0
}
