import { useState, useCallback, useEffect } from 'react'
import { GitBranch, GitCommit, FileDiff, FileText, Loader2, Plus, Minus, Sparkles } from 'lucide-react'
import type { GitStatusResult, GitRemote } from '../../shared/types'
import { useGitStageAll, useGitCommitAndPush } from '../hooks/useBuddy'
import { useT } from '../hooks/useI18n'
import { useLanguage } from '../hooks/useI18n'
import { api } from '../lib/api'

interface FileStatusProps {
  gitStatus: GitStatusResult | null | undefined
  isLoading: boolean
  repoRoot: string | null
  onOpenCommit: () => void
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

  const totalInsertions = (gitStatus.diff?.insertions ?? 0) + (gitStatus.staged?.insertions ?? 0)
  const totalDeletions = (gitStatus.diff?.deletions ?? 0) + (gitStatus.staged?.deletions ?? 0)
  const totalFiles = (gitStatus.diff?.filesChanged ?? 0) + (gitStatus.staged?.filesChanged ?? 0)
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
  const [selectedRemote, setSelectedRemote] = useState<string>(
    gitStatus?.remotes[0]?.name ?? 'origin'
  )

  const stageAll = useGitStageAll()
  const commitAndPush = useGitCommitAndPush()

  const totalInsertions = (gitStatus?.diff?.insertions ?? 0) + (gitStatus?.staged?.insertions ?? 0)
  const totalDeletions = (gitStatus?.diff?.deletions ?? 0) + (gitStatus?.staged?.deletions ?? 0)
  const totalFiles = (gitStatus?.diff?.filesChanged ?? 0) + (gitStatus?.staged?.filesChanged ?? 0)
  const hasUnstaged = (gitStatus?.diff?.filesChanged ?? 0) > 0
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
        remote: selectedRemote
      }) as { commitHash: string }
      onSuccess(t('git.commitSuccess', { remote: selectedRemote, hash: result.commitHash }))
    } catch (e) {
      onError(t('git.commitFailed', { message: e instanceof Error ? e.message : String(e) }))
    } finally {
      setIsCommitting(false)
    }
  }, [message, repoRoot, selectedRemote, hasUnstaged, stageAll, commitAndPush, onSuccess, onError, t])

  const isBusy = isStaging || isGenerating || isCommitting

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elevated rounded-xl shadow-xl w-[480px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
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

          {/* diff 摘要 */}
          {(gitStatus?.diff?.summary || gitStatus?.staged?.summary) && (
            <pre className="text-xs text-fg-secondary bg-bg-subtle rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono">
              {gitStatus?.staged?.summary || gitStatus?.diff?.summary}
            </pre>
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
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={6}
              placeholder={isGenerating ? t('git.generating') : t('git.commitMessagePlaceholder')}
              disabled={isGenerating}
              className={`w-full px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-xs resize-none ${isGenerating ? 'opacity-60' : ''}`}
            />
          </div>
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isBusy}
            className="px-4 py-1.5 text-xs text-fg hover:bg-bg-subtle rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleCommit}
            disabled={!message.trim() || isBusy}
            className="px-4 py-1.5 text-xs bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {isCommitting && <Loader2 size={12} className="animate-spin" />}
            {isCommitting ? t('git.committing') : t('git.commit')}
          </button>
        </div>
      </div>
    </div>
  )
}
