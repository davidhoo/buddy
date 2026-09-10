import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RunningDetailPanel } from '../../../src/renderer/components/RunningStatusMessage'
import { appendActorStreamLine, type ActorStreamLine } from '../../../src/renderer/lib/actor-stream'
import { parseCursorStreamLine } from '../../../src/main/buddy/parsers'

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useT: () => (key: string) => key,
  useLanguage: () => 'zh-CN'
}))

function linesFromCursorEvents(events: unknown[]): ActorStreamLine[] {
  let lines: ActorStreamLine[] = []
  for (const event of events) {
    const parsed = parseCursorStreamLine(JSON.stringify(event))
    if (!parsed.text) continue
    lines = appendActorStreamLine(lines, {
      text: parsed.text,
      ts: String(lines.length + 1),
      mode: parsed.streamMode === 'delta' ? 'delta' : 'line'
    })
  }
  return lines
}

describe('RunningDetailPanel cursor stream display', () => {
  it('renders repeated Chinese deltas, whitespace, and tool-separated paragraphs as expected', () => {
    const streamLines = linesFromCursorEvents([
      { type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: '哈' }] } },
      { type: 'assistant', timestamp_ms: 2, message: { content: [{ type: 'text', text: '哈' }] } },
      { type: 'assistant', timestamp_ms: 3, message: { content: [{ type: 'text', text: '\n下一行 有空格' }] } },
      {
        type: 'tool_call',
        subtype: 'started',
        tool_call: { readToolCall: { args: { path: 'src/a.ts' } } }
      },
      { type: 'assistant', timestamp_ms: 4, message: { content: [{ type: 'text', text: '后文继续' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '哈哈\n下一行 有空格后文继续' }] } },
      { type: 'connection', subtype: 'reconnecting' }
    ])

    expect(streamLines.map((line) => line.text)).toEqual([
      '哈哈\n下一行 有空格',
      '🔧 read src/a.ts (started)',
      '后文继续',
      '⏳ reconnecting'
    ])

    const html = renderToStaticMarkup(
      <RunningDetailPanel actor="cursor" streamLines={streamLines} />
    )

    expect(html).toContain('running-detail-line')
    expect(html).toContain('哈哈\n下一行 有空格')
    expect(html).toContain('🔧 read src/a.ts (started)')
    expect(html).toContain('后文继续')
    expect(html).toContain('⏳ reconnecting')
    // Final flush duplicate must not appear as its own row.
    expect(html.match(/哈哈/g)?.length).toBe(1)
  })
})
