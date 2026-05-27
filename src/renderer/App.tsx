import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { FolderOpen } from 'lucide-react'
import { useHealthCheck, useBootstrap, useTasks, useTaskDetail, useCreateTask, useSendMessage, useStartTask, useSkipCountdown, usePauseCountdown, useInterrupt, useDeleteTask } from './hooks/useBuddy'
import { useTheme } from './hooks/useTheme'
import { useT } from './hooks/useI18n'
import type { TFunction } from './hooks/useI18n'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import type { ShortcutActions } from './hooks/useKeyboardShortcuts'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { StatusBar } from './components/StatusBar'
import { SettingsContent, SettingsTab } from './components/SettingsContent'
import { ACTOR_LABEL_KEY, Actor } from './lib/format'
import { isTaskReadyToStart } from './lib/taskState'
import { readStringArraySetting, visibleTasksForShortcuts } from './lib/taskList'
import type { GlobalSettings } from '../shared/types'
import { defaultLauncherFor, normalizeGlobalSettings } from '../shared/defaults'

export default function App() {
  const t = useT()
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
  const [autoStartSeconds, setAutoStartSeconds] = useState(0)
  const autoStartTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoSkipCountdownRef = useRef<string | null>(null)
  const [isFullScreen, setIsFullScreen] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [projectNames, setProjectNames] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('buddy.projectNames') || '{}')
    } catch { return {} }
  })

  useTheme()

  useEffect(() => {
    window.api.isFullScreen().then(setIsFullScreen).catch(() => {})
    const cleanup = window.api.onFullScreenChange(setIsFullScreen)
    return cleanup
  }, [])

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

  const currentDraft = selectedTaskId ? (drafts[selectedTaskId] ?? '') : ''

  const handleDraftChange = useCallback((value: string) => {
    if (!selectedTaskId) return
    setDrafts(prev => ({ ...prev, [selectedTaskId]: value }))
  }, [selectedTaskId])

  const handleSelectTask = useCallback((taskId: string, workspaceKey: string) => {
    setSelectedTaskId(taskId)
    setSelectedWorkspaceKey(workspaceKey)
  }, [])

  const handleDeleteTask = useCallback(async (taskId: string, workspaceKey: string) => {
    try {
      await deleteTask.mutateAsync({ taskId, workspaceKey })
      setDrafts(prev => { const { [taskId]: _, ...rest } = prev; return rest })
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null)
        setSelectedWorkspaceKey(null)
      }
    } catch (error) {
      console.error('Failed to delete task:', error)
      window.alert(t('sidebar.deleteFail', { message: error instanceof Error ? error.message : String(error) }))
    }
  }, [deleteTask, selectedTaskId, t])

  const handleRenameProject = useCallback((repoRoot: string, newName: string) => {
    setProjectNames(prev => {
      const next = { ...prev, [repoRoot]: newName }
      try { localStorage.setItem('buddy.projectNames', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const handleOpenInFinder = useCallback((path: string) => {
    window.api.openInFinder(path).catch((err: unknown) => {
      console.error('Failed to open in Finder:', err)
    })
  }, [])

  const handleRemoveProject = useCallback(async (repoRoot: string) => {
    const projectTasks = tasks.filter(t => t.repo_root === repoRoot)
    for (const task of projectTasks) {
      try {
        await deleteTask.mutateAsync({ taskId: task.task_id, workspaceKey: task.workspace_key })
      } catch (error) {
        console.error('Failed to delete task:', task.task_id, error)
      }
    }
    if (projectTasks.some(t => t.task_id === selectedTaskId)) {
      setSelectedTaskId(null)
      setSelectedWorkspaceKey(null)
    }
  }, [tasks, deleteTask, selectedTaskId])

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
      // Auto-start: 5s countdown if task has real text
      const hasRealText = taskText.trim().length > 0
      if (hasRealText) {
        setAutoStartSeconds(5)
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      // Extract structured backend error details when available.
      const apiMsg = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail || msg
      window.alert(t('modal.create.failed', { message: apiMsg }))
    }
  }, [bootstrap, createTask, t])

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
    setDrafts(prev => ({ ...prev, [selectedTaskId]: '' }))
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
    // Cancel auto-start if interrupting
    if (autoStartTimerRef.current) {
      clearInterval(autoStartTimerRef.current)
      autoStartTimerRef.current = null
      setAutoStartSeconds(0)
    }
    interrupt.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey ?? undefined
    })
  }, [selectedTaskId, selectedWorkspaceKey, interrupt])

  const selectVisibleTaskByOffset = useCallback((offset: number) => {
    const visibleTasks = visibleTasksForShortcuts(
      tasks,
      projectNames,
      readStringArraySetting('buddy.pinnedTaskIds'),
      readStringArraySetting('buddy.collapsedProjectKeys')
    )
    if (visibleTasks.length === 0) return
    const currentIndex = visibleTasks.findIndex(task => task.task_id === selectedTaskId)
    const baseIndex = currentIndex >= 0 ? currentIndex : 0
    const nextIndex = Math.max(0, Math.min(visibleTasks.length - 1, baseIndex + offset))
    const next = visibleTasks[nextIndex]
    if (next) handleSelectTask(next.task_id, next.workspace_key)
  }, [handleSelectTask, projectNames, selectedTaskId, tasks])

  const selectVisibleTaskBySlot = useCallback((slot: number) => {
    const visibleTasks = visibleTasksForShortcuts(
      tasks,
      projectNames,
      readStringArraySetting('buddy.pinnedTaskIds'),
      readStringArraySetting('buddy.collapsedProjectKeys')
    )
    const next = visibleTasks[slot - 1]
    if (next) handleSelectTask(next.task_id, next.workspace_key)
  }, [handleSelectTask, projectNames, tasks])

  const shortcutActions: ShortcutActions = useMemo(() => ({
    onNewTask: () => handleOpenCreateModal(),
    onOpenSettings: () => { setView('settings'); setSettingsTab('general') },
    onToggleSidebar: () => setIsSidebarOpen(prev => !prev),
    onToggleStatusBar: () => setIsStatusBarOpen(prev => !prev),
    onSelectTaskByIndex: (index: number) => selectVisibleTaskBySlot(index + 1),
    onNextTask: () => selectVisibleTaskByOffset(1),
    onPrevTask: () => selectVisibleTaskByOffset(-1),
    onInterrupt: handleInterrupt,
    onEscape: () => {
      if (showCreateModal) {
        setShowCreateModal(false)
        setPendingRepoRoot(null)
      } else if (view === 'settings') {
        setView('chat')
      }
    },
    onShowShortcuts: () => { setView('settings'); setSettingsTab('keyboard') },
  }), [handleOpenCreateModal, handleInterrupt, selectVisibleTaskByOffset, selectVisibleTaskBySlot, showCreateModal, view])

  useKeyboardShortcuts(shortcutActions)

  // Auto-start countdown: when autoStartSeconds > 0 and task is READY, start timer
  useEffect(() => {
    if (autoStartSeconds <= 0 || !selectedTaskId) return
    const isReady = isTaskReadyToStart(taskDetail?.state)
    if (!isReady) {
      // Task not ready yet, wait for next poll
      return
    }
    if (autoStartTimerRef.current) return
    autoStartTimerRef.current = setInterval(() => {
      setAutoStartSeconds(prev => {
        if (prev <= 1) {
          if (autoStartTimerRef.current) {
            clearInterval(autoStartTimerRef.current)
            autoStartTimerRef.current = null
          }
          // Auto-start now
          startTask.mutate({
            taskId: selectedTaskId,
            data: { workspace_key: selectedWorkspaceKey ?? undefined }
          })
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => {
      if (autoStartTimerRef.current) {
        clearInterval(autoStartTimerRef.current)
        autoStartTimerRef.current = null
      }
    }
  }, [autoStartSeconds, selectedTaskId, selectedWorkspaceKey, taskDetail?.state?.status, startTask])

  // Cancel auto-start if task is no longer READY (e.g. already started by other means)
  useEffect(() => {
    if (autoStartSeconds > 0 && taskDetail?.state?.status && taskDetail.state.status !== 'READY') {
      if (autoStartTimerRef.current) {
        clearInterval(autoStartTimerRef.current)
        autoStartTimerRef.current = null
      }
      setAutoStartSeconds(0)
    }
  }, [autoStartSeconds, taskDetail?.state?.status])

  // Auto-skip countdown when its deadline elapses so the next actor runs without manual click
  useEffect(() => {
    if (!selectedTaskId) return
    const status = taskDetail?.state?.status
    const countdown = taskDetail?.state?.countdown
    if (status !== 'COUNTDOWN' || countdown?.status !== 'running' || !countdown.deadline) return

    const countdownKey = `${selectedWorkspaceKey ?? ''}:${selectedTaskId}:${countdown.deadline}`
    const remainingMs = Math.max(0, new Date(countdown.deadline).getTime() - Date.now())
    const timer = setTimeout(() => {
      if (autoSkipCountdownRef.current === countdownKey) return
      autoSkipCountdownRef.current = countdownKey
      skipCountdown.mutate({
        taskId: selectedTaskId,
        data: { workspace_key: selectedWorkspaceKey ?? undefined }
      })
    }, remainingMs)

    return () => clearTimeout(timer)
  }, [
    selectedTaskId,
    selectedWorkspaceKey,
    taskDetail?.state?.status,
    taskDetail?.state?.countdown?.status,
    taskDetail?.state?.countdown?.deadline,
    skipCountdown
  ])

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
        isFullScreen={isFullScreen}
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
        onRenameProject={handleRenameProject}
        onOpenInFinder={handleOpenInFinder}
        onRemoveProject={handleRemoveProject}
        projectNames={projectNames}
      />

      {/* 右侧主区 */}
      <div className="flex-1 flex flex-col min-w-0 border-l border-border rounded-tl-xl rounded-bl-xl bg-bg-elevated overflow-hidden">
        {/* 标题栏 */}
        <TitleBar
          taskName={taskDetail?.task_id ?? ''}
          taskStatus={taskDetail?.state?.status ?? null}
          isSidebarOpen={isSidebarOpen}
          isStatusBarOpen={isStatusBarOpen}
          isFullScreen={isFullScreen}
          showToggles={view !== 'settings'}
          bare={view === 'settings'}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
          onToggleStatusBar={() => setIsStatusBarOpen(!isStatusBarOpen)}
          onRetry={() => handleStartTask()}
          onResume={() => handleStartTask()}
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
                autoStartSeconds={autoStartSeconds}
                draft={currentDraft}
                onDraftChange={handleDraftChange}
              />

              {/* 右侧状态栏 */}
              <StatusBar
                isOpen={isStatusBarOpen}
                width={statusBarWidth}
                taskState={taskDetail?.state ?? null}
                taskSettings={taskDetail?.settings ?? null}
                events={taskDetail?.events ?? []}
                latestFailure={taskDetail?.latest_failure ?? null}
                onSkipCountdown={handleSkipCountdown}
                onPauseCountdown={handlePauseCountdown}
                onInterrupt={handleInterrupt}
                onRetry={() => handleStartTask()}
                onResume={() => handleStartTask()}
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
          t={t}
        />
      )}
    </div>
  )
}

function CreateTaskModal({
  onClose,
  onCreate,
  defaultRepoRoot,
  globalSettings,
  t
}: {
  onClose: () => void
  onCreate: (taskId: string, taskText: string, repoRoot: string, settings: Record<string, unknown>) => void
  defaultRepoRoot: string
  globalSettings: GlobalSettings | null
  t: TFunction
}) {
  const [taskId, setTaskId] = useState('')
  const [repoRoot, setRepoRoot] = useState(defaultRepoRoot)
  const [taskText, setTaskText] = useState(() => t('modal.create.taskBriefDefault'))
  const [implementer, setImplementer] = useState<Actor>(() => {
    try { return (localStorage.getItem('buddy.lastImplementer') as Actor) || 'claude' } catch { return 'claude' }
  })
  const [reviewer, setReviewer] = useState<Actor>(() => {
    try { return (localStorage.getItem('buddy.lastReviewer') as Actor) || 'codex' } catch { return 'codex' }
  })
  const [implementerSession, setImplementerSession] = useState('')
  const [reviewerSession, setReviewerSession] = useState('')
  const normalizedGlobalSettings = normalizeGlobalSettings(globalSettings)

  const TASK_NAME_RE = /^[a-zA-Z0-9一-鿿㐀-䶿""「」【】{}][a-zA-Z0-9一-鿿㐀-䶿 ._\-""「」【】{}]{0,63}$/
  const taskIdError = taskId.trim() && !TASK_NAME_RE.test(taskId.trim())
    ? t('modal.create.taskNameError')
    : null
  const sameActorError = implementer === reviewer
  const canSubmit = taskId.trim() && !taskIdError && !sameActorError

  const seedFor = (actor: Actor, session: string): Record<string, string> => {
    const value = session.trim()
    if (!value) return {}
    if (actor === 'codex') return { seed_codex_thread_id: value }
    return { [`seed_${actor}_session_id`]: value }
  }

  const handleSubmit = () => {
    if (!canSubmit) return
    try {
      localStorage.setItem('buddy.lastImplementer', implementer)
      localStorage.setItem('buddy.lastReviewer', reviewer)
    } catch {}
    const launchers = normalizedGlobalSettings.launchers ?? {}
    const launcherFor = (actor: Actor) => ({
      command: launchers[actor]?.command ?? defaultLauncherFor(actor).command,
      env: { ...(launchers[actor]?.env ?? {}) },
      timeout_seconds: launchers[actor]?.timeout_seconds ?? defaultLauncherFor(actor).timeout_seconds
    })
    const settings: Record<string, unknown> = {
      protocol_version: normalizedGlobalSettings.protocol_version ?? '1',
      flow_policy: 'claude_then_codex',
      role_mode: implementer === 'codex' ? 'codex_implements' : 'claude_implements',
      implementer_actor: implementer,
      reviewer_actor: reviewer,
      max_consecutive_failures: normalizedGlobalSettings.max_consecutive_failures ?? 3,
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
            <h2 className="text-sm font-semibold">{t('modal.create.title')}</h2>
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
            <label className="block text-xs font-medium text-fg-secondary mb-1">
              {t('modal.create.taskName')} <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder={t('modal.create.taskNamePlaceholder')}
              className={`w-full px-3 py-1.5 text-xs border rounded-lg focus:outline-none focus:ring-1 bg-bg ${taskIdError ? 'border-danger focus:border-danger focus:ring-danger' : 'border-border focus:border-accent focus:ring-accent'}`}
            />
            <div className="flex justify-between mt-1">
              <span className="text-xs text-fg-muted">{t('modal.create.taskNameHint')}</span>
              <span className="text-xs text-fg-muted">{taskId.trim().length}/64</span>
            </div>
            {taskIdError && (
              <div className="text-xs text-danger mt-1">{taskIdError}</div>
            )}
          </div>

          {/* 任务说明 */}
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1">
              {t('modal.create.taskBrief')}
            </label>
            <textarea
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              rows={10}
              className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent font-mono text-xs bg-bg"
            />
          </div>

          {/* 工作目录 */}
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1">
              {t('modal.create.repoRoot')}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={repoRoot}
                onChange={(e) => setRepoRoot(e.target.value)}
                placeholder={defaultRepoRoot}
                className="flex-1 px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-xs"
              />
              <button
                type="button"
                onClick={handleSelectDirectory}
                title={t('modal.create.repoRootSelect')}
                className="px-3 py-1.5 border border-border rounded-lg hover:bg-bg-subtle text-xs flex items-center gap-1.5 shrink-0"
              >
                <FolderOpen size={14} strokeWidth={1.75} />
                {t('common.select')}
              </button>
            </div>
          </div>

          {/* 执行者 / 审查者 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-fg-secondary mb-1">{t('modal.create.implementer')}</label>
              <select
                value={implementer}
                onChange={(e) => setImplementer(e.target.value as Actor)}
                className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-xs"
              >
                {actorOptions.map(a => (
                  <option key={a} value={a}>{t(ACTOR_LABEL_KEY[a])}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-secondary mb-1">{t('modal.create.reviewer')}</label>
              <select
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value as Actor)}
                className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-xs"
              >
                {actorOptions.map(a => (
                  <option key={a} value={a}>{t(ACTOR_LABEL_KEY[a])}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 会话 ID */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-fg-secondary mb-1">{t('modal.create.implementerSession')}</label>
              <input
                type="text"
                value={implementerSession}
                onChange={(e) => setImplementerSession(e.target.value)}
                placeholder={t('modal.create.sessionPlaceholder')}
                className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-secondary mb-1">{t('modal.create.reviewerSession')}</label>
              <input
                type="text"
                value={reviewerSession}
                onChange={(e) => setReviewerSession(e.target.value)}
                placeholder={t('modal.create.sessionPlaceholder')}
                className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-xs"
              />
            </div>
          </div>

          {sameActorError && (
            <div className="text-xs text-danger">{t('modal.create.sameActorError')}</div>
          )}
        </div>

        {/* 底部 */}
        <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs text-fg hover:bg-bg-subtle rounded-lg transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-xs bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('modal.create.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
