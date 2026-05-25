import { useState, useCallback } from 'react'
import { useBootstrap, useTasks, useTaskDetail, useCreateTask, useSendMessage, useStartTask, useSkipCountdown, usePauseCountdown, useInterrupt } from './hooks/useBuddy'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { StatusBar } from './components/StatusBar'

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isStatusBarOpen, setIsStatusBarOpen] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)

  const { data: bootstrap } = useBootstrap()
  const { data: tasks = [] } = useTasks()
  const { data: taskDetail } = useTaskDetail(selectedTaskId, selectedWorkspaceKey ?? undefined)

  const createTask = useCreateTask()
  const sendMessage = useSendMessage()
  const startTask = useStartTask()
  const skipCountdown = useSkipCountdown()
  const pauseCountdown = usePauseCountdown()
  const interrupt = useInterrupt()

  const handleSelectTask = useCallback((taskId: string, workspaceKey: string) => {
    setSelectedTaskId(taskId)
    setSelectedWorkspaceKey(workspaceKey)
  }, [])

  const handleCreateTask = useCallback(async (taskId: string, taskText: string) => {
    try {
      const result = await createTask.mutateAsync({
        task_id: taskId,
        repo_root: bootstrap?.repo_root,
        task_text: taskText
      })
      setSelectedTaskId(result.task)
      setSelectedWorkspaceKey(result.workspace_key)
      setShowCreateModal(false)
    } catch (error) {
      console.error('Failed to create task:', error)
    }
  }, [bootstrap, createTask])

  const handleSendMessage = useCallback((message: string) => {
    if (!selectedTaskId) return
    sendMessage.mutate({
      taskId: selectedTaskId,
      data: {
        message,
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, sendMessage])

  const handleStartTask = useCallback(() => {
    if (!selectedTaskId) return
    startTask.mutate({
      taskId: selectedTaskId,
      data: {
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, startTask])

  const handleSkipCountdown = useCallback(() => {
    if (!selectedTaskId) return
    skipCountdown.mutate({
      taskId: selectedTaskId,
      data: {
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, skipCountdown])

  const handlePauseCountdown = useCallback(() => {
    if (!selectedTaskId) return
    pauseCountdown.mutate({
      taskId: selectedTaskId,
      data: {
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, pauseCountdown])

  const handleInterrupt = useCallback(() => {
    if (!selectedTaskId) return
    interrupt.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey ?? undefined
    })
  }, [selectedTaskId, selectedWorkspaceKey, interrupt])

  return (
    <div className="h-screen flex flex-col">
      {/* 标题栏 */}
      <TitleBar
        taskName={taskDetail?.task_id ?? ''}
        isSidebarOpen={isSidebarOpen}
        isStatusBarOpen={isStatusBarOpen}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        onToggleStatusBar={() => setIsStatusBarOpen(!isStatusBarOpen)}
      />

      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧栏 */}
        <Sidebar
          isOpen={isSidebarOpen}
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onSelectTask={handleSelectTask}
          onCreateTask={() => setShowCreateModal(true)}
          onOpenSettings={() => {/* TODO */}}
        />

        {/* 中间对话区域 */}
        <ChatArea
          task={taskDetail ?? null}
          onSendMessage={handleSendMessage}
          onStartTask={handleStartTask}
        />

        {/* 右侧状态栏 */}
        <StatusBar
          isOpen={isStatusBarOpen}
          taskState={taskDetail?.state ?? null}
          taskSettings={taskDetail?.settings ?? null}
          onSkipCountdown={handleSkipCountdown}
          onPauseCountdown={handlePauseCountdown}
          onInterrupt={handleInterrupt}
        />
      </div>

      {/* 创建任务模态框 */}
      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateTask}
          defaultRepoRoot={bootstrap?.repo_root ?? ''}
        />
      )}
    </div>
  )
}

function CreateTaskModal({
  onClose,
  onCreate,
  defaultRepoRoot
}: {
  onClose: () => void
  onCreate: (taskId: string, taskText: string) => void
  defaultRepoRoot: string
}) {
  const [taskId, setTaskId] = useState('')
  const [taskText, setTaskText] = useState('# 目标\n\n描述要完成的任务。\n\n# 背景与约束\n\n项目背景、约束等。\n\n# 验收标准\n- ')

  const handleSubmit = () => {
    if (taskId.trim()) {
      onCreate(taskId.trim(), taskText)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-[600px] max-h-[80vh] flex flex-col">
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">新建任务</h2>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100"
            >
              ×
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* 任务名 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              任务名称 <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder="输入任务名称"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-accent-green focus:ring-1 focus:ring-accent-green"
            />
          </div>

          {/* 工作目录 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              工作目录
            </label>
            <input
              type="text"
              value={defaultRepoRoot}
              disabled
              className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-500"
            />
          </div>

          {/* 任务说明 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              任务说明
            </label>
            <textarea
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              rows={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-accent-green focus:ring-1 focus:ring-accent-green font-mono text-sm"
            />
          </div>
        </div>

        {/* 底部 */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!taskId.trim()}
            className="px-4 py-2 text-sm bg-accent-green text-white rounded-lg hover:bg-brand-green transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            创建任务
          </button>
        </div>
      </div>
    </div>
  )
}
