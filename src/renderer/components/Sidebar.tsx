import { useEffect, useState, useRef, useCallback } from 'react'
import {
  ChevronLeft,
  Ellipsis,
  Folder,
  FolderOpen,
  Keyboard,
  PanelLeft,
  Pin,
  Settings as SettingsIcon,
  SquarePen,
  SquarePlus,
  Sun,
  Trash2
} from 'lucide-react'
import { Task, TaskStatus } from '../../shared/types'
import { ResizeHandle } from './ResizeHandle'
import { useT } from '../hooks/useI18n'
import type { TFunction } from '../hooks/useI18n'
import type { TranslationKey } from '../lib/i18n'
import { projectNameForTask, readStringArraySetting, writeStringArraySetting } from '../lib/taskList'

import type { SettingsTab } from './SettingsContent'

const STATUS_KEYS: Record<TaskStatus, TranslationKey> = {
  READY: 'status.READY',
  RUNNING_CLAUDE: 'status.RUNNING_CLAUDE',
  RUNNING_CODEX: 'status.RUNNING_CODEX',
  RUNNING_OPENCODE: 'status.RUNNING_OPENCODE',
  RUNNING_KIMI: 'status.RUNNING_KIMI',
  COUNTDOWN: 'status.COUNTDOWN',
  PAUSED: 'status.PAUSED',
  FAILED: 'status.FAILED',
  DONE: 'status.DONE',
}

function statusText(status: TaskStatus, t: TFunction): string {
  return t(STATUS_KEYS[status] || 'status.READY')
}

function statusClass(status: TaskStatus): string {
  if (status === 'COUNTDOWN' || status === 'READY') return 'ready'
  if (status.startsWith('RUNNING_')) return 'running'
  if (status === 'FAILED') return 'danger'
  if (status === 'PAUSED') return 'paused'
  if (status === 'DONE') return 'done'
  return 'neutral'
}

interface SidebarProps {
  isOpen: boolean
  width: number
  tasks: Task[]
  selectedTaskId: string | null
  isLoading: boolean
  error: Error | null
  isHealthy: boolean
  view: 'chat' | 'settings'
  settingsTab: SettingsTab
  onSelectTask: (taskId: string, workspaceKey: string) => void
  onCreateTask: (repoRoot?: string) => void
  onDeleteTask: (taskId: string, workspaceKey: string) => void
  onOpenSettings: () => void
  onBackToApp: () => void
  onSelectSettingsTab: (tab: SettingsTab) => void
  onResize: (delta: number) => void
  onToggleSidebar: () => void
  isFullScreen: boolean
  onRenameProject: (repoRoot: string, newName: string) => void
  onOpenInFinder: (path: string) => void
  onRemoveProject: (repoRoot: string) => void
  projectNames: Record<string, string>
}

export function Sidebar({
  isOpen,
  width,
  tasks,
  selectedTaskId,
  isLoading,
  error,
  isHealthy,
  view,
  settingsTab,
  onSelectTask,
  onCreateTask,
  onDeleteTask,
  onOpenSettings,
  onBackToApp,
  onSelectSettingsTab,
  onResize,
  onToggleSidebar,
  isFullScreen,
  onRenameProject,
  onOpenInFinder,
  onRemoveProject,
  projectNames
}: SidebarProps) {
  const t = useT()
  if (!isOpen) return null

  return (
    <div className="flex h-full">
      <div className="bg-bg text-fg flex flex-col h-full select-none" style={{ width: `${width}px` }}>
      {/* 顶部红绿灯区域 + 收起按钮 */}
      <div className="h-[50px] flex-shrink-0 flex items-center drag-region">
        <div className={`flex-shrink-0 ${isFullScreen ? 'w-4' : 'w-[76px]'}`} />
        {view !== 'settings' && (
          <button
            onClick={onToggleSidebar}
            className="w-5 h-5 mt-[4px] flex items-center justify-center rounded hover:bg-bg-muted no-drag"
            title={t('sidebar.collapse')}
          >
            <PanelLeft size={14} strokeWidth={2} />
          </button>
        )}
        <div className="flex-1" />
      </div>

      {view === 'settings' ? (
        <SettingsSidebar
          settingsTab={settingsTab}
          onSelectSettingsTab={onSelectSettingsTab}
          onBackToApp={onBackToApp}
          t={t}
        />
      ) : (
        <ChatSidebar
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          isLoading={isLoading}
          error={error}
          isHealthy={isHealthy}
          onSelectTask={onSelectTask}
          onCreateTask={onCreateTask}
          onDeleteTask={onDeleteTask}
          onOpenSettings={onOpenSettings}
          onRenameProject={onRenameProject}
          onOpenInFinder={onOpenInFinder}
          onRemoveProject={onRemoveProject}
          projectNames={projectNames}
          t={t}
        />
      )}
    </div>
    {view !== 'settings' && <ResizeHandle direction="right" onResize={onResize} />}
    </div>
  )
}

