import { useState, useCallback } from 'react'
import { useHealthCheck, useBootstrap, useTasks, useTaskDetail, useCreateTask, useSendMessage, useStartTask, useSkipCountdown, usePauseCountdown, useInterrupt, useDeleteTask } from './hooks/useBuddy'
import { useTheme } from './hooks/useTheme'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { StatusBar } from './components/StatusBar'
import { SettingsContent, SettingsTab } from './components/SettingsContent'
import { ACTOR_TEXT, Actor } from './lib/format'
import type { GlobalSettings } from '../shared/types'

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isStatusBarOpen, setIsStatusBarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [statusBarWidth, setStatusBarWidth] = useState(280)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [pendingRepoRoot, setPendingRepoRoot] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')

  useTheme()

  const { data: isHealthy, isLoading: isCheckingHealth, error: healthError } = useHealthCheck()
  const { data: bootstrap, isLoading: isLoadingBootstrap, error: bootstrapError } = useBootstrap()
  const { data: tasks = [], isLoading: isLoadingTasks, error: tasksError } = useTasks()
  const { data: taskDetail } = useTaskDetail(selectedTaskId, selectedWorkspaceKey ?? undefined)

  const createTask = useCreateTask()
  const deleteTask = useDeleteTask()
  const sendMessage = useSendMessage()
  const startTask = useStartTask()
  const skipCountdown = useSkipCountdown()
  const pauseCountdown = usePauseCountdown()
  const interrupt = useInterrupt()

  const handleSelectTask = useCallback((taskId: string, workspaceKey: string) => {
    setSelectedTaskId(taskId)
    setSelectedWorkspaceKey(workspaceKey)
  }, [])

  const handleDeleteTask = useCallback(async (taskId: string, workspaceKey: string) => {
    try {
      await deleteTask.mutateAsync({ taskId, workspaceKey })
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null)
        setSelectedWorkspaceKey(null)
      }
    } catch (error) {
      console.error('Failed to delete task:', error)
      window.alert('删除失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }, [deleteTask, selectedTaskId])

  const handleCreateTask = useCallback(async (
    taskId: string,
    taskText: string,
    repoRoot: string,
    settings: Record<string, unknown>
  ) => {
    try {
      const finalRepoRoot = repoRoot || bootstrap?.repo_root || ''
      const result = await createTask.mutateAsync({
        task_id: taskId,
        repo_root: finalRepoRoot || undefined,
        task_text: taskText,
        settings
      })
      if (finalRepoRoot) {
        try { localStorage.setItem('buddy.lastRepoRoot', finalRepoRoot) } catch {}
      }
      setSelectedTaskId(result.task)
      setSelectedWorkspaceKey(result.workspace_key)
      setShowCreateModal(false)
      setPendingRepoRoot(null)
    } catch (error) {
      console.error('Failed to create task:', error)
    }
  }, [bootstrap, createTask])

  const handleOpenCreateModal = useCallback((repoRoot?: string) => {
    setPendingRepoRoot(repoRoot ?? null)
    setShowCreateModal(true)
  }, [])

  const modalDefaultRepoRoot = (() => {
    if (pendingRepoRoot) return pendingRepoRoot
    try {
      const last = localStorage.getItem('buddy.lastRepoRoot')
      if (last) return last
    } catch {}
    return bootstrap?.repo_root ?? ''
  })()

  const handleSendMessage = useCallback((message: string, actor?: string) => {
    if (!selectedTaskId) return
    sendMessage.mutate({
      taskId: selectedTaskId,
      data: {
        message,
        actor,
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, sendMessage])

  const handleStartTask = useCallback((actor?: string) => {
    if (!selectedTaskId) return
    startTask.mutate({
      taskId: selectedTaskId,
      data: {
        actor,
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

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth(prev => {
      const next = prev + delta
      // 拖过阈值（140px）→ 自动隐藏，并把记忆宽度重置为合适默认值
      if (next < 140) {
        setIsSidebarOpen(false)
        return 240
      }
      return Math.min(400, next)
    })
  }, [])

  const handleStatusBarResize = useCallback((delta: number) => {
    setStatusBarWidth(prev => Math.max(200, Math.min(400, prev + delta)))
  }, [])

  return (
    <div className="h-screen flex">
      {/* 左侧栏（通顶通底） */}
      <Sidebar
        isOpen={isSidebarOpen}
        width={sidebarWidth}
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        isLoading={isLoadingTasks}
        error={tasksError}
        isHealthy={isHealthy ?? false}
        view={view}
        settingsTab={settingsTab}
        onSelectTask={handleSelectTask}
        onCreateTask={handleOpenCreateModal}
        onDeleteTask={handleDeleteTask}
        onOpenSettings={() => { setView('settings'); setSettingsTab('general') }}
        onBackToApp={() => setView('chat')}
        onSelectSettingsTab={setSettingsTab}
        onResize={handleSidebarResize}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
      />

      {/* 右侧主区 */}
      <div className="flex-1 flex flex-col min-w-0 border-l border-border rounded-tl-xl rounded-bl-xl bg-bg-elevated overflow-hidden">
        {/* 标题栏 */}
        <TitleBar
          taskName={taskDetail?.task_id ?? ''}
          isSidebarOpen={isSidebarOpen}
          isStatusBarOpen={isStatusBarOpen}
          showToggles={view !== 'settings'}
          bare={view === 'settings'}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          onToggleStatusBar={() => setIsStatusBarOpen(!isStatusBarOpen)}
        />

        {/* 主内容区 */}
        <div className="flex-1 flex overflow-hidden">
          {view === 'settings' ? (
            <SettingsContent
              tab={settingsTab}
              globalSettings={bootstrap?.global_settings ?? null}
            />
          ) : (
            <>
              {/* 中间对话区域 */}
              <ChatArea
                task={taskDetail ?? null}
                onSendMessage={handleSendMessage}
                onStartTask={handleStartTask}
                onInterrupt={handleInterrupt}
              />

              {/* 右侧状态栏 */}
              <StatusBar
                isOpen={isStatusBarOpen}
                width={statusBarWidth}
                taskState={taskDetail?.state ?? null}
                taskSettings={taskDetail?.settings ?? null}
                events={taskDetail?.events ?? []}
                onSkipCountdown={handleSkipCountdown}
                onPauseCountdown={handlePauseCountdown}
                onInterrupt={handleInterrupt}
                onResize={handleStatusBarResize}
              />
            </>
          )}
        </div>
      </div>

      {/* 创建任务模态框 */}
      {showCreateModal && (
        <CreateTaskModal
          onClose={() => { setShowCreateModal(false); setPendingRepoRoot(null) }}
          onCreate={handleCreateTask}
          defaultRepoRoot={modalDefaultRepoRoot}
          globalSettings={bootstrap?.global_settings ?? null}
        />
      )}
    </div>
  )
}

function CreateTaskModal({
  onClose,
  onCreate,
  defaultRepoRoot,
  globalSettings
}: {
  onClose: () => void
  onCreate: (taskId: string, taskText: string, repoRoot: string, settings: Record<string, unknown>) => void
  defaultRepoRoot: string
  globalSettings: GlobalSettings | null
}) {
  const [taskId, setTaskId] = useState('')
  const [repoRoot, setRepoRoot] = useState(defaultRepoRoot)
  const [taskText, setTaskText] = useState('# 目标\n\n描述要完成的任务。\n\n# 背景与约束\n\n项目背景、约束等。\n\n# 验收标准\n- ')
  const [implementer, setImplementer] = useState<Actor>('claude')
  const [reviewer, setReviewer] = useState<Actor>('codex')
  const [implementerSession, setImplementerSession] = useState('')
  const [reviewerSession, setReviewerSession] = useState('')
  const [maxRounds, setMaxRounds] = useState<number>(globalSettings?.max_rounds ?? 10)
  const [countdownSeconds, setCountdownSeconds] = useState<number>(globalSettings?.countdown_seconds ?? 30)

  const sameActorError = implementer === reviewer
  const canSubmit = taskId.trim() && !sameActorError

  const seedFor = (actor: Actor, session: string): Record<string, string> => {
    const value = session.trim()
    if (!value) return {}
    if (actor === 'codex') return { seed_codex_thread_id: value }
    return { [`seed_${actor}_session_id`]: value }
  }

  const handleSubmit = () => {
    if (!canSubmit) return
    const launchers = globalSettings?.launchers ?? {}
    const launcherFor = (actor: Actor) => ({
      command: launchers[actor]?.command ?? '',
      env: {},
      timeout_seconds: 7200
    })
    const settings: Record<string, unknown> = {
      protocol_version: globalSettings?.protocol_version ?? '1',
      countdown_seconds: countdownSeconds,
      flow_policy: 'claude_then_codex',
      role_mode: implementer === 'codex' ? 'codex_implements' : 'claude_implements',
      implementer_actor: implementer,
      reviewer_actor: reviewer,
      max_rounds: maxRounds,
      max_consecutive_failures: globalSettings?.max_consecutive_failures ?? 3,
      launchers: {
        claude: launcherFor('claude'),
        codex: launcherFor('codex'),
        opencode: launcherFor('opencode'),
        kimi: launcherFor('kimi')
      },
      ...seedFor(implementer, implementerSession),
      ...seedFor(reviewer, reviewerSession)
    }
    onCreate(taskId.trim(), taskText, repoRoot.trim(), settings)
  }

  const handleSelectDirectory = async () => {
    try {
      const path = await window.api.selectDirectory(repoRoot || defaultRepoRoot)
      if (path) setRepoRoot(path)
    } catch (error) {
      console.error('Failed to select directory:', error)
    }
  }

  const actorOptions: Actor[] = ['claude', 'codex', 'opencode', 'kimi']

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-elevated rounded-xl shadow-xl w-[760px] max-h-[85vh] flex flex-col">
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-border">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">新建任务</h2>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-bg-subtle"
            >
              ×
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* 任务名 */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              任务名称 <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder="输入任务名称"
              className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg"
            />
          </div>

          {/* 工作目录 */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              工作目录
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={repoRoot}
                onChange={(e) => setRepoRoot(e.target.value)}
                placeholder={defaultRepoRoot}
                className="flex-1 px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-sm"
              />
              <button
                type="button"
                onClick={handleSelectDirectory}
                title="选择目录"
                className="px-3 py-2 border border-border rounded-lg hover:bg-bg-subtle text-sm flex items-center gap-1.5 shrink-0"
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-7.5z" />
                </svg>
                选择
              </button>
            </div>
          </div>

          {/* 自动轮次 / 倒计时 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-fg mb-1">自动轮次</label>
              <input
                type="number"
                min={1}
                max={50}
                value={maxRounds}
                onChange={(e) => setMaxRounds(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-fg mb-1">倒计时（秒）</label>
              <input
                type="number"
                min={0}
                max={600}
                value={countdownSeconds}
                onChange={(e) => setCountdownSeconds(Math.max(0, Math.min(600, Number(e.target.value) || 0)))}
                className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-sm"
              />
            </div>
          </div>

          {/* 执行方 / Reviewer */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-fg mb-1">执行方</label>
              <select
                value={implementer}
                onChange={(e) => setImplementer(e.target.value as Actor)}
                className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-sm"
              >
                {actorOptions.map(a => (
                  <option key={a} value={a}>{ACTOR_TEXT[a] || a}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-fg mb-1">Reviewer</label>
              <select
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value as Actor)}
                className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-sm"
              >
                {actorOptions.map(a => (
                  <option key={a} value={a}>{ACTOR_TEXT[a] || a}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 会话 ID */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-fg mb-1">执行方会话 ID</label>
              <input
                type="text"
                value={implementerSession}
                onChange={(e) => setImplementerSession(e.target.value)}
                placeholder="留空则新建"
                className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-fg mb-1">Reviewer会话 ID</label>
              <input
                type="text"
                value={reviewerSession}
                onChange={(e) => setReviewerSession(e.target.value)}
                placeholder="留空则新建"
                className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-sm"
              />
            </div>
          </div>

          {sameActorError && (
            <div className="text-xs text-danger">执行方和 Reviewer 不能是同一个角色。</div>
          )}

          {/* 任务说明 */}
          <div>
            <label className="block text-sm font-medium text-fg mb-1">
              任务说明
            </label>
            <textarea
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              rows={10}
              className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent font-mono text-sm bg-bg"
            />
          </div>
        </div>

        {/* 底部 */}
        <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-fg hover:bg-bg-subtle rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm bg-accent text-fg-inverse rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            创建任务
          </button>
        </div>
      </div>
    </div>
  )
}
