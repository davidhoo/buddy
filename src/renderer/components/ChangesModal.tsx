import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FileDiff, Loader2, Minus, Plus } from 'lucide-react'
import type { GitFileStatus, GitStatusResult } from '../../shared/types'
import { useT } from '../hooks/useI18n'
import { api } from '../lib/api'
import { FileStatusBadge } from './FileStatus'

interface ChangesModalProps {
  gitStatus: GitStatusResult
  repoRoot: string
  onClose: () => void
}

/** 过滤掉 diff 头部行(diff --git / index / --- / +++ 等),只保留 hunk 内容 */
function diffBodyLines(diff: string): string[] {
  return diff.split('\n').filter((line) => {
    if (line.startsWith('diff --git')) return false
    if (line.startsWith('index ')) return false
    if (line.startsWith('new file mode')) return false
    if (line.startsWith('deleted file mode')) return false
    if (line.startsWith('--- ')) return false
    if (line.startsWith('+++ ')) return false
    if (line.startsWith('Binary files')) return false
    return true
  })
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('@@')) {
    return <div className="px-5 py-0.5 text-accent-primary bg-accent-primary/5 whitespace-pre">{line}</div>
  }
  if (line.startsWith('+')) {
    return <div className="px-5 py-0 text-success-fg bg-success-bg/40 whitespace-pre-wrap break-all">{line}</div>
  }
  if (line.startsWith('-')) {
    return <div className="px-5 py-0 text-danger bg-danger/10 whitespace-pre-wrap break-all">{line}</div>
  }
  return <div className="px-5 py-0 text-fg-secondary whitespace-pre-wrap break-all">{line || ' '}</div>
}

function FileDiffView({ repoRoot, filePath }: { repoRoot: string; filePath: string }) {
  const t = useT()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['gitFileDiff', repoRoot, filePath],
    queryFn: () => api.gitFileDiff(repoRoot, filePath) as Promise<string>,
    staleTime: 10_000
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-5 py-3 text-xs text-fg-muted">
        <Loader2 size={12} className="animate-spin" />
        {t('common.loading')}
      </div>
    )
  }
  if (isError) {
    return <div className="px-5 py-3 text-xs text-danger">{t('git.diffError')}</div>
  }
  const lines = data ? diffBodyLines(data) : []
  if (!lines.length) {
    return <div className="px-5 py-3 text-xs text-fg-muted">{t('git.diffEmpty')}</div>
  }
  return (
    <div className="max-h-80 overflow-y-auto font-mono text-[11px] leading-relaxed border-t border-border bg-bg">
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
    </div>
  )
}

function FileDrawer({
  file,
  repoRoot,
  expanded,
  onToggle
}: {
  file: GitFileStatus
  repoRoot: string
  expanded: boolean
  onToggle: () => void
}) {
  const t = useT()
  const [wasExpanded, setWasExpanded] = useState(expanded)
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(0)

  // Keep content mounted once expanded (for smooth collapse animation)
  useEffect(() => {
    if (expanded) setWasExpanded(true)
  }, [expanded])

  // Measure actual content height so max-height transitions smoothly
  useEffect(() => {
    const el = contentRef.current
    if (!el || !wasExpanded) return
    const ro = new ResizeObserver(() => {
      setContentHeight(el.scrollHeight)
    })
    ro.observe(el)
    setContentHeight(el.scrollHeight)
    return () => ro.disconnect()
  }, [wasExpanded])

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-5 py-2 text-xs hover:bg-bg-subtle transition-colors text-left"
      >
        <ChevronRight
          size={13}
          className={`text-fg-muted flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <FileStatusBadge status={file.status} t={t} />
        <span className="font-mono text-fg-secondary truncate min-w-0" title={file.path}>
          {file.path}
        </span>
        <span className="ml-auto flex items-center gap-1.5 flex-shrink-0 font-mono">
          {file.insertions > 0 && <span className="text-success-fg">+{file.insertions}</span>}
          {file.deletions > 0 && <span className="text-danger">-{file.deletions}</span>}
        </span>
      </button>
      <div
        className="transition-[max-height] duration-300 ease-in-out overflow-hidden"
        style={{ maxHeight: expanded ? contentHeight || 400 : 0 }}
      >
        <div ref={contentRef}>
          {wasExpanded && <FileDiffView repoRoot={repoRoot} filePath={file.path} />}
        </div>
      </div>
    </div>
  )
}

export function ChangesModal({ gitStatus, repoRoot, onClose }: ChangesModalProps) {
  const t = useT()
  const [expandedFile, setExpandedFile] = useState<string | null>(null)

  const files = gitStatus.files ?? []
  const totalInsertions = files.reduce((s, f) => s + f.insertions, 0)
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0)

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

  const toggle = (path: string) => {
    setExpandedFile((prev) => (prev === path ? null : path))
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-buddy-modal
      onClick={onClose}
    >
      <div
        className="bg-bg-elevated rounded-xl shadow-xl w-[760px] max-w-[90vw] max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <FileDiff size={15} className="text-fg-muted" />
            {t('git.changesTitle')}
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-subtle text-fg-secondary"
          >
            ×
          </button>
        </div>

        {/* 摘要 */}
        <div className="px-5 py-2.5 border-b border-border flex items-center gap-3 text-xs text-fg-secondary">
          <span>{t('git.filesChanged', { n: files.length })}</span>
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
        </div>

        {/* 文件抽屉列表 */}
        <div className="flex-1 overflow-y-auto">
          {files.length === 0 ? (
            <div className="px-5 py-8 text-center text-xs text-fg-muted">{t('git.noChanges')}</div>
          ) : (
            files.map((f) => (
              <FileDrawer
                key={f.path}
                file={f}
                repoRoot={repoRoot}
                expanded={expandedFile === f.path}
                onToggle={() => toggle(f.path)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
