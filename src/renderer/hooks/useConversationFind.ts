import { useCallback, useEffect, useState } from 'react'
import {
  applyConversationHighlights,
  clearConversationHighlights,
  findConversationRanges,
  scrollConversationRangeIntoView
} from '../lib/conversation-search'

interface ConversationFindState {
  ranges: Range[]
  activeIndex: number
}

const EMPTY_STATE: ConversationFindState = { ranges: [], activeIndex: -1 }

export function useConversationFind(
  scope: HTMLElement | null,
  query: string,
  enabled: boolean
) {
  const [state, setState] = useState<ConversationFindState>(EMPTY_STATE)

  useEffect(() => {
    let cancelled = false
    let scheduled = false

    if (!enabled || !scope || query.trim().length === 0) {
      setState(EMPTY_STATE)
      clearConversationHighlights()
      return () => {
        cancelled = true
        clearConversationHighlights()
      }
    }

    const recompute = (resetActive: boolean) => {
      if (cancelled) return
      const ranges = findConversationRanges(scope, query)
      setState((previous) => ({
        ranges,
        activeIndex: ranges.length === 0
          ? -1
          : resetActive
            ? 0
            : Math.min(Math.max(previous.activeIndex, 0), ranges.length - 1)
      }))
    }

    recompute(true)
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        recompute(false)
      })
    })
    observer.observe(scope, { childList: true, subtree: true, characterData: true })

    return () => {
      cancelled = true
      observer.disconnect()
      clearConversationHighlights()
    }
  }, [enabled, query, scope])

  useEffect(() => {
    if (!enabled) {
      clearConversationHighlights()
      return
    }
    applyConversationHighlights(state.ranges, state.activeIndex)
    scrollConversationRangeIntoView(state.ranges[state.activeIndex])
  }, [enabled, state])

  useEffect(() => () => clearConversationHighlights(), [])

  const move = useCallback((delta: number) => {
    setState((previous) => {
      if (previous.ranges.length === 0) return previous
      const activeIndex = (
        previous.activeIndex + delta + previous.ranges.length
      ) % previous.ranges.length
      return { ...previous, activeIndex }
    })
  }, [])

  return {
    total: state.ranges.length,
    active: state.activeIndex >= 0 ? state.activeIndex + 1 : 0,
    findNext: () => move(1),
    findPrevious: () => move(-1)
  }
}
