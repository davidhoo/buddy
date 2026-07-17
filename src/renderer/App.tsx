import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { FolderOpen, GitBranch, X, Image as ImageIcon, File as FileIcon } from 'lucide-react'
import { useHealthCheck, useBootstrap, useTasks, useTaskDetail, useCreateTask, useSendMessage, useStartTask, useInterrupt, useDeleteTask, useEnqueueInstruction, useDequeueInstruction, useClearInstructionQueue, useInterruptAndInsert, useGitStatus } from './hooks/useBuddy'
import { useTheme } from './hooks/useTheme'
import { useT, useLanguage } from './hooks/useI18n'
import { setServerLocale } from './lib/i18n'
import type { TFunction } from './hooks/useI18n'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import type { ShortcutActions } from './hooks/useKeyboardShortcuts'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/ChatArea'
import { StatusBar } from './components/StatusBar'
import { SettingsContent, SettingsTab } from './components/SettingsContent'
import { UpdateNotification } from './components/UpdateNotification'
import { useUpdater } from './hooks/useUpdater'
import { ACTOR_LABEL_KEY, actorDisplayName, Actor } from './lib/format'
import { isTaskReadyToStart, isTaskQueued, queuedPosition } from './lib/taskState'
import type { Task } from '../shared/types'
import { readStringArraySetting, visibleTasksForShortcuts, markTaskAsRead, readLastSelectedTask, saveLastSelectedTask, clearLastSelectedTask, readTaskNames, writeTaskNames } from './lib/taskList'
import type { GlobalSettings, InstructionQueueItem, Attachment, AttachmentMeta } from '../shared/types'
import { IMAGE_EXTS, MIME_MAP, EXT_ICON_MAP, isImageAttachment, generateAttachmentId, ensureMimeType } from './lib/attachments'
import { normalizeGlobalSettings } from '../shared/defaults'

