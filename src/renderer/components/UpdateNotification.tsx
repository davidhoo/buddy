import { AlertCircle, RefreshCw, RotateCw, X } from 'lucide-react'
import type { UpdateStatus, UpdaterErrorPhase } from '../hooks/useUpdater'
import { useT } from '../hooks/useI18n'

interface UpdateNotificationProps {
  status: UpdateStatus
  version: string
  progress: { percent: number; bytesPerSecond: number }
  dismissed: boolean
  errorMessage: string
  errorPhase: UpdaterErrorPhase
  onInstall: () => void
  onRetry: () => void
  onDismiss: () => void
}

export function UpdateNotification({
  status,
  version,
  progress,
  dismissed,
  errorMessage,
  errorPhase,
  onInstall,
  onRetry,
  onDismiss
}: UpdateNotificationProps) {
  const t = useT()

  if (status === 'idle' || status === 'checking' || status === 'available') return null
  // Only installing stays visible after a dismiss and cannot be closed.
  if (dismissed && status !== 'installing') return null

  const errorTitleKey =
    errorPhase === 'download'
      ? 'updater.downloadFailed'
      : errorPhase === 'install'
        ? 'updater.installFailed'
        : 'updater.checkFailed'

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 bg-bg-elevated border border-border rounded-xl shadow-lg overflow-hidden">
      {status === 'downloading' && (
        <div className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw size={14} className="text-accent-primary animate-spin" />
            <span className="text-xs font-semibold">
              {t('updater.downloading', { percent: Math.round(progress.percent) })}
            </span>
          </div>
          <div className="w-full h-1.5 bg-bg-subtle rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-primary rounded-full transition-all duration-300"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {status === 'downloaded' && (
        <div className="p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-accent-primary">
              {t('updater.downloaded', { version })}
            </span>
            <button
              onClick={onDismiss}
              aria-label={t('updater.dismiss')}
              className="text-fg-muted hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
          <p className="text-xs text-fg-secondary mb-3">{t('updater.restartHint')}</p>
          <button
            onClick={onInstall}
            className="w-full px-3 py-1.5 text-xs bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover"
          >
            {t('updater.restart')}
          </button>
        </div>
      )}

      {status === 'installing' && (
        <div className="p-4">
          <div className="flex items-center gap-2 mb-1">
            <RotateCw size={14} className="text-accent-primary animate-spin" />
            <span className="text-xs font-semibold text-accent-primary">
              {t('updater.installing')}
            </span>
          </div>
          <p className="text-xs text-fg-secondary">{t('updater.installingHint')}</p>
        </div>
      )}

      {status === 'error' && (
        <div className="p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <AlertCircle size={14} className="text-red-500" />
              <span className="text-xs font-semibold text-red-500">
                {t(errorTitleKey)}
              </span>
            </div>
            <button
              onClick={onDismiss}
              aria-label={t('updater.dismiss')}
              className="text-fg-muted hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
          <p
            className="text-xs text-fg-secondary mb-3 line-clamp-3"
            title={errorMessage}
          >
            {errorMessage}
          </p>
          <button
            onClick={onRetry}
            className="w-full px-3 py-1.5 text-xs bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover"
          >
            {t('updater.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
