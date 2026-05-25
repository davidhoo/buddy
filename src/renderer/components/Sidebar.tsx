import { Task } from '../../shared/types'

interface SidebarProps {
  isOpen: boolean
  tasks: Task[]
  selectedTaskId: string | null
  onSelectTask: (taskId: string, workspaceKey: string) => void
  onCreateTask: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  isOpen,
  tasks,
  selectedTaskId,
  onSelectTask,
  onCreateTask,
  onOpenSettings
}: SidebarProps) {
  if (!isOpen) return null

  const groupedTasks = tasks.reduce<Record<string, Task[]>>((acc, task) => {
    const key = task.workspace_key || 'default'
    if (!acc[key]) acc[key] = []
    acc[key].push(task)
    return acc
  }, {})

  return (
    <div className="w-60 bg-house-green text-white flex flex-col h-full">
      <div className="px-4 pt-4 pb-2">
        <div className="text-xl font-bold">buddy</div>
        <div className="text-xs text-white/70">Coding Agent 协作台</div>
      </div>

      <div className="px-4 py-2">
        <button
          onClick={onCreateTask}
          className="w-full px-4 py-2 bg-accent-green text-white rounded-lg hover:bg-brand-green transition-colors"
        >
          新建任务
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {Object.entries(groupedTasks).map(([workspaceKey, workspaceTasks]) => (
          <div key={workspaceKey} className="mb-4">
            <div className="px-2 py-1 text-xs text-white/50 font-medium">
              {workspaceKey}
            </div>
            {workspaceTasks.map((task) => (
              <button
                key={task.task_id}
                onClick={() => onSelectTask(task.task_id, task.workspace_key)}
                className={`w-full text-left px-3 py-2 rounded-lg mb-1 transition-colors ${
                  selectedTaskId === task.task_id
                    ? 'bg-white/20'
                    : 'hover:bg-white/10'
                }`}
              >
                <div className="text-sm font-medium truncate">{task.task_id}</div>
                <div className="text-xs text-white/50">
                  {formatStatus(task.status)}
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-white/10">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          设置
        </button>
      </div>
    </div>
  )
}

function formatStatus(status: string): string {
  const statusMap: Record<string, string> = {
    READY: '就绪',
    RUNNING_CLAUDE: 'Claude 运行中',
    RUNNING_CODEX: 'Codex 运行中',
    RUNNING_OPENCODE: 'OpenCode 运行中',
    RUNNING_KIMI: 'Kimi 运行中',
    COUNTDOWN: '倒计时中',
    PAUSED: '已暂停',
    FAILED: '失败',
    DONE: '已完成'
  }
  return statusMap[status] || status
}
