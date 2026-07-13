import { PanelLeft, PanelRight, Play, RotateCw } from 'lucide-react'
import { useT } from '../hooks/useI18n'
import type { TFunction } from '../hooks/useI18n'
import type { TranslationKey } from '../lib/i18n'
import type { TaskStatus } from '../../shared/types'

interface TitleBarProps {
  taskName: string
  taskStatus?: TaskStatus | null
  isSidebarOpen: boolean
  isStatusBarOpen: boolean
  isFullScreen: boolean
  showToggles?: boolean
  bare?: boolean
  onToggleSidebar: () => void
  onToggleStatusBar: () => void
  onRetry?: () => void
  onResume?: () => void
}

interface CompactStatusInfo {
  cls: 'running' | 'paused' | 'done' | 'danger'
  labelKey: TranslationKey
  pulse: boolean
}

function compactStatusInfo(status: TaskStatus | null | undefined): CompactStatusInfo | null {
  if (!status) return null
  if (status.startsWith('RUNNING_')) {
    return { cls: 'running', labelKey: 'titleBar.status.running', pulse: true }
  }
  if (status === 'PINGING') {
    return { cls: 'running', labelKey: 'status.PINGING', pulse: true }
  }
  if (status === 'PAUSED') return { cls: 'paused', labelKey: 'status.PAUSED', pulse: false }
  if (status === 'DONE') return { cls: 'done', labelKey: 'status.DONE', pulse: false }
  if (status === 'FAILED') return { cls: 'danger', labelKey: 'status.FAILED', pulse: false }
  if (status === 'QUEUED') return { cls: 'paused', labelKey: 'status.QUEUED', pulse: false }
  return null
}

export function TitleBar({
  taskName,
  taskStatus,
  isSidebarOpen,
  isStatusBarOpen,
  isFullScreen,
  showToggles = true,
  bare = false,
  onToggleSidebar,
  onToggleStatusBar,
  onRetry,
  onResume
}: TitleBarProps) {
  const t = useT()
  const compact = !isStatusBarOpen ? compactStatusInfo(taskStatus) : null
  return (
    <div className={`h-[50px] flex items-center px-4 bg-bg-elevated drag-region ${bare ? '' : 'border-b border-border'}`}>
      {/* 红绿灯占位 + 展开按钮（仅在侧边栏关闭时显示，否则它们在侧边栏顶部） */}
      {!isSidebarOpen && (
        <>
          <div className={`flex-shrink-0 ${isFullScreen ? 'w-[32px]' : 'w-[68px]'}`} />
          {showToggles && (
            <button
              onClick={onToggleSidebar}
              className="w-5 h-5 mt-[4px] flex items-center justify-center rounded hover:bg-bg-muted no-drag"
              title={t('sidebar.expand')}
            >
              <PanelLeft size={14} strokeWidth={2} />
            </button>
          )}
        </>
      )}

      {/* 任务名（左对齐） */}
      <div className="flex-1 text-sm font-medium truncate px-4">
        {bare ? '' : (taskName || t('app.brand'))}
      </div>

      {/* 紧凑状态指示（仅在右侧栏隐藏时显示） */}
      {showToggles && compact && (
        <CompactStatus
          info={compact}
          status={taskStatus ?? null}
          onRetry={onRetry}
          onResume={onResume}
          t={t}
        />
      )}

      {/* 右侧栏切换按钮（最右侧，右对齐） */}
      {showToggles && (
        <button
          onClick={onToggleStatusBar}
          className="w-5 h-5 mt-[4px] flex items-center justify-center rounded hover:bg-bg-muted no-drag"
          title={isStatusBarOpen ? t('titleBar.toggleStatusBar.collapse') : t('titleBar.toggleStatusBar.expand')}
        >
          <PanelRight size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

function CompactStatus({
  info,
  status,
  onRetry,
  onResume,
  t
}: {
  info: CompactStatusInfo
  status: TaskStatus | null
  onRetry?: () => void
  onResume?: () => void
  t: TFunction
}) {
  return (
    <div className="h-5 flex items-center gap-1.5 mr-2 mt-[4px] no-drag">
      <span className={`status-dot status-dot-${info.cls} ${info.pulse ? 'status-dot-pulse' : ''}`} />
      <span className={`text-xs font-medium status-text-${info.cls}`}>{t(info.labelKey)}</span>
      {status === 'PAUSED' && onResume && (
        <button
          onClick={onResume}
          title={t('common.resume')}
          className="ml-0.5 w-5 h-5 flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-bg-muted"
        >
          <Play size={12} strokeWidth={2.5} fill="currentColor" />
        </button>
      )}
      {status === 'FAILED' && onRetry && (
        <button
          onClick={onRetry}
          title={t('common.retry')}
          className="ml-0.5 w-5 h-5 flex items-center justify-center rounded text-fg-secondary hover:text-fg hover:bg-bg-muted"
        >
          <RotateCw size={12} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}