function SettingsSidebar({
  settingsTab,
  onSelectSettingsTab,
  onBackToApp,
  t
}: {
  settingsTab: SettingsTab
  onSelectSettingsTab: (tab: SettingsTab) => void
  onBackToApp: () => void
  t: TFunction
}) {
  return (
    <>
      <div className="flex-1 overflow-y-auto px-2 pt-2">
        <button
          onClick={onBackToApp}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg-secondary hover:text-fg rounded-lg transition-colors mb-2"
        >
          <ChevronLeft size={14} strokeWidth={2} />
          {t('sidebar.backToApp')}
        </button>

        <SettingsMenuItem
          label={t('settings.tab.general')}
          icon={<SettingsIcon size={15} strokeWidth={1.7} />}
          active={settingsTab === 'general'}
          onClick={() => onSelectSettingsTab('general')}
        />

        <SettingsMenuItem
          label={t('settings.tab.appearance')}
          icon={<Sun size={15} strokeWidth={1.7} />}
          active={settingsTab === 'appearance'}
          onClick={() => onSelectSettingsTab('appearance')}
        />

        <SettingsMenuItem
          label={t('settings.tab.keyboard')}
          icon={<Keyboard size={15} strokeWidth={1.7} />}
          active={settingsTab === 'keyboard'}
          onClick={() => onSelectSettingsTab('keyboard')}
        />
      </div>
    </>
  )
}