export default function App() {
  const t = useT()
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isStatusBarOpen, setIsStatusBarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [statusBarWidth, setStatusBarWidth] = useState(280)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => readLastSelectedTask()?.taskId ?? null)
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string | null>(() => readLastSelectedTask()?.workspaceKey ?? null)
  // Track just-created task to prevent auto-select from overriding its selection
  const justCreatedTaskId = useRef<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [pendingRepoRoot, setPendingRepoRoot] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [isFullScreen, setIsFullScreen] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [taskAttachments, setTaskAttachments] = useState<Record<string, Attachment[]>>({})
  const [projectNames, setProjectNames] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('buddy.projectNames') || '{}')
    } catch { return {} }
  })
  const [taskNames, setTaskNames] = useState<Record<string, string>>(() => readTaskNames())

  useTheme()
  const updater = useUpdater()

  useEffect(() => {
    window.api.isFullScreen().then(setIsFullScreen).catch(() => {})
    const cleanup = window.api.onFullScreenChange(setIsFullScreen)
    return cleanup
  }, [])

  // Sync language to main process for menu i18n
  const language = useLanguage()
  useEffect(() => {
    window.api.updateMenuLanguage(language)
  }, [language])

  const { data: isHealthy, isLoading: isCheckingHealth, error: healthError } = useHealthCheck()
  const { data: bootstrap, isLoading: isLoadingBootstrap, error: bootstrapError } = useBootstrap()
  const { data: tasks = [], isLoading: isLoadingTasks, error: tasksError } = useTasks()
  const { data: taskDetail } = useTaskDetail(selectedTaskId, selectedWorkspaceKey ?? undefined)

  // Feed main-process locale to renderer language detection as fallback
  useEffect(() => {
    if (bootstrap?.locale) setServerLocale(bootstrap.locale)
  }, [bootstrap?.locale])

  // Clean up stale localStorage values from previous bugs
  useEffect(() => {
    try {
      const last = localStorage.getItem('buddy.lastRepoRoot')
      if (last === '[object Object]' || (last && typeof last !== 'string')) {
        localStorage.removeItem('buddy.lastRepoRoot')
      }
    } catch {}
  }, [])

  // Auto-select: restore last selection or default to first task
  useEffect(() => {
    if (isLoadingTasks || tasks.length === 0) return
    // If current selection still exists in tasks, keep it
    if (selectedTaskId && tasks.some(t => t.task_id === selectedTaskId)) {
      // Clear the ref once the just-created task appears in the list
      if (justCreatedTaskId.current === selectedTaskId) {
        justCreatedTaskId.current = null
      }
      return
    }
    // Skip auto-select if we just created a task that hasn't appeared in the list yet
    if (justCreatedTaskId.current) return
    // Otherwise auto-select the first (most recently updated) task
    const firstTask = tasks[0]
    setSelectedTaskId(firstTask.task_id)
    setSelectedWorkspaceKey(firstTask.workspace_key)
    markTaskAsRead(firstTask.task_id)
    saveLastSelectedTask(firstTask.task_id, firstTask.workspace_key)
  }, [tasks, isLoadingTasks, selectedTaskId])

  // Keep selected task's read state in sync while viewing
  // (handles updated_at bumps from backend during DONE transition, etc.)
  useEffect(() => {
    if (!selectedTaskId) return
    const selectedTask = tasks.find(t => t.task_id === selectedTaskId)
    if (selectedTask) markTaskAsRead(selectedTaskId)
  }, [tasks, selectedTaskId])

  const createTask = useCreateTask()
  const deleteTask = useDeleteTask()
  const sendMessage = useSendMessage()
  const startTask = useStartTask()
  const interrupt = useInterrupt()
  const enqueueInstruction = useEnqueueInstruction()
  const dequeueInstruction = useDequeueInstruction()
  const clearInstructionQueue = useClearInstructionQueue()
  const interruptAndInsert = useInterruptAndInsert()

  const currentDraft = selectedTaskId ? (drafts[selectedTaskId] ?? '') : ''
  const currentAttachments = selectedTaskId ? (taskAttachments[selectedTaskId] ?? []) : []

  // A startTask mutation is "retrying the health check" when it is in flight, not already
  // showing PINGING, and the task was previously in a connectivity-failed state.
  const taskStatus = taskDetail?.state?.status ?? null
  const healthCheckFailed = taskStatus === 'FAILED' || !!taskDetail?.state?.health_check?.failed_actor
  const isRetryingHealthCheck = startTask.isPending && taskStatus !== 'PINGING' && healthCheckFailed

  const handleDraftChange = useCallback((value: string) => {
    if (!selectedTaskId) return
    setDrafts(prev => ({ ...prev, [selectedTaskId]: value }))
  }, [selectedTaskId])

  const handleAttachmentsChange = useCallback((attachments: Attachment[]) => {
    if (!selectedTaskId) return
    setTaskAttachments(prev => ({ ...prev, [selectedTaskId]: attachments }))
  }, [selectedTaskId])

  const handleSelectTask = useCallback((taskId: string, workspaceKey: string) => {
    setSelectedTaskId(taskId)
    setSelectedWorkspaceKey(workspaceKey)
    markTaskAsRead(taskId)
    saveLastSelectedTask(taskId, workspaceKey)
  }, [])

  const handleDeleteTask = useCallback(async (taskId: string, workspaceKey: string) => {
    try {
      await deleteTask.mutateAsync({ taskId, workspaceKey })
      setDrafts(prev => { const { [taskId]: _, ...rest } = prev; return rest })
      setTaskAttachments(prev => { const { [taskId]: _, ...rest } = prev; return rest })
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null)
        setSelectedWorkspaceKey(null)
        clearLastSelectedTask()
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

  const handleRenameTask = useCallback((taskId: string, newName: string) => {
    setTaskNames(prev => {
      const next = { ...prev, [taskId]: newName }
      writeTaskNames(next)
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
      clearLastSelectedTask()
    }
  }, [tasks, deleteTask, selectedTaskId])

  const handleCreateTask = useCallback(async (
    taskId: string,
    taskText: string,
    repoRoot: string,
    settings: Record<string, unknown>,
    attachments?: Attachment[],
    executionMode: 'immediate' | 'queued' = 'immediate'
  ) => {
    try {
      const finalRepoRoot = (repoRoot && repoRoot !== '/' && repoRoot !== '[object Object]' ? repoRoot : null)
        || (typeof bootstrap?.home_dir === 'string' ? bootstrap.home_dir : '') || ''
      const result = await createTask.mutateAsync({
        task_id: taskId,
        repo_root: finalRepoRoot || undefined,
        task_text: taskText,
        settings,
        execution_mode: executionMode
      })

      // Save attachments to the newly created task directory and update task.md
      if (attachments && attachments.length > 0) {
        const savedPaths: string[] = []
        for (const att of attachments) {
          try {
            let savedPath: string
            if (att.bufferBase64) {
              savedPath = await window.api.saveAttachmentBuffer(
                result.task,
                result.workspace_key,
                att.name,
                att.bufferBase64
              )
            } else if (att.filePath) {
              savedPath = att.filePath
            } else {
              continue
            }
            savedPaths.push(savedPath)
          } catch (err) {
            console.error('Failed to save attachment:', att.name, err)
          }
        }
        // Append attachment paths to task text
        if (savedPaths.length > 0) {
          const attachmentBlock = '\n\n[Attachments]\n' + savedPaths.map(p => `- file://${p}`).join('\n')
          try {
            await window.buddy.updateTaskText(result.task, result.workspace_key, taskText + attachmentBlock)
          } catch (err) {
            console.error('Failed to update task text with attachment paths:', err)
          }
        }
      }

      if (finalRepoRoot && finalRepoRoot !== '[object Object]') {
        try { localStorage.setItem('buddy.lastRepoRoot', finalRepoRoot) } catch {}
      }
      setSelectedTaskId(result.task)
      setSelectedWorkspaceKey(result.workspace_key)
      justCreatedTaskId.current = result.task
      markTaskAsRead(result.task)
      saveLastSelectedTask(result.task, result.workspace_key)
      setShowCreateModal(false)
      setPendingRepoRoot(null)
      // Auto-start immediately if task has real text AND was created with immediate execution.
      // Queued tasks are created as QUEUED and started by the main-process coordinator.
      const hasRealText = taskText.trim().length > 0
      if (hasRealText && executionMode === 'immediate') {
        startTask.mutate({
          taskId: result.task,
          data: { workspace_key: result.workspace_key }
        })
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      // Extract structured backend error details when available.
      const apiMsg = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail || msg
      window.alert(t('modal.create.failed', { message: apiMsg }))
    }
  }, [bootstrap, createTask, startTask, t])

  const handleOpenCreateModal = useCallback((repoRoot?: unknown) => {
    setPendingRepoRoot(typeof repoRoot === 'string' && repoRoot ? repoRoot : null)
    setShowCreateModal(true)
  }, [])

  const modalDefaultRepoRoot = (() => {
    if (typeof pendingRepoRoot === 'string' && pendingRepoRoot) return pendingRepoRoot
    // Use the currently selected task's project path as default
    if (selectedTaskId) {
      const selectedTask = tasks.find(t => t.task_id === selectedTaskId)
      if (selectedTask?.repo_root) return selectedTask.repo_root
    }
    try {
      const last = localStorage.getItem('buddy.lastRepoRoot')
      if (last && last !== '[object Object]') return last
    } catch {}
    return typeof bootstrap?.home_dir === 'string' ? bootstrap.home_dir : ''
  })()

  const handleSendMessage = useCallback(async (message: string, actor?: string, attachments?: Attachment[]) => {
    if (!selectedTaskId) return
    setDrafts(prev => ({ ...prev, [selectedTaskId]: '' }))
    setTaskAttachments(prev => ({ ...prev, [selectedTaskId]: [] }))

    let enrichedMessage = message
    const attachmentMeta: AttachmentMeta[] = []
    if (attachments && attachments.length > 0) {
      const savedPaths: string[] = []
      for (const att of attachments) {
        try {
          let savedPath: string
          if (att.bufferBase64) {
            savedPath = await window.api.saveAttachmentBuffer(
              selectedTaskId,
              selectedWorkspaceKey ?? '',
              att.name,
              att.bufferBase64
            )
          } else if (att.filePath) {
            savedPath = att.filePath
          } else {
            continue
          }
          savedPaths.push(savedPath)
          attachmentMeta.push({ path: savedPath, name: att.name, mimeType: ensureMimeType(att), size: att.size })
        } catch (err) {
          console.error('Failed to save attachment:', att.name, err)
        }
      }
      if (savedPaths.length > 0) {
        const fileList = savedPaths.map(p => `- file://${p}`).join('\n')
        enrichedMessage = message
          ? `${message}\n\n[Attachments]\n${fileList}`
          : `[Attachments]\n${fileList}`
      }
    }

    sendMessage.mutate({
      taskId: selectedTaskId,
      data: {
        message: enrichedMessage,
        actor,
        workspace_key: selectedWorkspaceKey ?? undefined,
        attachmentMeta: attachmentMeta.length > 0 ? attachmentMeta : undefined
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

  // Retry connectivity check: re-run health check without resuming an actor run.
  // The runner clears the stale failed health_check and re-pings both actors.
  const handleRetryHealthCheck = useCallback(() => {
    if (!selectedTaskId) return
    startTask.mutate({
      taskId: selectedTaskId,
      data: {
        workspace_key: selectedWorkspaceKey ?? undefined
      }
    })
  }, [selectedTaskId, selectedWorkspaceKey, startTask])

  const handleInterrupt = useCallback(() => {
    if (!selectedTaskId) return
    interrupt.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey ?? undefined
    })
  }, [selectedTaskId, selectedWorkspaceKey, interrupt])

  const handleEnqueueInstruction = useCallback(async (content: string, attachments?: Attachment[]) => {
    if (!selectedTaskId || !selectedWorkspaceKey) return
    setDrafts(prev => ({ ...prev, [selectedTaskId]: '' }))
    setTaskAttachments(prev => ({ ...prev, [selectedTaskId]: [] }))

    let enrichedContent = content
    const attachmentMeta: AttachmentMeta[] = []
    if (attachments && attachments.length > 0) {
      const savedPaths: string[] = []
      for (const att of attachments) {
        try {
          let savedPath: string
          if (att.bufferBase64) {
            savedPath = await window.api.saveAttachmentBuffer(
              selectedTaskId,
              selectedWorkspaceKey ?? '',
              att.name,
              att.bufferBase64
            )
          } else if (att.filePath) {
            savedPath = att.filePath
          } else {
            continue
          }
          savedPaths.push(savedPath)
          attachmentMeta.push({ path: savedPath, name: att.name, mimeType: ensureMimeType(att), size: att.size })
        } catch (err) {
          console.error('Failed to save attachment:', att.name, err)
        }
      }
      if (savedPaths.length > 0) {
        const fileList = savedPaths.map(p => `- file://${p}`).join('\n')
        enrichedContent = content
          ? `${content}\n\n[Attachments]\n${fileList}`
          : `[Attachments]\n${fileList}`
      }
    }

    enqueueInstruction.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey,
      content: enrichedContent,
      attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined
    })
  }, [selectedTaskId, selectedWorkspaceKey, enqueueInstruction])

  const handleDequeueInstruction = useCallback((itemId: string) => {
    if (!selectedTaskId || !selectedWorkspaceKey) return
    dequeueInstruction.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey,
      itemId
    })
  }, [selectedTaskId, selectedWorkspaceKey, dequeueInstruction])

  const handleClearInstructionQueue = useCallback(() => {
    if (!selectedTaskId || !selectedWorkspaceKey) return
    clearInstructionQueue.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey
    })
  }, [selectedTaskId, selectedWorkspaceKey, clearInstructionQueue])

  const handleInterruptAndInsert = useCallback((itemId: string) => {
    if (!selectedTaskId || !selectedWorkspaceKey) return
    interruptAndInsert.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey,
      queueItemId: itemId
    })
  }, [selectedTaskId, selectedWorkspaceKey, interruptAndInsert])

  const handleEditInstruction = useCallback(async (item: InstructionQueueItem) => {
    if (!selectedTaskId || !selectedWorkspaceKey) return
    // Strip [Attachments] block from content before putting it in draft
    const cleanedContent = item.content.replace(/\n*\[Attachments\]\n(?:- .*\n?)+/g, '').trim()
    setDrafts(prev => ({
      ...prev,
      [selectedTaskId]: prev[selectedTaskId] ? `${prev[selectedTaskId]}\n${cleanedContent}` : cleanedContent
    }))

    // Restore attachments to Composer
    if (item.attachments && item.attachments.length > 0) {
      const restored: Attachment[] = []
      for (const meta of item.attachments) {
        const resolvedMime = meta.mimeType || (MIME_MAP[meta.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream')
        const isImage = resolvedMime.startsWith('image/')
        let previewUrl: string | undefined
        if (isImage) {
          try {
            previewUrl = await window.api.readFileAsDataURL(meta.path, resolvedMime)
          } catch {
            // Fall back to no preview
          }
        }
        restored.push({
          id: generateAttachmentId(),
          name: meta.name,
          category: isImage ? 'image' : 'file',
          mimeType: resolvedMime,
          size: meta.size,
          filePath: meta.path,
          previewUrl,
        })
      }
      setTaskAttachments(prev => ({
        ...prev,
        [selectedTaskId]: [...(prev[selectedTaskId] ?? []), ...restored]
      }))
    }

    dequeueInstruction.mutate({
      taskId: selectedTaskId,
      workspaceKey: selectedWorkspaceKey,
      itemId: item.id
    })
  }, [selectedTaskId, selectedWorkspaceKey, dequeueInstruction])

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

  // Listen for native menu actions
  useEffect(() => {
    const cleanup = window.api.onMenuAction((action: string) => {
      if (action === 'newTask') {
        handleOpenCreateModal()
      } else if (action === 'openSettings') {
        setView('settings')
        setSettingsTab('general')
      } else if (action === 'prevTask') {
        selectVisibleTaskByOffset(-1)
      } else if (action === 'nextTask') {
        selectVisibleTaskByOffset(1)
      } else if (action === 'toggleSidebar') {
        setIsSidebarOpen(prev => !prev)
      } else if (action === 'toggleStatusBar') {
        setIsStatusBarOpen(prev => !prev)
      } else if (action === 'checkForUpdates') {
        updater.checkForUpdates()
      } else if (action === 'openDocumentation') {
        window.open('https://github.com/davidhoo/buddy#readme', '_blank')
      } else if (action === 'openWhatsNew') {
        window.open('https://github.com/davidhoo/buddy/releases', '_blank')
      } else if (action === 'sendFeedback') {
        window.open('https://github.com/davidhoo/buddy/issues/new', '_blank')
      } else if (action === 'showKeyboardShortcuts') {
        setView('settings')
        setSettingsTab('keyboard')
      }
    })
    return cleanup
  }, [handleOpenCreateModal, selectVisibleTaskByOffset, updater])

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
    onCommitAndPush: () => window.dispatchEvent(new CustomEvent('buddy:commit')),
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

  const hasAnyTasks = tasks.length > 0

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
        updateStatus={updater.status}
        updateVersion={updater.version}
        onUpdateClick={updater.status === 'downloaded' ? updater.installUpdate : updater.checkForUpdates}
        onSelectTask={handleSelectTask}
        onCreateTask={handleOpenCreateModal}
        onDeleteTask={handleDeleteTask}
        onOpenSettings={() => { setView('settings'); setSettingsTab('general') }}
        onBackToApp={() => setView('chat')}
        onSelectSettingsTab={setSettingsTab}
        onResize={handleSidebarResize}
        onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        onRenameProject={handleRenameProject}
        onRenameTask={handleRenameTask}
        onOpenInFinder={handleOpenInFinder}
        onRemoveProject={handleRemoveProject}
        projectNames={projectNames}
        taskNames={taskNames}
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
                hasAnyTasks={hasAnyTasks}
                onSendMessage={handleSendMessage}
                onStartTask={handleStartTask}
                onInterrupt={handleInterrupt}
                onEnqueueInstruction={handleEnqueueInstruction}
                onInterruptAndInsert={handleInterruptAndInsert}
                onDequeueInstruction={handleDequeueInstruction}
                onEditInstruction={handleEditInstruction}
                onClearInstructionQueue={handleClearInstructionQueue}
                onCreateTask={handleOpenCreateModal}
                onRetryHealthCheck={handleRetryHealthCheck}
                isRetryingHealthCheck={isRetryingHealthCheck}
                draft={currentDraft}
                onDraftChange={handleDraftChange}
                attachments={currentAttachments}
                onAttachmentsChange={handleAttachmentsChange}
              />

              {/* 右侧状态栏 */}
              <StatusBar
                isOpen={isStatusBarOpen && (selectedTaskId !== null || hasAnyTasks)}
                width={statusBarWidth}
                taskState={taskDetail?.state ?? null}
                taskSettings={taskDetail?.settings ?? null}
                events={taskDetail?.events ?? []}
                latestFailure={taskDetail?.latest_failure ?? null}
                globalSettings={bootstrap?.global_settings ?? null}
                onInterrupt={handleInterrupt}
                onRetry={() => handleStartTask()}
                onResume={() => handleStartTask()}
                onRetryHealthCheck={handleRetryHealthCheck}
                isRetryingHealthCheck={isRetryingHealthCheck}
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

      {/* Queued task — "Run now" override button */}
      {isTaskQueued(taskDetail?.state ?? null) && taskDetail && (
        <QueuedRunNowButton
          position={queuedPosition(
            {
              task_id: taskDetail.task_id,
              workspace_key: taskDetail.workspace_key,
              execution_mode: taskDetail.state.execution_mode,
              queue: taskDetail.state.queue,
              status: taskDetail.state.status,
              updated_at: taskDetail.state.updated_at ?? '',
              repo_root: taskDetail.state.repo_root ?? ''
            } as Task,
            tasks
          )}
          superseded={taskDetail.state.queue?.state === 'superseded'}
          onRunNow={() => handleStartTask()}
        />
      )}

      {/* 更新通知 */}
      <UpdateNotification
        status={updater.status}
        version={updater.version}
        progress={updater.progress}
        dismissed={updater.dismissed}
        onInstall={updater.installUpdate}
        onDismiss={updater.dismissNotification}
      />
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
  onCreate: (taskId: string, taskText: string, repoRoot: string, settings: Record<string, unknown>, attachments?: Attachment[], executionMode?: 'immediate' | 'queued') => void
  defaultRepoRoot: string
  globalSettings: GlobalSettings | null
  t: TFunction
}) {
  const [taskId, setTaskId] = useState('')
  const [repoRoot, setRepoRoot] = useState(defaultRepoRoot)
  const [taskText, setTaskText] = useState(() => t('modal.create.taskBriefDefault'))
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [implementer, setImplementer] = useState<Actor>(() => {
    try { return (localStorage.getItem('buddy.lastImplementer') as Actor) || 'claude' } catch { return 'claude' }
  })
  const [reviewer, setReviewer] = useState<Actor>(() => {
    try { return (localStorage.getItem('buddy.lastReviewer') as Actor) || 'codex' } catch { return 'codex' }
  })
  const [implementerSession, setImplementerSession] = useState('')
  const [reviewerSession, setReviewerSession] = useState('')
  const [executionMode, setExecutionMode] = useState<'immediate' | 'queued'>('immediate')

  // --- Attachment helpers (same logic as Composer.tsx) ---
  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => {
      if (a.id === id) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
        return false
      }
      return true
    }))
  }, [])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    if (!items || items.length === 0) return

    const newAttachments: Attachment[] = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (!file) continue
        const previewUrl = URL.createObjectURL(file)
        const buffer = await file.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ''
        for (let j = 0; j < bytes.length; j++) {
          binary += String.fromCharCode(bytes[j])
        }
        const bufferBase64 = btoa(binary)
        newAttachments.push({
          id: generateAttachmentId(),
          name: file.name || `paste-${Date.now()}.png`,
          category: 'image',
          mimeType: item.type,
          size: file.size,
          previewUrl,
          bufferBase64,
        })
      }
    }

    if (newAttachments.length === 0 && e.clipboardData.files.length > 0) {
      e.preventDefault()
      try {
        const fileEntries: Array<{ path: string; size: number }> = await window.api.readClipboardFilePaths()
        for (const entry of fileEntries) {
          if (attachments.some(a => a.filePath === entry.path)) continue
          const name = entry.path.split('/').pop() ?? entry.path
          const ext = name.split('.').pop()?.toLowerCase() ?? ''
          const mimeType = MIME_MAP[ext] ?? 'application/octet-stream'
          const isImage = mimeType.startsWith('image/')
          let previewUrl: string | undefined
          if (isImage) {
            try { previewUrl = await window.api.readFileAsDataURL(entry.path, mimeType) } catch {}
          }
          newAttachments.push({
            id: generateAttachmentId(),
            name,
            category: isImage ? 'image' : 'file',
            mimeType,
            size: entry.size,
            filePath: entry.path,
            previewUrl,
          })
        }
      } catch {}
    }

    if (newAttachments.length > 0) {
      setAttachments(prev => [...prev, ...newAttachments])
    }
  }, [attachments])

  const imageAttachments = attachments.filter(a => {
    if (a.category === 'image' || a.mimeType.startsWith('image/')) return true
    const ext = a.name.split('.').pop()?.toLowerCase() ?? ''
    return IMAGE_EXTS.has(ext)
  })
  const fileAttachments = attachments.filter(a => !imageAttachments.includes(a))

  const normalizedGlobalSettings = normalizeGlobalSettings(globalSettings)

  // Debounced git branch query — avoids firing on every keystroke in the path input
  const [debouncedRepoRoot, setDebouncedRepoRoot] = useState(repoRoot.trim())
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedRepoRoot(repoRoot.trim()), 500)
    return () => clearTimeout(timer)
  }, [repoRoot])

  const { data: gitStatusResult } = useGitStatus(debouncedRepoRoot || null)
  const gitBranchName = gitStatusResult?.branch || ''

  // Handle Escape at document level so it works regardless of focus position
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const TASK_NAME_RE = /^[a-zA-Z0-9一-鿿㐀-䶿""「」【】{}][a-zA-Z0-9一-鿿㐀-䶿 ._\-""「」【】{}]{0,63}$/
  const taskIdError = taskId.trim() && !TASK_NAME_RE.test(taskId.trim())
    ? t('modal.create.taskNameError')
    : null
  const sameActorError = implementer === reviewer
  const canSubmit = taskId.trim() && !taskIdError && !sameActorError

  const legacySeedFor = (actor: Actor, session: string): Record<string, string> => {
    const value = session.trim()
    if (!value) return {}
    if (actor === 'codex') return { seed_codex_thread_id: value }
    if (['claude', 'opencode', 'kimi'].includes(actor)) return { [`seed_${actor}_session_id`]: value }
    return {}
  }

  const handleSubmit = () => {
    if (!canSubmit) return
    try {
      localStorage.setItem('buddy.lastImplementer', implementer)
      localStorage.setItem('buddy.lastReviewer', reviewer)
    } catch {}
    const launchers = normalizedGlobalSettings.launchers ?? {}
    const taskLaunchers = Object.fromEntries(Object.entries(launchers).map(([id, launcher]) => [
      id,
      {
        ...launcher,
        env: { ...launcher.env },
        ...(launcher.cursor
          ? { cursor: { ...launcher.cursor, extra_args: [...(launcher.cursor.extra_args ?? [])] } }
          : {})
      }
    ]))
    const seedAgentSessions = Object.fromEntries([
      [implementer, implementerSession.trim()],
      [reviewer, reviewerSession.trim()]
    ].filter((entry): entry is [string, string] => Boolean(entry[1])))
    const settings: Record<string, unknown> = {
      protocol_version: normalizedGlobalSettings.protocol_version ?? '1',
      flow_policy: 'claude_then_codex',
      role_mode: implementer === 'codex' ? 'codex_implements' : 'claude_implements',
      implementer_actor: implementer,
      reviewer_actor: reviewer,
      max_consecutive_failures: normalizedGlobalSettings.max_consecutive_failures ?? 10,
      launchers: taskLaunchers,
      seed_agent_sessions: seedAgentSessions,
      ...legacySeedFor(implementer, implementerSession),
      ...legacySeedFor(reviewer, reviewerSession)
    }
    onCreate(taskId.trim(), taskText, repoRoot.trim(), settings, attachments.length > 0 ? attachments : undefined, executionMode)
  }

  const handleSelectDirectory = async () => {
    try {
      const path = await window.api.selectDirectory(repoRoot || defaultRepoRoot)
      if (path) setRepoRoot(path)
    } catch (error) {
      console.error('Failed to select directory:', error)
    }
  }

  const actorOptions: Actor[] = Object.entries(normalizedGlobalSettings.launchers ?? {})
    .filter(([actor, launcher]) => {
      if (!launcher.command.trim()) return false
      if (['claude', 'codex', 'opencode', 'kimi'].includes(actor)) return true
      return Boolean(launcher.backend && launcher.backend !== 'auto' && launcher.backend !== 'contract')
    })
    .map(([actor]) => actor)

  useEffect(() => {
    if (!actorOptions.length) return
    const nextImplementer = actorOptions.includes(implementer) ? implementer : actorOptions[0]
    const nextReviewer = actorOptions.includes(reviewer) && reviewer !== nextImplementer
      ? reviewer
      : (actorOptions.find((actor) => actor !== nextImplementer) ?? actorOptions[0])
    if (nextImplementer !== implementer) setImplementer(nextImplementer)
    if (nextReviewer !== reviewer) setReviewer(nextReviewer)
  }, [actorOptions.join('\0'), implementer, reviewer])

  const optionLabel = (actor: string) => {
    const configured = normalizedGlobalSettings.launchers?.[actor]?.display_name?.trim()
    if (configured) return configured
    const key = ACTOR_LABEL_KEY[actor]
    return key ? t(key) : actorDisplayName(actor, normalizedGlobalSettings)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" data-buddy-modal onKeyDown={(e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
        e.preventDefault()
        handleSubmit()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }}>
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
              autoFocus
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
              onPaste={handlePaste}
              rows={10}
              className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent font-mono text-xs bg-bg"
            />
            {/* Attachment previews — same layout as Composer */}
            {attachments.length > 0 && (
              <div className="mt-2 space-y-2">
                {imageAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {imageAttachments.map(att => (
                      <div
                        key={att.id}
                        className="group relative rounded-lg overflow-hidden border border-border bg-bg-base"
                      >
                        {att.previewUrl ? (
                          <img
                            src={att.previewUrl}
                            alt={att.name}
                            className="h-20 w-auto max-w-[160px] object-cover"
                          />
                        ) : (
                          <div className="h-20 w-20 flex items-center justify-center bg-bg-subtle">
                            <ImageIcon size={20} className="text-fg-muted" />
                          </div>
                        )}
                        <button
                          onClick={() => removeAttachment(att.id)}
                          className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger"
                          title={t('composer.attachment.remove')}
                        >
                          <X size={12} strokeWidth={2.5} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {fileAttachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {fileAttachments.map(att => {
                      const ext = att.name.split('.').pop()?.toUpperCase() ?? ''
                      const extL = att.name.split('.').pop()?.toLowerCase() ?? ''
                      const Icon = EXT_ICON_MAP[extL] ?? FileIcon
                      return (
                        <div
                          key={att.id}
                          className="group relative rounded-lg border border-border bg-bg-base px-2.5 py-1.5 flex items-center gap-2.5 max-w-[220px] hover:border-border-primary transition-colors"
                        >
                          <Icon size={28} className="flex-shrink-0 text-fg-muted" />
                          <div className="flex-1 min-w-0">
                            <div className="truncate text-xs text-fg-secondary">{att.name}</div>
                            {ext && <div className="text-[10px] text-fg-muted">{ext}</div>}
                          </div>
                          <button
                            onClick={() => removeAttachment(att.id)}
                            className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger"
                            title={t('composer.attachment.remove')}
                          >
                            <X size={12} strokeWidth={2.5} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
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
            {gitBranchName && (
              <div className="flex items-center gap-1.5 mt-1.5 text-xs text-fg-muted">
                <GitBranch size={12} className="flex-shrink-0" />
                <span className="text-fg-secondary">{t('modal.create.gitBranch')}</span>
                <span className="font-mono">{gitBranchName}</span>
              </div>
            )}
          </div>

          {/* 执行者 / 审查者 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-fg-secondary mb-1">{t('modal.create.implementer')}</label>
              <select
                value={implementer}
                onChange={(e) => {
                  setImplementer(e.target.value as Actor)
                  setImplementerSession('')
                }}
                className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-xs"
              >
                {actorOptions.map(a => (
                  <option key={a} value={a}>{optionLabel(a)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-secondary mb-1">{t('modal.create.reviewer')}</label>
              <select
                value={reviewer}
                onChange={(e) => {
                  setReviewer(e.target.value as Actor)
                  setReviewerSession('')
                }}
                className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-xs"
              >
                {actorOptions.map(a => (
                  <option key={a} value={a}>{optionLabel(a)}</option>
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

          {/* 执行方式 */}
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1">
              {t('modal.create.executionMode')}
            </label>
            <div className="flex gap-2">
              {(['immediate', 'queued'] as const).map((mode) => {
                const active = executionMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setExecutionMode(mode)}
                    className={`flex-1 px-3 py-1.5 text-xs border rounded-lg transition-colors ${
                      active
                        ? 'border-accent bg-accent-soft text-fg'
                        : 'border-border text-fg-secondary hover:bg-bg-subtle'
                    }`}
                  >
                    {mode === 'immediate'
                      ? t('modal.create.executionMode.immediate')
                      : t('modal.create.executionMode.queued')}
                  </button>
                )
              })}
            </div>
            <div className="text-xs text-fg-muted mt-1">
              {executionMode === 'immediate'
                ? t('modal.create.executionMode.immediateHint')
                : t('modal.create.executionMode.queuedHint')}
            </div>
          </div>
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
            {t('modal.create.submit')} <span className="opacity-60 ml-1">⌘⏎</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function QueuedRunNowButton({
  position,
  superseded,
  onRunNow
}: {
  position: number
  superseded: boolean
  onRunNow: () => void
}) {
  const t = useT()
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2 rounded-lg bg-bg-elevated border border-border shadow-lg">
      <span className="text-xs text-fg-secondary">
        {superseded
          ? t('status.QUEUED_SUPERSEDED')
          : position > 0
            ? t('status.QUEUED_POSITION', { n: position })
            : t('status.QUEUED')}
      </span>
      <button
        type="button"
        onClick={onRunNow}
        className="px-3 py-1.5 text-xs font-medium bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover transition-colors"
      >
        {t('queue.runNow')}
      </button>
    </div>
  )
}
