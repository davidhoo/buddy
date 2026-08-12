import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TaskStats, TranscriptEntry } from '../../../src/shared/types'

const mocks = vi.hoisted(() => ({
  useTaskStats: vi.fn()
}))

vi.mock('../../../src/renderer/hooks/useBuddy', () => ({
  useRoundEvents: vi.fn(),
  useTaskStats: mocks.useTaskStats
}))

import { MessageBubble } from '../../../src/renderer/components/MessageBubble'

function stats(inputTokens: number): TaskStats {
  return {
    actors: [{
      actor: 'cursor',
      model: 'Auto',
      inputTokens,
      outputTokens: 20_685,
      cacheReadTokens: 1_108_736,
      durationMs: 206_420,
      rounds: 4
    }],
    totalInputTokens: inputTokens,
    totalOutputTokens: 20_685,
    totalCacheReadTokens: 1_108_736,
    totalDurationMs: 206_420,
    totalRounds: 4
  }
}

describe('MessageBubble completed task stats', () => {
  it('uses recomputed task stats instead of the persisted completion snapshot', () => {
    mocks.useTaskStats.mockReturnValue({ data: stats(72_425) })
    const entry: TranscriptEntry = {
      role: 'system',
      content: 'Cursor 和 Codex 均确认任务完成，任务结束。',
      ts: '2026-08-11T10:57:57.000Z',
      meta: {
        kind: 'round_notice',
        done_reason: 'dual_break_confirmed',
        stats: stats(0)
      }
    }

    const html = renderToStaticMarkup(
      <MessageBubble
        entry={entry}
        taskId="demo"
        workspaceKey="workspace-a"
      />
    )

    expect(mocks.useTaskStats).toHaveBeenCalledWith('demo', 'workspace-a')
    expect(html).toContain('72,425')
    expect(html).toContain('1,108,736')
  })

  it('falls back to the persisted snapshot when recomputation has no data', () => {
    mocks.useTaskStats.mockReturnValue({ data: null })
    const entry: TranscriptEntry = {
      role: 'system',
      content: '任务结束。',
      ts: '2026-08-11T10:57:57.000Z',
      meta: {
        kind: 'round_notice',
        done_reason: 'dual_break_confirmed',
        stats: stats(123)
      }
    }

    const html = renderToStaticMarkup(<MessageBubble entry={entry} />)

    expect(html).toContain('123')
  })
})
