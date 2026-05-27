import { describe, expect, it } from 'vitest'
import { visibleTasksForShortcuts } from '../../../src/renderer/lib/taskList'
import type { Task } from '../../../src/shared/types'

function task(taskId: string, repoRoot: string, updatedAt: string): Task {
  return {
    task_id: taskId,
    workspace_key: `${taskId}-workspace`,
    status: 'READY',
    updated_at: updatedAt,
    repo_root: repoRoot,
    round: 1,
    active_run: null
  }
}

describe('visibleTasksForShortcuts', () => {
  it('matches the sidebar order for pinned and expanded project tasks', () => {
    const tasks = [
      task('older', '/tmp/repo-a', '2026-05-26T09:00:00.000Z'),
      task('newer', '/tmp/repo-a', '2026-05-26T10:00:00.000Z'),
      task('pinned', '/tmp/repo-b', '2026-05-26T08:00:00.000Z')
    ]

    const visible = visibleTasksForShortcuts(tasks, {}, ['pinned'], [])

    expect(visible.map(t => t.task_id)).toEqual(['pinned', 'newer', 'older'])
  })

  it('omits tasks in collapsed projects while keeping pinned tasks visible', () => {
    const tasks = [
      task('hidden', '/tmp/repo-a', '2026-05-26T10:00:00.000Z'),
      task('pinned', '/tmp/repo-a', '2026-05-26T09:00:00.000Z'),
      task('shown', '/tmp/repo-b', '2026-05-26T08:00:00.000Z')
    ]

    const visible = visibleTasksForShortcuts(tasks, {}, ['pinned'], ['repo-a'])

    expect(visible.map(t => t.task_id)).toEqual(['pinned', 'shown'])
  })
})
