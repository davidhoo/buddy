import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, GitBranch, Loader2, Plus } from 'lucide-react'
import { useT } from '../hooks/useI18n'
import { api } from '../lib/api'

interface BranchModalProps {
  repoRoot: string
  currentBranch: string
  onClose: () => void
}

export function BranchModal({ repoRoot, currentBranch, onClose }: BranchModalProps) {
  const t = useT()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [newBranch, setNewBranch] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)

  const { data: branches, isLoading } = useQuery({
    queryKey: ['gitBranches', repoRoot],
    queryFn: () => api.gitBranches(repoRoot),
    staleTime: 30_000
  })

  const handleSuccess = async () => {
    await queryClient.invalidateQueries({ queryKey: ['gitStatus'] })
    await queryClient.invalidateQueries({ queryKey: ['gitBranches', repoRoot] })
    onClose()
  }

  const checkout = useMutation({
    mutationFn: (branch: string) => api.gitCheckout(repoRoot, branch),
    onSuccess: handleSuccess,
    onError: (e) => {
      setError(e instanceof Error ? e.message : String(e))
      setSwitching(null)
    }
  })

  const createBranch = useMutation({
    mutationFn: (branch: string) => api.gitCreateBranch(repoRoot, branch),
    onSuccess: handleSuccess,
    onError: (e) => {
      setError(e instanceof Error ? e.message : String(e))
    }
  })

  const isBusy = checkout.isPending || createBranch.isPending

  // Escape 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleSelect = (branch: string) => {
    if (branch === currentBranch || isBusy) return
    setError(null)
    setSwitching(branch)
    checkout.mutate(branch)
  }

  const handleCreate = () => {
    const branch = newBranch.trim()
    if (!branch || isBusy) return
    setError(null)
    createBranch.mutate(branch)
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-buddy-modal
      onClick={onClose}
    >
      <div
        className="bg-bg-elevated rounded-xl shadow-xl w-[340px] max-w-[90vw] max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <GitBranch size={15} className="text-fg-muted" />
            {t('git.switchBranch')}
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-subtle text-fg-secondary"
          >
            ×
          </button>
        </div>

        {/* 报错 */}
        {error && (
          <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border border-danger bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
            <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed min-w-0">{error}</pre>
          </div>
        )}

        {/* 分支列表 */}
        <div className="flex-1 overflow-y-auto px-5">
          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-fg-muted">
              <Loader2 size={12} className="animate-spin" />
              {t('common.loading')}
            </div>
          ) : !branches || branches.length === 0 ? (
            <div className="py-4 text-xs text-fg-muted">{t('git.noBranches')}</div>
          ) : (
            branches.map((branch) => {
              const isCurrent = branch === currentBranch
              const isSwitching = switching === branch && checkout.isPending
              return (
                <button
                  key={branch}
                  onClick={() => handleSelect(branch)}
                  disabled={isCurrent || isBusy}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs rounded-md text-left transition-colors ${
                    isCurrent
                      ? 'text-fg font-medium bg-bg-subtle cursor-default'
                      : 'hover:bg-bg-subtle text-fg-secondary disabled:opacity-50'
                  }`}
                >
                  {isSwitching ? (
                    <Loader2 size={13} className="animate-spin flex-shrink-0" />
                  ) : isCurrent ? (
                    <Check size={13} className="text-success-fg flex-shrink-0" />
                  ) : (
                    <GitBranch size={13} className="text-fg-muted flex-shrink-0" />
                  )}
                  <span className="font-mono truncate" title={branch}>{branch}</span>
                  {isCurrent && (
                    <span className="ml-auto text-fg-muted flex-shrink-0">{t('git.currentBranch')}</span>
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* 创建新分支 */}
        <div className="border-t border-border px-5 py-2.5">
          {showCreateForm ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleCreate()
                  }
                }}
                placeholder={t('git.newBranchPlaceholder')}
                disabled={isBusy}
                autoFocus
                className="flex-1 min-w-0 px-3 py-1.5 border border-border rounded-lg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent bg-bg font-mono text-xs disabled:opacity-50"
              />
              <button
                onClick={handleCreate}
                disabled={!newBranch.trim() || isBusy}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent-primary text-fg-inverse rounded-lg hover:bg-accent-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
              >
                {createBranch.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                {t('git.createBranch')}
              </button>
              <button
                onClick={() => {
                  setShowCreateForm(false)
                  setNewBranch('')
                }}
                className="text-xs text-fg-muted hover:text-fg px-1 flex-shrink-0"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowCreateForm(true)}
              className="w-full flex items-center gap-2 py-1.5 text-xs text-fg-secondary hover:text-fg transition-colors rounded-md hover:bg-bg-subtle"
            >
              <Plus size={14} className="flex-shrink-0" />
              <span>{t('git.createNewBranch')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