function SettingsMenuItem({ label, icon, active, onClick }: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors ${
        active
          ? 'bg-bg-subtle text-fg'
          : 'text-fg-secondary hover:text-fg hover:bg-bg-subtle'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

function ChatSidebar({
  tasks,
  selectedTaskId,
  isLoading,
  error,
  isHealthy,
  onSelectTask,
  onCreateTask,
  onDeleteTask,
  onOpenSettings,
  onRenameProject,
  onOpenInFinder,
  onRemoveProject,
  projectNames,
  t
}: {
  tasks: Task[]
  selectedTaskId: string | null
  isLoading: boolean
  error: Error | null
  isHealthy: boolean
  onSelectTask: (taskId: string, workspaceKey: string) => void
  onCreateTask: (repoRoot?: string) => void
  onDeleteTask: (taskId: string, workspaceKey: string) => void
  onOpenSettings: () => void
  onRenameProject: (repoRoot: string, newName: string) => void
  onOpenInFinder: (path: string) => void
  onRemoveProject: (repoRoot: string) => void
  projectNames: Record<string, string>
  t: TFunction
}) {
  const [openMenuRepoRoot, setOpenMenuRepoRoot] = useState<string | null>(null)
  const [renamingRepoRoot, setRenamingRepoRoot] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const [pinnedTaskIds, setPinnedTaskIds] = useState<string[]>(() => readStringArraySetting('buddy.pinnedTaskIds'))
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<string[]>(() => readStringArraySetting('buddy.collapsedProjectKeys'))
  const [expandedTaskProjects, setExpandedTaskProjects] = useState<Set<string>>(new Set())

  const togglePin = useCallback((taskId: string) => {
    setPinnedTaskIds(prev => {
      const next = prev.includes(taskId) ? prev.filter(id => id !== taskId) : [...prev, taskId]
      writeStringArraySetting('buddy.pinnedTaskIds', next)
      return next
    })
  }, [])

  const toggleProject = useCallback((projectKey: string) => {
    setCollapsedProjectKeys(prev => {
      const next = prev.includes(projectKey)
        ? prev.filter(key => key !== projectKey)
        : [...prev, projectKey]
      writeStringArraySetting('buddy.collapsedProjectKeys', next)
      return next
    })
  }, [])

  const toggleTaskExpand = useCallback((projectKey: string) => {
    setExpandedTaskProjects(prev => {
      const next = new Set(prev)
      if (next.has(projectKey)) next.delete(projectKey)
      else next.add(projectKey)
      return next
    })
  }, [])

  // Drop stale pins (deleted tasks)
  const validPinnedIds = pinnedTaskIds.filter(id => tasks.some(t => t.task_id === id))
  const pinnedTasks = validPinnedIds
    .map(id => tasks.find(t => t.task_id === id)!)
    .filter(Boolean)
  const unpinnedTasks = tasks.filter(t => !validPinnedIds.includes(t.task_id))

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuRepoRoot) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuRepoRoot(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenuRepoRoot])

  const groupedTasks = unpinnedTasks.reduce<Record<string, Task[]>>((acc, task) => {
    const key = projectNameForTask(task, projectNames)
    if (!acc[key]) acc[key] = []
    acc[key].push(task)
    return acc
  }, {})

  Object.values(groupedTasks).forEach(list => {
    list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  })

  return (
    <>
      <div className="px-4 pt-2 pb-2">
        <div className="text-xl font-bold">{t('app.brand')}</div>
        <div className="text-xs text-fg-secondary">{t('app.tagline')}</div>
      </div>

      <div className="px-4 py-2">
        <button
          onClick={() => onCreateTask()}
          className="w-full px-4 py-2 bg-accent-soft text-fg rounded-lg hover:bg-accent-soft-hover transition-colors flex items-center justify-center gap-2"
        >
          <SquarePlus size={14} strokeWidth={2} />
          {t('sidebar.newTask')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2">
        {!isHealthy ? (
          <div className="px-2 py-4 text-center text-danger text-sm">
            <div className="mb-2">{t('sidebar.notHealthy')}</div>
            <div className="text-xs text-fg-muted">
              {t('sidebar.notHealthyHint')}<code className="bg-bg-muted px-1 rounded">Buddy</code>
            </div>
          </div>
        ) : isLoading ? (
          <div className="px-2 py-4 text-center text-fg-muted text-sm">
            {t('common.loading')}
          </div>
        ) : error ? (
          <div className="px-2 py-4 text-center text-danger text-sm">
            {t('sidebar.loadFailed', { message: error.message })}
          </div>
        ) : Object.keys(groupedTasks).length === 0 && pinnedTasks.length === 0 ? (
          <div className="px-2 py-4 text-center text-fg-muted text-sm">
            {t('sidebar.empty')}
          </div>
        ) : (
          <>
            {pinnedTasks.length > 0 && (
              <>
                <div className="px-2 pt-2 pb-1 text-xs text-fg-muted font-medium">{t('sidebar.pinned')}</div>
                {pinnedTasks.map((task) => {
                  const isSelected = selectedTaskId === task.task_id
                  const isRunning = statusClass(task.status) === 'running'
                  const proj = projectNameForTask(task, projectNames)
                  return (
                    <div
                      key={task.task_id}
                      onClick={() => onSelectTask(task.task_id, task.workspace_key)}
                      title={`${task.task_id}\n${task.workspace_key}`}
                      className={`group/task w-full h-7 text-left px-3 ml-2 rounded-md mb-0.5 transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-bg-subtle'
                          : 'hover:bg-bg-subtle'
                      } ${task.status === 'DONE' ? 'task-done' : ''}`}
                    >
                      <div className="flex h-full items-center gap-2">
                        <span className={`status-dot status-dot-${statusClass(task.status)} ${isRunning ? 'status-dot-pulse' : ''}`} />
                        <span className={`text-xs truncate flex-1 ${
                            isSelected ? 'text-fg' : 'text-fg-secondary'
                        }`}>
                          {task.task_id}
                        </span>
                        <span className="text-xs text-fg-muted truncate max-w-[60px]">{proj}</span>
                        <span className={`task-status-text status-text-${statusClass(task.status)}`}>
                          {statusText(task.status, t)}
                        </span>
                        {task.updated_at && (
                          <span className="text-xs text-fg-muted flex-shrink-0 group-hover/task:hidden">
                            {formatRelativeTime(task.updated_at, t)}
                          </span>
                        )}
                        <div className="hidden group-hover/task:flex items-center gap-0.5 flex-shrink-0">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); togglePin(task.task_id) }}
                            className="w-5 h-5 flex items-center justify-center rounded text-accent hover:text-accent-hover hover:bg-bg-muted"
                            title={t('sidebar.tooltipUnpin')}
                          >
                            <Pin size={13} fill="currentColor" strokeWidth={2} style={{ transform: 'rotate(-30deg)' }} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              const ok = window.confirm(t('sidebar.confirmDeleteTask', { id: task.task_id }))
                              if (ok) onDeleteTask(task.task_id, task.workspace_key)
                            }}
                            className="w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-bg-muted"
                            title={t('sidebar.tooltipDelete')}
                          >
                            <Trash2 size={13} strokeWidth={2} />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </>
            )}
            <div className="px-2 pt-2 pb-1 text-xs text-fg-muted font-medium">{t('sidebar.projects')}</div>
            {Object.entries(groupedTasks).map(([projectKey, workspaceTasks]) => {
              const hasSelected = workspaceTasks.some(t => t.task_id === selectedTaskId)
              const repoRoot = workspaceTasks[0]?.repo_root || ''
              const isMenuOpen = openMenuRepoRoot === repoRoot
              const isCollapsed = collapsedProjectKeys.includes(projectKey)
              const isExpanded = !isCollapsed
              return (
                <div key={projectKey} className="mb-0">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => toggleProject(projectKey)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleProject(projectKey)
                      }
                    }}
                    title={repoRoot || projectKey}
                    className={`group flex items-center gap-2 px-2 py-1 text-sm rounded-md hover:bg-bg-subtle cursor-pointer focus:outline-none ${
                    hasSelected ? 'text-fg' : 'text-fg-secondary'
                  }`}>
                    <FolderIcon isOpen={isExpanded} />
                    <span className="truncate flex-1">{projectKey}</span>
                    <div className="relative" ref={isMenuOpen ? menuRef : undefined}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setOpenMenuRepoRoot(isMenuOpen ? null : repoRoot) }}
                        className={`w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-bg-muted transition-opacity ${isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                        title={t('sidebar.tooltipMore')}
                      >
                        <Ellipsis size={14} strokeWidth={2} />
                      </button>
                      {isMenuOpen && (
                        <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] bg-bg-elevated border border-border rounded-lg shadow-lg py-1">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setOpenMenuRepoRoot(null); setRenamingRepoRoot(repoRoot) }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-fg hover:bg-bg-subtle transition-colors"
                          >
                            <SquarePen size={14} strokeWidth={2} />
                            {t('sidebar.menuRename')}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setOpenMenuRepoRoot(null); onOpenInFinder(repoRoot) }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-fg hover:bg-bg-subtle transition-colors"
                          >
                            <FolderOpen size={14} strokeWidth={2} />
                            {t('sidebar.menuOpenInFinder')}
                          </button>
                          <div className="my-1 border-t border-border-subtle" />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setOpenMenuRepoRoot(null)
                              const ok = window.confirm(t('sidebar.confirmRemoveProject', { name: projectKey }))
                              if (ok) onRemoveProject(repoRoot)
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-danger hover:bg-bg-subtle transition-colors"
                          >
                            <Trash2 size={14} strokeWidth={2} />
                            {t('sidebar.menuRemove')}
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onCreateTask(workspaceTasks[0]?.repo_root) }}
                      className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-bg-muted transition-opacity"
                      title={t('sidebar.tooltipNewInProject')}
                    >
                      <SquarePlus size={14} strokeWidth={2} />
                    </button>
                  </div>
                  {!isExpanded ? null : workspaceTasks.length === 0 ? (
                    <div className="px-3 py-1.5 ml-2 text-xs text-fg-muted">{t('sidebar.noConversation')}</div>
                  ) : (
                    <>
                      {(expandedTaskProjects.has(projectKey) ? workspaceTasks : workspaceTasks.slice(0, 10)).map((task) => {
                      const isSelected = selectedTaskId === task.task_id
                      const isRunning = statusClass(task.status) === 'running'
                      return (
                        <div
                          key={task.task_id}
                          onClick={() => onSelectTask(task.task_id, task.workspace_key)}
                          title={`${task.task_id}\n${task.workspace_key}`}
                          className={`group/task w-full h-7 text-left px-3 ml-2 rounded-md mb-0.5 transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-bg-subtle'
                              : 'hover:bg-bg-subtle'
                          } ${task.status === 'DONE' ? 'task-done' : ''}`}
                        >
                          <div className="flex h-full items-center gap-2">
                            <span className={`status-dot status-dot-${statusClass(task.status)} ${isRunning ? 'status-dot-pulse' : ''}`} />
                            <span className={`text-xs truncate flex-1 ${
                          isSelected ? 'text-fg' : 'text-fg-secondary'
                            }`}>
                              {task.task_id}
                            </span>
                            <span className={`task-status-text status-text-${statusClass(task.status)}`}>
                              {statusText(task.status, t)}
                            </span>
                            {task.updated_at && (
                              <span className="text-xs text-fg-muted flex-shrink-0 group-hover/task:hidden">
                                {formatRelativeTime(task.updated_at, t)}
                              </span>
                            )}
                            <div className="hidden group-hover/task:flex items-center gap-0.5 flex-shrink-0">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); togglePin(task.task_id) }}
                                className="w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-accent hover:bg-bg-muted"
                                title={t('sidebar.tooltipPin')}
                              >
                                <Pin size={13} strokeWidth={2} style={{ transform: 'rotate(-30deg)' }} />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const ok = window.confirm(t('sidebar.confirmDeleteTask', { id: task.task_id }))
                                  if (ok) onDeleteTask(task.task_id, task.workspace_key)
                                }}
                                className="w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-bg-muted"
                                title={t('sidebar.tooltipDelete')}
                              >
                                <Trash2 size={13} strokeWidth={2} />
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    {workspaceTasks.length > 10 && (
                      <button
                        onClick={() => toggleTaskExpand(projectKey)}
                        className="text-xs text-fg-secondary hover:text-fg py-1 ml-5"
                      >
                        {expandedTaskProjects.has(projectKey) ? t('sidebar.tasksCollapse') : t('sidebar.tasksExpand')}
                      </button>
                    )}
                    </>
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      {renamingRepoRoot && (
        <RenameDialog
          currentName={projectNames[renamingRepoRoot] || renamingRepoRoot.replace(/\/+$/, '').split('/').pop() || ''}
          onConfirm={(newName) => {
            onRenameProject(renamingRepoRoot, newName)
            setRenamingRepoRoot(null)
          }}
          onCancel={() => setRenamingRepoRoot(null)}
          t={t}
        />
      )}

      <div className="p-4 border-t border-border-subtle">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg-secondary hover:text-fg hover:bg-bg-subtle rounded-lg transition-colors"
        >
          <SettingsIcon size={16} strokeWidth={2} />
          {t('sidebar.settings')}
        </button>
      </div>
    </>
  )
}

function FolderIcon({ isOpen }: { isOpen: boolean }) {
  return isOpen
    ? <FolderOpen size={14} strokeWidth={2} className="flex-shrink-0" />
    : <Folder size={14} strokeWidth={2} className="flex-shrink-0" />
}

function formatRelativeTime(iso: string, t: TFunction): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff) || diff < 0) return ''
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return t('time.justNow')
  const min = Math.floor(sec / 60)
  if (min < 60) return t('time.minute', { n: min })
  const hour = Math.floor(min / 60)
  if (hour < 24) return t('time.hour', { n: hour })
  const day = Math.floor(hour / 24)
  if (day < 30) return t('time.day', { n: day })
  const month = Math.floor(day / 30)
  if (month < 12) return t('time.month', { n: month })
  return t('time.year', { n: Math.floor(month / 12) })
}

function RenameDialog({
  currentName,
  onConfirm,
  onCancel,
  t
}: {
  currentName: string
  onConfirm: (newName: string) => void
  onCancel: () => void
  t: TFunction
}) {
  const [name, setName] = useState(currentName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed && trimmed !== currentName) {
      onConfirm(trimmed)
    } else {
      onCancel()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-bg-elevated rounded-xl shadow-xl w-[360px] p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-3">{t('sidebar.renameTitle')}</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-sm"
          />
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm text-fg hover:bg-bg-subtle rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="px-3 py-1.5 text-sm bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover transition-colors disabled:opacity-50"
            >
              {t('common.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
