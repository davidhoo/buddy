// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { findConversationRanges } from '../../../src/renderer/lib/conversation-search'

function rootWithHtml(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.replaceChildren(root)
  return root
}

describe('conversation-scoped search', () => {
  it('searches only marked conversation segments', () => {
    const root = rootWithHtml(`
      <div data-conversation-search-segment>needle in transcript</div>
      <div>needle in controls</div>
    `)

    const ranges = findConversationRanges(root, 'needle')

    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('needle')
  })

  it('matches case-insensitively for Latin text and supports CJK', () => {
    const root = rootWithHtml(`
      <div data-conversation-search-segment>Alpha ALPHA 中文查找 中文查找</div>
    `)

    expect(findConversationRanges(root, 'alpha')).toHaveLength(2)
    expect(findConversationRanges(root, '中文查找')).toHaveLength(2)
  })

  it('creates one range when a match spans inline elements', () => {
    const root = rootWithHtml(`
      <div data-conversation-search-segment>nee<strong>dle</strong> text</div>
    `)

    const ranges = findConversationRanges(root, 'needle')

    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('needle')
  })

  it('does not combine text across separate conversation messages', () => {
    const root = rootWithHtml(`
      <div data-conversation-search-segment>nee</div>
      <div data-conversation-search-segment>dle</div>
    `)

    expect(findConversationRanges(root, 'needle')).toHaveLength(0)
  })

  it('ignores hidden text and does not double-count nested markers', () => {
    const root = rootWithHtml(`
      <div data-conversation-search-segment>
        visible needle
        <span hidden>hidden needle</span>
        <span style="display: none">also hidden needle</span>
        <span style="visibility: collapse">collapsed needle</span>
        <span style="opacity: 0">transparent needle</span>
        <details>
          <summary>visible summary needle</summary>
          <span>closed details needle</span>
        </details>
        <span data-conversation-search-segment>nested needle</span>
      </div>
    `)

    const ranges = findConversationRanges(root, 'needle')

    expect(ranges).toHaveLength(3)
    expect(ranges.map((range) => range.toString())).toEqual(['needle', 'needle', 'needle'])
  })

  it('treats the query as literal text rather than a regular expression', () => {
    const root = rootWithHtml(`
      <div data-conversation-search-segment>Use a+b and aab.</div>
    `)

    const ranges = findConversationRanges(root, 'a+b')

    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('a+b')
  })
})
