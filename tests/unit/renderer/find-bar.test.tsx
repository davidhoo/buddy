// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { FindBar } from '../../../src/renderer/components/FindBar'
import {
  CONVERSATION_ACTIVE_HIGHLIGHT,
  CONVERSATION_MATCH_HIGHLIGHT
} from '../../../src/renderer/lib/conversation-search'

class FakeHighlight {
  readonly ranges: AbstractRange[]

  constructor(...ranges: AbstractRange[]) {
    this.ranges = ranges
  }
}

describe('FindBar', () => {
  const highlights = new Map<string, FakeHighlight>()

  beforeEach(() => {
    window.localStorage.setItem('buddy.language', 'en')
    highlights.clear()
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', FakeHighlight)
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('navigates scoped matches, reacts to mutations, and cleans up', async () => {
    const scope = document.createElement('div')
    scope.innerHTML = `
      <div data-conversation-search-segment>first needle</div>
      <div data-conversation-search-segment>second needle</div>
      <div>needle outside the searchable segments</div>
    `
    document.body.appendChild(scope)
    const onClose = vi.fn()
    const { rerender, unmount } = render(
      <FindBar open activation={1} scope={scope} onClose={onClose} />
    )

    const input = screen.getByRole('textbox', { name: 'Find in conversation' }) as HTMLInputElement
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'needle' } })

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1/2'))
    expect(highlights.get(CONVERSATION_MATCH_HIGHLIGHT)?.ranges).toHaveLength(2)
    expect(highlights.get(CONVERSATION_ACTIVE_HIGHLIGHT)?.ranges).toHaveLength(1)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('status')).toHaveTextContent('2/2')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('1/2')
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(screen.getByRole('status')).toHaveTextContent('2/2')

    const added = document.createElement('div')
    added.dataset.conversationSearchSegment = ''
    added.textContent = 'third needle'
    scope.appendChild(added)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2/3'))

    input.setSelectionRange(2, 2)
    rerender(<FindBar open activation={2} scope={scope} onClose={onClose} />)
    expect(input).toHaveFocus()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    unmount()
    expect(highlights.has(CONVERSATION_MATCH_HIGHLIGHT)).toBe(false)
    expect(highlights.has(CONVERSATION_ACTIVE_HIGHLIGHT)).toBe(false)
  })

  it('keeps button activation independent and restores prior focus on close', async () => {
    const previous = document.createElement('button')
    previous.textContent = 'previous focus'
    document.body.appendChild(previous)
    previous.focus()

    const scope = document.createElement('div')
    scope.innerHTML = '<div data-conversation-search-segment>needle needle</div>'
    document.body.appendChild(scope)
    const onClose = vi.fn()
    const { rerender } = render(
      <FindBar open activation={1} scope={scope} onClose={onClose} />
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'needle' } })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1/2'))

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<FindBar open={false} activation={1} scope={scope} onClose={onClose} />)
    expect(previous).toHaveFocus()
  })
})
