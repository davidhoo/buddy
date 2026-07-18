import { useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { useT } from '../hooks/useI18n'

interface FindBarProps {
  open: boolean
  onClose: () => void
}

interface FindResult {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

export function FindBar({ open, onClose }: FindBarProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ active: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Subscribe to native found-in-page results for the match counter.
  useEffect(() => {
    const cleanup = window.api.onFindResult((r: FindResult) => {
      setResult({ active: r.activeMatchOrdinal, total: r.matches })
    })
    return cleanup
  }, [])

  // Focus + select the input whenever the bar opens; stop any active search on close.
  // Intentionally keyed on `open` only — reuses the current query when reopened.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      inputRef.current?.select()
      if (query.trim()) window.api.findInPage(query, { findNext: false })
    } else {
      window.api.stopFindInPage('clearSelection')
      setResult(null)
    }
  }, [open])

  const runSearch = (text: string, opts?: { forward?: boolean; findNext?: boolean }) => {
    if (text.trim()) {
      window.api.findInPage(text, opts)
    } else {
      window.api.stopFindInPage('clearSelection')
      setResult(null)
    }
  }

  const handleChange = (value: string) => {
    setQuery(value)
    runSearch(value, { findNext: false })
  }

  const findNext = (forward: boolean) => {
    if (query.trim()) window.api.findInPage(query, { forward, findNext: true })
  }

  const close = () => {
    window.api.stopFindInPage('clearSelection')
    setResult(null)
    onClose()
  }

  if (!open) return null

  const hasQuery = query.trim().length > 0
  const counter = hasQuery
    ? (result && result.total > 0
        ? `${result.active}/${result.total}`
        : t('find.noResults'))
    : ''

  return (
    <div
      data-buddy-modal
      className="absolute top-3 right-6 z-20 flex items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-2 py-1.5 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          findNext(!e.shiftKey)
        }
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={t('find.placeholder')}
        onChange={(e) => handleChange(e.target.value)}
        className="w-48 bg-transparent px-1.5 py-0.5 text-sm outline-none placeholder:text-fg-muted"
      />
      <span className="min-w-[3rem] text-right text-xs tabular-nums text-fg-secondary">{counter}</span>
      <button
        type="button"
        onClick={() => findNext(false)}
        disabled={!hasQuery}
        title={t('find.previous')}
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-subtle disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={() => findNext(true)}
        disabled={!hasQuery}
        title={t('find.next')}
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-subtle disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        onClick={close}
        title={t('find.close')}
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-subtle"
      >
        <X size={14} />
      </button>
    </div>
  )
}
