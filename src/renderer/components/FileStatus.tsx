import { useState, useCallback, useEffect, useRef } from 'react'
import { GitBranch, GitCommit, FileDiff, FileText, Loader2, Plus, Minus, Sparkles, Upload } from 'lucide-react'
import type { GitStatusResult, GitFileStatusCode, GitRemote } from '../../shared/types'
import { useGitStageAll, useGitCommitAndPush } from '../hooks/useBuddy'
import { useT, type TFunction } from '../hooks/useI18n'
import { useLanguage } from '../hooks/useI18n'
import { api } from '../lib/api'

interface FileStatusProps {
  gitStatus: GitStatusResult | null | undefined
  isLoading: boolean
  repoRoot: string | null
  onOpenCommit: () => void
}

function FileStatusBadge({ status, t }: { status: GitFileStatusCode; t: TFunction }) {
  const config: Record<GitFileStatusCode, { label: string; cls: string }> = {
    M: { label: t('git.statusModified'), cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    A: { label: t('git.statusAdded'), cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    D: { label: t('git.statusDeleted'), cls: 'bg-red-500/15 text-red-600 dark:text-red-400' },
    R: { label: t('git.statusRenamed'), cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
    C: { label: t('git.statusCopied'), cls: 'bg-purple-500/15 text-purple-600 dark:text-purple-400' },
    U: { label: t('git.statusUnmerged'), cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
    '?': { label: t('git.statusUntracked'), cls: 'bg-gray-500/15 text-gray-600 dark:text-gray-400' },
  }
  const { label, cls } = config[status]
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${cls}`}>{label}</span>
}

export function FileStatus({ gitStatus, isLoading, repoRoot, onOpenCommit }: FileStatusProps) {
  const t = useT()

  if (!repoRoot) return null

  if (isLoading || !gitStatus) {
    return (
      <details open className="border-b border-border">
        <summary className="px-4 py-3 text-sm font-semibold cursor-pointer flex items-center justify-between hover:bg-bg-subtle select-none">
          <span>{t('git.fileStatus')}</span>
          <span className="text-xs font-normal text-fg-secondary">{t('common.collapse')}</span>
        </summary>
        <div className="px-4 pb-3 text-xs text-fg-muted">{t('common.loading')}</div>
      </details>
    )
  }

  if (!gitStatus.branch) {
    return (
      <details open className="border-b border-border">
        <summary className="px-4 py-3 text-sm font-semibold cursor-pointer flex items-center justify-between hover:bg-bg-subtle select-none">
          <span>{t('git.fileStatus')}</span>
          <span className="text-xs font-normal text-fg-secondary">{t('common.collapse')}</span>
        </summary>
        <div className="px-4 pb-3 text-xs text-fg-muted">{t('git.noRepo')}</div>
      </details>
    )
  }

  const totalInsertions = (gitStatus.files ?? []).reduce((s, f) => s + f.insertions, 0)
  const totalDeletions = (gitStatus.files ?? []).reduce((s, f) => s + f.deletions, 0)
  const totalFiles = (gitStatus.files ?? []).length || ((gitStatus.diff?.filesChanged ?? 0) + (gitStatus.staged?.filesChanged ?? 0) + gitStatus.untracked)
  const hasChanges = totalFiles > 0

  return (
    <details open className="border-b border-border">
      <summary className="px-4 py-3 text-sm font-semibold cursor-pointer flex items-center justify-between hover:bg-bg-subtle select-none">
        <span>{t('git.fileStatus')}</span>
        <span className="text-xs font-normal text-fg-secondary">{t('common.collapse')}</span>
      </summary>
      <div className="px-4 pb-3 space-y-0.5">
        {/* 变更 */}
        <div className="flex items-center gap-2 text-xs rounded-md px-2.5 py-1.5 hover:bg-bg-subtle transition-colors">
          <FileDiff size={13} className="text-fg-muted flex-shrink-0" />
          <span className="text-fg-secondary flex-shrink-0">{t('git.changes')}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {hasChanges ? (
              <>
                <span>{t('git.filesChanged', { n: totalFiles })}</span>
                {totalInsertions > 0 && <span className="text-success-fg">{t('git.insertions', { n: totalInsertions })}</span>}
                {totalDeletions > 0 && <span className="text-danger">{t('git.deletions', { n: totalDeletions })}</span>}
              </>
            ) : (
              <span className="text-fg-muted">{t('git.noChanges')}</span>
            )}
          </span>
        </div>

        {/* 分支 */}
        <div className="flex items-center gap-2 text-xs rounded-md px-2.5 py-1.5 hover:bg-bg-subtle transition-colors">
          <GitBranch size={13} className="text-fg-muted flex-shrink-0" />
          <span className="text-fg-secondary flex-shrink-0">{t('git.branch')}</span>
          <span className="ml-auto truncate">{gitStatus.branch}</span>
        </div>

        {/* 提交 */}
        <button
          onClick={onOpenCommit}
          disabled={!hasChanges}
          className="flex items-center gap-2 text-xs rounded-md px-2.5 py-1.5 w-full hover:bg-bg-subtle transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-left"
        >
          <GitCommit size={13} className="text-fg-muted flex-shrink-0" />
          <span className="text-fg-secondary flex-shrink-0">{t('git.commit')}</span>
          <span className="ml-auto text-accent-primary">{t('git.commit')}</span>
        </button>
      </div>
    </details>
  )
}

interface CommitModalProps {
  gitStatus: GitStatusResult | null
  repoRoot: string
  onClose: () => void
  onSuccess: (message: string) => void
  onError: (message: string) => void
}

export function CommitModal({ gitStatus, repoRoot, onClose, onSuccess, onError }: CommitModalProps) {
  const t = useT()
  const lang = useLanguage()
  const [message, setMessage] = useState('')
  const [isGenerating, setIsGenerating] = useState(true)
  const [isStaging, setIsStaging] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [selectedRemote, setSelectedRemote] = useState<string>(() => {
    const remoteNames = gitStatus?.remotes.map((r: GitRemote) => r.name) ?? []
    const stored = (() => {
      try { return localStorage.getItem(`buddy.lastRemote.${repoRoot}`) } catch { return null }
    })()
    if (stored && remoteNames.includes(stored)) return stored
    return remoteNames[0] ?? 'origin'
  })
  const hasRemotes = (gitStatus?.remotes.length ?? 0) > 0
  const [shouldPush, setShouldPush] = useState(hasRemotes)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const stageAll = useGitStageAll()
  const commitAndPush = useGitCommitAndPush()

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

  const totalInsertions = (gitStatus?.files ?? []).reduce((s, f) => s + f.insertions, 0)
  const totalDeletions = (gitStatus?.files ?? []).reduce((s, f) => s + f.deletions, 0)
  const totalFiles = (gitStatus?.files ?? []).length || ((gitStatus?.diff?.filesChanged ?? 0) + (gitStatus?.staged?.filesChanged ?? 0) + (gitStatus?.untracked ?? 0))
  const hasUnstaged = (gitStatus?.diff?.filesChanged ?? 0) > 0 || (gitStatus?.untracked ?? 0) > 0
  const hasStaged = (gitStatus?.staged?.filesChanged ?? 0) > 0

  const handleStageAll = useCallback(async () => {
    setIsStaging(true)
    try {
      await stageAll.mutateAsync(repoRoot)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsStaging(false)
    }
  }, [repoRoot, stageAll, onError])

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true)
    try {
      const result = await api.generateCommitMessage(repoRoot, undefined, lang)
      if (result) setMessage(result)
    } catch {
      // fallback
    } finally {
      setIsGenerating(false)
    }
  }, [repoRoot, lang])

  // 打开时自动生成
  useEffect(() => {
    handleGenerate()
  }, [handleGenerate])

  useEffect(() => {
    if (!isGenerating) {
      textareaRef.current?.focus()
    }
  }, [isGenerating])

  const handleCommit = useCallback(async () => {
    if (!message.trim()) return
    setIsCommitting(true)
    try {
      if (hasUnstaged) {
        await stageAll.mutateAsync(repoRoot)
      }
      const result = await commitAndPush.mutateAsync({
        repoRoot,
        message: message.trim(),
        remote: selectedRemote,
        push: shouldPush
      }) as { commitHash: string }
      onSuccess(shouldPush
        ? t('git.commitSuccess', { remote: selectedRemote, hash: result.commitHash })
        : t('git.commitOnlySuccess', { hash: result.commitHash })
      )
    } catch (e) {
      onError(t('git.commitFailed', { message: e instanceof Error ? e.message : String(e) }))
    } finally {
      setIsCommitting(false)
    }
  }, [message, repoRoot, selectedRemote, shouldPush, hasUnstaged, stageAll, commitAndPush, onSuccess, onError, t])

  // Persist last-used remote for this repo
  useEffect(() => {
    if (selectedRemote) {
      try { localStorage.setItem(`buddy.lastRemote.${repoRoot}`, selectedRemote) } catch {}
    }
  }, [selectedRemote, repoRoot])

  const isBusy = isStaging || isGenerating || isCommitting

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-buddy-modal
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && message.trim() && !isBusy) {
          e.preventDefault()
          e.stopPropagation()
          handleCommit()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div
        className="bg-bg-elevated rounded-xl shadow-xl w-[640px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('git.commitTitle')}</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-subtle text-fg-secondary"
          >
            ×
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* 变更摘要 */}
          <div className="flex items-center gap-3 text-xs">
            <FileText size={14} className="text-fg-muted" />
            <span>{t('git.filesChanged', { n: totalFiles })}</span>
            {totalInsertions > 0 && (
              <span className="text-success-fg flex items-center gap-0.5">
                <Plus size={12} />{totalInsertions}
              </span>
            )}
            {totalDeletions > 0 && (
              <span className="text-danger flex items-center gap-0.5">
                <Minus size={12} />{totalDeletions}
              </span>
            )}
            {hasUnstaged && (
              <button
                onClick={handleStageAll}
                disabled={isBusy}
                className="ml-auto px-2 py-0.5 text-xs border border-border rounded hover:bg-bg-subtle disabled:opacity-50"
              >
                {isStaging ? t('common.loading') : t('git.stageAll')}
              </button>
            )}
            {hasStaged && !hasUnstaged && (
              <span className="ml-auto text-fg-muted">{t('git.stageAll')} ✓</span>
            )}
          </div>

          {/* 文件列表 */}
          {gitStatus && gitStatus.files && gitStatus.files.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="max-h-52 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0">
                    <tr className="bg-bg-subtle text-fg-secondary">
                      <th className="px-3 py-1.5 text-left font-medium w-20">{t('git.statusColumn')}</th>
                      <th className="px-3 py-1.5 text-left font-medium">{t('git.fileColumn')}</th>
                      <th className="px-2 py-1.5 text-center font-medium" colSpan={2}>+/-</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gitStatus.files.map((f) => (
                      <tr key={f.path} className="border-t border-border hover:bg-bg-subtle transition-colors">
                        <td className="px-3 py-1.5">
                          <FileStatusBadge status={f.status} t={t} />
                        </td>
                        <td className="px-3 py-1.5 font-mono text-fg-secondary truncate max-w-[320px]" title={f.path}>
                          {f.path}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-success-fg whitespace-nowrap">
                          {f.insertions > 0 ? `+${f.insertions}` : ''}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-danger whitespace-nowrap">
                          {f.deletions > 0 ? `-${f.deletions}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 远端选择 */}
          {gitStatus && gitStatus.remotes.length > 1 && (
            <div>
              <label className="block text-xs font-medium text-fg-secondary mb-1">{t('git.remote')}</label>
              <select
                value={selectedRemote}
                onChange={(e) => setSelectedRemote(e.target.value)}
                className="w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg text-xs"
              >
                {gitStatus.remotes.map((r: GitRemote) => (
                  <option key={r.name} value={r.name}>{r.name} ({r.url})</option>
                ))}
              </select>
            </div>
          )}

          {/* 提交信息 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-fg-secondary">{t('git.commitMessage')}</label>
              <button
                onClick={handleGenerate}
                disabled={isBusy}
                className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover disabled:opacity-50"
              >
                {isGenerating ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Sparkles size={12} />
                )}
                {t('git.generateMessage')}
              </button>
            </div>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  e.stopPropagation()
                  if (message.trim() && !isBusy) {
                    handleCommit()
                  }
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  onClose()
                }
              }}
              rows={6}
              placeholder={isGenerating ? t('git.generating') : t('git.commitMessagePlaceholder')}
              disabled={isGenerating}
              className={`w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-xs resize-none ${isGenerating ? 'opacity-60' : ''}`}
            />
          </div>
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={shouldPush}
              onChange={(e) => setShouldPush(e.target.checked)}
              disabled={!hasRemotes}
              className="accent-accent-primary"
            />
            <Upload size={13} className="text-fg-muted" />
            <span className="text-fg-secondary">{t('git.push')}</span>
            {!hasRemotes && (
              <span className="text-fg-muted ml-1">({t('git.noRemote')})</span>
            )}
          </label>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs text-fg hover:bg-bg-subtle rounded-lg transition-colors flex items-center gap-1"
            >
              {t('common.cancel')} <span className="opacity-60">⎋</span>
            </button>
          <button
            onClick={handleCommit}
            disabled={!message.trim() || isBusy}
            className="px-4 py-1.5 text-xs bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {isCommitting && <Loader2 size={12} className="animate-spin" />}
            {isCommitting ? t('git.committing') : shouldPush ? t('git.commitTitle') : t('git.commit')} <span className="opacity-60">⌘⏎</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
