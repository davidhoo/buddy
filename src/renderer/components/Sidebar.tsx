import { useEffect, useState } from 'react'
import { Task, TaskStatus, ActiveRun } from '../../shared/types'
import { ResizeHandle } from './ResizeHandle'
import { elapsedText } from '../lib/format'

import type { SettingsTab } from './SettingsContent'

function LiveElapsed({ startedAt }: { startedAt: string }) {
  const [text, setText] = useState(() => elapsedText(startedAt))
  useEffect(() => {
    const id = setInterval(() => setText(elapsedText(startedAt)), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return <span className="text-accent">{text}</span>
}

const statusText: Record<TaskStatus, string> = {
  READY: '就绪',
  RUNNING_CLAUDE: 'Claude 运行中',
  RUNNING_CODEX: 'Codex 运行中',
  RUNNING_OPENCODE: 'OpenCode 运行中',
  RUNNING_KIMI: 'Kimi 运行中',
  COUNTDOWN: '倒计时中',
  PAUSED: '已暂停',
  FAILED: '失败',
  DONE: '已完成',
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
  onToggleSidebar
}: SidebarProps) {
  if (!isOpen) return null

  return (
    <div className="flex h-full">
      <div className="bg-bg text-fg flex flex-col h-full select-none" style={{ width: `${width}px` }}>
      {/* 顶部红绿灯区域 + 收起按钮 */}
      <div className="h-[50px] flex-shrink-0 flex items-center drag-region">
        <div className="w-[76px] flex-shrink-0" />
        {view !== 'settings' && (
          <button
            onClick={onToggleSidebar}
            className="w-5 h-5 mt-[4px] flex items-center justify-center rounded hover:bg-bg-muted no-drag"
            title="收起侧边栏"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        )}
        <div className="flex-1" />
      </div>

      {view === 'settings' ? (
        <SettingsSidebar
          settingsTab={settingsTab}
          onSelectSettingsTab={onSelectSettingsTab}
          onBackToApp={onBackToApp}
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
  onBackToApp
}: {
  settingsTab: SettingsTab
  onSelectSettingsTab: (tab: SettingsTab) => void
  onBackToApp: () => void
}) {
  return (
    <>
      <div className="flex-1 overflow-y-auto px-2 pt-2">
        <button
          onClick={onBackToApp}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg-secondary hover:text-fg rounded-lg transition-colors mb-2"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          返回应用
        </button>

        <SettingsMenuItem
          label="常规"
          icon={
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          }
          active={settingsTab === 'general'}
          onClick={() => onSelectSettingsTab('general')}
        />

        <SettingsMenuItem
          label="外观"
          icon={
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          }
          active={settingsTab === 'appearance'}
          onClick={() => onSelectSettingsTab('appearance')}
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
          ? 'bg-bg-muted text-fg font-medium'
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
  onOpenSettings
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
}) {
  const groupedTasks = tasks.reduce<Record<string, Task[]>>((acc, task) => {
    const key = projectName(task)
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
        <div className="text-xl font-bold">buddy</div>
        <div className="text-xs text-fg-secondary">Coding Agent 协作台</div>
      </div>

      <div className="px-4 py-2">
        <button
          onClick={() => onCreateTask()}
          className="w-full px-4 py-2 bg-accent text-fg-inverse rounded-lg hover:bg-accent-hover transition-colors"
        >
          新建任务
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {!isHealthy ? (
          <div className="px-2 py-4 text-center text-danger text-sm">
            <div className="mb-2">buddy 服务未运行</div>
            <div className="text-xs text-fg-muted">
              请在终端运行: <code className="bg-bg-muted px-1 rounded">buddy</code>
            </div>
          </div>
        ) : isLoading ? (
          <div className="px-2 py-4 text-center text-fg-muted text-sm">
            加载中...
          </div>
        ) : error ? (
          <div className="px-2 py-4 text-center text-danger text-sm">
            加载失败: {error.message}
          </div>
        ) : Object.keys(groupedTasks).length === 0 ? (
          <div className="px-2 py-4 text-center text-fg-muted text-sm">
            暂无任务
          </div>
        ) : (
          <>
            <div className="px-2 pt-2 pb-1 text-xs text-fg-muted font-medium">项目</div>
            {Object.entries(groupedTasks).map(([projectKey, workspaceTasks]) => {
              const hasSelected = workspaceTasks.some(t => t.task_id === selectedTaskId)
              return (
                <div key={projectKey} className="mb-3">
                  <div
                    title={workspaceTasks[0]?.repo_root || projectKey}
                    className={`group flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-bg-subtle ${
                    hasSelected ? 'text-fg font-medium' : 'text-fg-secondary'
                  }`}>
                    <FolderIcon />
                    <span className="truncate flex-1">{projectKey}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation() }}
                      className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-bg-muted transition-opacity"
                      title="更多操作"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="5" cy="12" r="1.2" fill="currentColor" />
                        <circle cx="12" cy="12" r="1.2" fill="currentColor" />
                        <circle cx="19" cy="12" r="1.2" fill="currentColor" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onCreateTask(workspaceTasks[0]?.repo_root) }}
                      className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-bg-muted transition-opacity"
                      title="在此项目新建任务"
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                      </svg>
                    </button>
                  </div>
                  {workspaceTasks.length === 0 ? (
                    <div className="px-3 py-1.5 ml-2 text-xs text-fg-muted">暂无对话</div>
                  ) : (
                    workspaceTasks.map((task) => {
                      const isSelected = selectedTaskId === task.task_id
                      const isRunning = statusClass(task.status) === 'running'
                      const round = task.round ?? 0
                      const elapsed = isRunning && task.active_run?.started_at
                        ? elapsedText(task.active_run.started_at)
                        : null
                      return (
                        <div
                          key={task.task_id}
                          onClick={() => onSelectTask(task.task_id, task.workspace_key)}
                          title={`${task.task_id}\n${task.workspace_key}`}
                          className={`group/task w-full text-left px-3 py-1.5 ml-2 rounded-md mb-0.5 transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-bg-muted'
                              : 'hover:bg-bg-subtle'
                          } ${task.status === 'DONE' ? 'task-done' : ''}`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`status-dot status-dot-${statusClass(task.status)} ${isRunning ? 'status-dot-pulse' : ''}`} />
                            <span className={`text-sm truncate flex-1 ${
                              isSelected ? 'text-fg font-medium' : 'text-fg-secondary'
                            }`}>
                              {task.task_id}
                            </span>
                            <span className={`task-status-text status-text-${statusClass(task.status)}`}>
                              {statusText[task.status] || task.status}
                            </span>
                            {task.updated_at && (
                              <span className="text-xs text-fg-muted flex-shrink-0 group-hover/task:hidden">
                                {formatRelativeTime(task.updated_at)}
                              </span>
                            )}
                            <div className="hidden group-hover/task:flex items-center gap-0.5 flex-shrink-0">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation() }}
                                className="w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-bg-muted"
                                title="置顶"
                              >
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <line x1="12" y1="17" x2="12" y2="22" />
                                  <path d="M5 17h14l-1.5-2.5V9a4 4 0 0 0-3-3.87V4a1.5 1.5 0 0 0-3 0v1.13A4 4 0 0 0 8.5 9v5.5L7 17z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const ok = window.confirm(`确定删除任务 ${task.task_id}？\n\n这会删除该任务的本地记录、对话和 artifacts。`)
                                  if (ok) onDeleteTask(task.task_id, task.workspace_key)
                                }}
                                className="w-5 h-5 flex items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-bg-muted"
                                title="删除会话"
                              >
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                  <path d="M10 11v6M14 11v6" />
                                  <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          {(round > 0 || elapsed) && (
                            <div className="flex items-center gap-1.5 mt-0.5 pl-[22px] text-xs text-fg-muted">
                              {round > 0 && <span>第 {round} 轮</span>}
                              {round > 0 && elapsed && <span>·</span>}
                              {elapsed && <LiveElapsed startedAt={task.active_run!.started_at} />}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              )
            })}
          </>
        )}
      </div>

      <div className="p-4 border-t border-border-subtle">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg-secondary hover:text-fg hover:bg-bg-subtle rounded-lg transition-colors"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          设置
        </button>
      </div>
    </>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function projectName(task: Task): string {
  if (task.repo_root) {
    const basename = task.repo_root.replace(/\/+$/, '').split('/').pop()
    if (basename) return basename
  }
  const key = task.workspace_key || 'default'
  return key.replace(/-[a-f0-9]{8,}$/i, '')
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff) || diff < 0) return ''
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}时`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day}天`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month}月`
  return `${Math.floor(month / 12)}年`
}
