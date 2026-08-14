import { useState, useCallback, useEffect } from 'react'
import { Upload, Loader2, AlertCircle, CheckCircle2, ChevronDown } from 'lucide-react'
import type { GitStatusResult, GitRemote, GitPushAvailability } from '../../shared/types'
import { useGitPushAvailability, useGitPush } from '../hooks/useBuddy'
import { useT } from '../hooks/useI18n'
import { useQueryClient } from '@tanstack/react-query'

interface PushModalProps {
  gitStatus: GitStatusResult
  repoRoot: string
  initialRemote: string
  onClose: () => void
  onSuccess: (message: string) => void
  onError: (message: string) => void
}

export function PushModal({ gitStatus, repoRoot, initialRemote, onClose, onSuccess, onError }: PushModalProps) {
  const t = useT()
  const [selectedRemote, setSelectedRemote] = useState(initialRemote)
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<'pushed' | 'failed' | null>(null)
  const [pushError, setPushError] = useState('')
  const branch = gitStatus.branch
  const remotes = gitStatus.remotes ?? []
  const upstream = gitStatus.upstream

  const availability = useGitPushAvailability(repoRoot, selectedRemote, branch, !!selectedRemote && !!branch)
  const avail = availability.data
  const canPush = avail?.state === 'ahead' || avail?.state === 'new_branch'

  const pushMutation = useGitPush()
  const queryClient = useQueryClient()

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

  useEffect(() => {
    if (selectedRemote) {
      try { localStorage.setItem('buddy.lastRemote.' + repoRoot, selectedRemote) } catch { /* ignore */ }
    }
  }, [selectedRemote, repoRoot])

  const handleRemoteChange = useCallback((remote: string) => {
    setSelectedRemote(remote)
    setPushResult(null)
    setPushError('')
  }, [])

  const handleRetry = useCallback(() => {
    setPushResult(null)
    setPushError('')
    availability.refetch()
  }, [availability])

  const handlePush = useCallback(async () => {
    if (!selectedRemote) return
    setPushing(true)
    setPushResult(null)
    setPushError('')
    try {
      await queryClient.invalidateQueries({ queryKey: ['gitPushAvailability'] })
      const latest = queryClient.getQueryData<GitPushAvailability>(['gitPushAvailability', repoRoot, selectedRemote, branch])
      if (!latest || (latest.state !== 'ahead' && latest.state !== 'new_branch')) {
        setPushing(false)
        return
      }
      const result = await pushMutation.mutateAsync({ repoRoot, remote: selectedRemote })
      if (result.pushStatus === 'pushed') {
        setPushResult('pushed')
        onSuccess(t('git.pushSuccess', { remote: selectedRemote }))
        onClose()
      } else {
        setPushResult('failed')
        setPushError(result.pushError ?? '')
        onError(t('git.pushFailed', { remote: selectedRemote, message: result.pushError ?? '' }))
      }
    } catch (e) {
      setPushResult('failed')
      const msg = e instanceof Error ? e.message : String(e)
      setPushError(msg)
      onError(t('git.pushFailed', { remote: selectedRemote, message: msg }))
    } finally {
      setPushing(false)
    }
  }, [selectedRemote, repoRoot, branch, pushMutation, queryClient, t, onSuccess, onError, onClose])

  const isBusy = pushing || availability.isLoading

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-buddy-modal
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div
        className="bg-bg-elevated rounded-xl shadow-xl w-[480px] max-h-[85vh] flex flex-col"
        tabIndex={-1}
      >
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('git.pushPending')}</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-subtle text-fg-secondary"
          >
            <span>×</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {remotes.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs font-medium text-fg-secondary flex-shrink-0">{t('git.remote')}</label>
              <div className="relative flex-1 min-w-0">
                <select
                  value={selectedRemote}
                  onChange={(e) => handleRemoteChange(e.target.value)}
                  className="w-full appearance-none px-3 pr-9 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-xs"
                >
                  {remotes.map((r: GitRemote) => {
                    const label = upstream && upstream.remote === r.name
                      ? r.name + ' (' + upstream.remote + '/' + upstream.branch + ')'
                      : r.name
                    return <option key={r.name} value={r.name}>{label}</option>
                  })}
                </select>
                <ChevronDown
                  size={14}
                  className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-fg-muted"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            {availability.isLoading && !availability.isError && (
              <div className="flex items-center gap-2 text-xs text-fg-muted">
                <Loader2 size={14} className="animate-spin flex-shrink-0" />
                <span>{t('git.pushChecking')}</span>
              </div>
            )}

            {availability.isError && (
              <div className="flex items-center gap-2 text-xs text-danger bg-danger/10 rounded-lg p-3">
                <AlertCircle size={14} className="flex-shrink-0" />
                <span className="truncate min-w-0">{t('git.pushCheckFailed')}</span>
                <button
                  onClick={handleRetry}
                  className="ml-auto flex-shrink-0 text-fg-muted hover:text-fg underline"
                >
                  {t('common.retry')}
                </button>
              </div>
            )}

            {avail && !availability.isLoading && !availability.isError && (
              <div className="text-xs space-y-1">
                {avail.state === 'ahead' && (
                  <div className="flex items-center gap-2 text-fg-secondary">
                    <CheckCircle2 size={14} className="text-success-fg flex-shrink-0" />
                    <span>{t('git.pushAhead', { n: avail.ahead })}</span>
                  </div>
                )}
                {avail.state === 'new_branch' && (
                  <div className="flex items-center gap-2 text-fg-secondary">
                    <CheckCircle2 size={14} className="text-success-fg flex-shrink-0" />
                    <span>{t('git.pushNewBranch')}</span>
                  </div>
                )}
                {avail.state === 'up_to_date' && (
                  <div className="flex items-center gap-2 text-fg-muted">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <span>{t('git.pushUpToDate')}</span>
                  </div>
                )}
                {avail.state === 'behind' && (
                  <div className="flex items-center gap-2 text-fg-muted">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <span>{t('git.pushBehind', { n: avail.behind })}</span>
                  </div>
                )}
                {avail.state === 'diverged' && (
                  <div className="flex items-center gap-2 text-fg-muted">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <span>{t('git.pushDiverged')}</span>
                  </div>
                )}
                {avail.state === 'unavailable' && (
                  <div className="flex items-center gap-2 text-fg-muted">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    <span>{t('git.pushPending')}</span>
                  </div>
                )}
                {avail.branch && (
                  <div className="text-fg-muted pl-6">{avail.remote}/{avail.branch}</div>
                )}
              </div>
            )}

            {pushResult === 'pushed' && (
              <div className="flex items-center gap-2 text-xs text-success-fg bg-success-bg/50 rounded-lg p-3">
                <CheckCircle2 size={14} className="flex-shrink-0" />
                <span>{t('git.pushSuccess', { remote: selectedRemote })}</span>
              </div>
            )}
            {pushResult === 'failed' && (
              <div className="flex items-center gap-2 text-xs text-danger bg-danger/10 rounded-lg p-3">
                <AlertCircle size={14} className="flex-shrink-0" />
                <span className="truncate min-w-0">{t('git.pushFailed', { remote: selectedRemote, message: pushError })}</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <span />
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs text-fg hover:bg-bg-subtle rounded-lg transition-colors flex items-center gap-1"
            >
              {t('common.cancel')} <span className="opacity-60">esc</span>
            </button>
            <button
              onClick={handlePush}
              disabled={!canPush || isBusy}
              className="px-4 py-1.5 text-xs bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {(pushing || availability.isLoading) && <Loader2 size={12} className="animate-spin" />}
              {t('git.pushNow')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
