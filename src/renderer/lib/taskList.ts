import type { Task } from '../../shared/types'

export function readStringArraySetting(key: string): string[] {
  try {
    if (typeof window === 'undefined') return []
    const parsed = JSON.parse(window.localStorage?.getItem(key) || '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch { return [] }
}

export function writeStringArraySetting(key: string, value: string[]) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage?.setItem(key, JSON.stringify(value))
  } catch {}
}

export function projectNameForTask(task: Task, projectNames?: Record<string, string>): string {
  if (task.repo_root && projectNames?.[task.repo_root]) {
    return projectNames[task.repo_root]
  }
  if (task.repo_root) {
    const basename = task.repo_root.replace(/\/+$/, '').split('/').pop()
    if (basename) return basename
  }
  const key = task.workspace_key || 'default'
  return key.replace(/-[a-f0-9]{8,}$/i, '')
}

export function visibleTasksForShortcuts(
  tasks: Task[],
  projectNames: Record<string, string>,
  pinnedTaskIds: string[],
  collapsedProjectKeys: string[]
): Task[] {
  const validPinnedIds = pinnedTaskIds.filter(id => tasks.some(t => t.task_id === id))
  const pinnedTasks = validPinnedIds
    .map(id => tasks.find(t => t.task_id === id)!)
    .filter(Boolean)
  const unpinnedTasks = tasks.filter(t => !validPinnedIds.includes(t.task_id))

  const groupedTasks = unpinnedTasks.reduce<Record<string, Task[]>>((acc, task) => {
    const key = projectNameForTask(task, projectNames)
    if (!acc[key]) acc[key] = []
    acc[key].push(task)
    return acc
  }, {})

  Object.values(groupedTasks).forEach(list => {
    list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  })

  const visibleProjectTasks = Object.entries(groupedTasks).flatMap(([projectKey, workspaceTasks]) => {
    return collapsedProjectKeys.includes(projectKey) ? [] : workspaceTasks
  })

  return [...pinnedTasks, ...visibleProjectTasks]
}
