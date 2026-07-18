import { useEffect, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { useT } from '../hooks/useI18n'
import { useConversationFind } from '../hooks/useConversationFind'

interface FindBarProps {
  open: boolean
  activation: number
  scope: HTMLElement | null
  scopeKey: string | null
  onClose: () => void
}

export function FindBar({ open, activation, scope, scopeKey, onClose }: FindBarProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  const { total, active, findNext, findPrevious } = useConversationFind(scope, query, open, scopeKey)

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      wasOpenRef.current = true
    } else if (!open && wasOpenRef.current) {
      const previous = previouslyFocusedRef.current
      if (previous?.isConnected) previous.focus()
      previouslyFocusedRef.current = null
      wasOpenRef.current = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [activation, open])

  useEffect(() => () => {
    if (wasOpenRef.current) {
      const previous = previouslyFocusedRef.current
      if (previous?.isConnected) previous.focus()
      previouslyFocusedRef.current = null
      wasOpenRef.current = false
    }
  }, [])

  if (!open) return null

  const hasQuery = query.trim().length > 0
  const counter = hasQuery
    ? (total > 0
        ? `${active}/${total}`
        : t('find.noResults'))
    : ''
  const counterLabel = total > 0
    ? t('find.matches', { active, total })
    : counter

  return (
    <div
      role="search"
      aria-label={t('find.label')}
      className="absolute top-3 right-6 z-20 flex items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-2 py-1.5 shadow-lg focus-within:border-accent"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        aria-label={t('find.label')}
        aria-controls="buddy-conversation-transcript"
        placeholder={t('find.placeholder')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) findPrevious()
            else findNext()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        className="w-48 bg-transparent px-1.5 py-0.5 text-sm outline-none placeholder:text-fg-muted"
      />
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={counterLabel}
        className="min-w-[3rem] text-right text-xs tabular-nums text-fg-secondary"
      >
        {counter}
      </span>
      <button
        type="button"
        onClick={findPrevious}
        disabled={total === 0}
        aria-label={t('find.previous')}
        title={t('find.previous')}
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={findNext}
        disabled={total === 0}
        aria-label={t('find.next')}
        title={t('find.next')}
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('find.close')}
        title={t('find.close')}
        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <X size={14} />
      </button>
    </div>
  )
}
