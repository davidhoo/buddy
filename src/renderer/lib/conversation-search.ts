export const CONVERSATION_MATCH_HIGHLIGHT = 'buddy-find-match'
export const CONVERSATION_ACTIVE_HIGHLIGHT = 'buddy-find-active'

const SEGMENT_SELECTOR = '[data-conversation-search-segment]'
const BLOCK_ELEMENTS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'SUMMARY', 'TABLE', 'TR', 'UL'
])

interface TextSpan {
  node: Text
  start: number
  end: number
}

interface IndexedSegment {
  text: string
  spans: TextSpan[]
}

function indexSegment(segment: Element): IndexedSegment {
  let text = ''
  const spans: TextSpan[] = []

  const appendBoundary = () => {
    if (text && !text.endsWith('\n')) text += '\n'
  }

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? ''
      if (!value) return
      const start = text.length
      text += value
      spans.push({ node: node as Text, start, end: text.length })
      return
    }
    if (!(node instanceof Element)) return
    const style = getComputedStyle(node)
    if (
      node.matches('script, style, template, noscript, [hidden], [aria-hidden="true"], [data-conversation-search-exclude]')
      || style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || style.contentVisibility === 'hidden'
      || style.opacity === '0'
    ) return

    const isBoundary = node !== segment && (node.tagName === 'BR' || BLOCK_ELEMENTS.has(node.tagName))
    if (isBoundary) appendBoundary()
    if (node.tagName === 'DETAILS' && !node.hasAttribute('open')) {
      const summary = Array.from(node.children).find((child) => child.tagName === 'SUMMARY')
      if (summary) visit(summary)
    } else {
      for (const child of node.childNodes) visit(child)
    }
    if (isBoundary) appendBoundary()
  }

  visit(segment)
  return { text, spans }
}

function spanAt(spans: TextSpan[], offset: number): TextSpan | undefined {
  return spans.find((span) => offset >= span.start && offset < span.end)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findConversationRanges(root: Element, query: string): Range[] {
  if (!query || query.trim().length === 0) return []

  const pattern = new RegExp(escapeRegExp(query), 'giu')
  const ranges: Range[] = []
  const segments = Array.from(root.querySelectorAll(SEGMENT_SELECTOR)).filter((segment) => {
    const parentSegment = segment.parentElement?.closest(SEGMENT_SELECTOR)
    return !parentSegment || !root.contains(parentSegment)
  })

  for (const segment of segments) {
    const indexed = indexSegment(segment)
    pattern.lastIndex = 0
    for (const match of indexed.text.matchAll(pattern)) {
      const start = match.index
      const end = start + match[0].length
      if (end <= start) continue
      const startSpan = spanAt(indexed.spans, start)
      const endSpan = spanAt(indexed.spans, end - 1)
      if (!startSpan || !endSpan) continue

      const range = document.createRange()
      range.setStart(startSpan.node, start - startSpan.start)
      range.setEnd(endSpan.node, end - endSpan.start)
      ranges.push(range)
    }
  }

  return ranges
}

function supportsCustomHighlights(): boolean {
  return typeof CSS !== 'undefined'
    && !!CSS.highlights
    && typeof Highlight !== 'undefined'
}

export function applyConversationHighlights(ranges: Range[], activeIndex: number): void {
  clearConversationHighlights()
  if (!supportsCustomHighlights() || ranges.length === 0) return

  CSS.highlights.set(CONVERSATION_MATCH_HIGHLIGHT, new Highlight(...ranges))
  const activeRange = ranges[activeIndex]
  if (activeRange) {
    CSS.highlights.set(CONVERSATION_ACTIVE_HIGHLIGHT, new Highlight(activeRange))
  }
}

export function clearConversationHighlights(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  CSS.highlights.delete(CONVERSATION_MATCH_HIGHLIGHT)
  CSS.highlights.delete(CONVERSATION_ACTIVE_HIGHLIGHT)
}

export function scrollConversationRangeIntoView(range: Range | undefined): void {
  const element = range?.startContainer.parentElement
  if (element && typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  }
}
