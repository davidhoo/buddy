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

// --- Task display names ---

type TaskNames = Record<string, string> // taskId → custom display name

export function readTaskNames(): TaskNames {
  try {
    if (typeof window === 'undefined') return {}
    const parsed = JSON.parse(window.localStorage?.getItem('buddy.taskNames') || '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch { return {} }
}

export function writeTaskNames(names: TaskNames) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage?.setItem('buddy.taskNames', JSON.stringify(names))
  } catch {}
}

export function displayNameForTask(task: Task, taskNames?: TaskNames): string {
  if (taskNames?.[task.task_id]) return taskNames[task.task_id]
  return task.task_id
}

// --- Unread state ---

type TaskReadState = Record<string, string> // taskId → ISO timestamp of last read

function readTaskReadState(): TaskReadState {
  try {
    if (typeof window === 'undefined') return {}
    const parsed = JSON.parse(window.localStorage?.getItem('buddy.taskReadState') || '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch { return {} }
}

function writeTaskReadState(state: TaskReadState) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage?.setItem('buddy.taskReadState', JSON.stringify(state))
  } catch {}
}

export function markTaskAsRead(taskId: string) {
  const state = readTaskReadState()
  state[taskId] = new Date().toISOString()
  writeTaskReadState(state)
}

export function isTaskUnread(task: Task, selectedTaskId: string | null): boolean {
  if (task.task_id === selectedTaskId) return false
  if (task.status === 'DONE' || task.status === 'CANCELLED') return false
  const state = readTaskReadState()
  const lastRead = state[task.task_id]
  if (!lastRead) return true
  const updatedAt = task.updated_at
  if (!updatedAt) return false
  return updatedAt > lastRead
}

// --- Last selected task ---

export function readLastSelectedTask(): { taskId: string; workspaceKey: string } | null {
  try {
    if (typeof window === 'undefined') return null
    const saved = window.localStorage?.getItem('buddy.lastSelectedTask')
    if (saved) {
      const parsed = JSON.parse(saved)
      if (parsed.taskId) return { taskId: parsed.taskId, workspaceKey: parsed.workspaceKey || null }
    }
  } catch {}
  return null
}

export function saveLastSelectedTask(taskId: string, workspaceKey: string) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage?.setItem('buddy.lastSelectedTask', JSON.stringify({ taskId, workspaceKey }))
  } catch {}
}

export function clearLastSelectedTask() {
  try {
    if (typeof window === 'undefined') return
    window.localStorage?.removeItem('buddy.lastSelectedTask')
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
