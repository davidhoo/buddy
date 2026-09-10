import { describe, expect, it } from 'vitest'
import { appendActorStreamLine } from '../../../src/renderer/lib/actor-stream'

describe('appendActorStreamLine', () => {
  it('concatenates only explicit delta chunks, including repeated characters', () => {
    let lines = appendActorStreamLine([], { text: '哈', ts: '1', mode: 'delta' })
    lines = appendActorStreamLine(lines, { text: '哈', ts: '2', mode: 'delta' })
    lines = appendActorStreamLine(lines, { text: '啊', ts: '3', mode: 'delta' })
    expect(lines).toEqual([{ text: '哈哈啊', ts: '3', mode: 'delta' }])
  })

  it('keeps non-delta lines independent so other actors are unchanged', () => {
    let lines = appendActorStreamLine([], { text: 'first', ts: '1', mode: 'line' })
    lines = appendActorStreamLine(lines, { text: 'second', ts: '2', mode: 'line' })
    expect(lines).toEqual([
      { text: 'first', ts: '1', mode: 'line' },
      { text: 'second', ts: '2', mode: 'line' }
    ])
  })

  it('starts a new delta row after a tool/status line', () => {
    let lines = appendActorStreamLine([], { text: '前文', ts: '1', mode: 'delta' })
    lines = appendActorStreamLine(lines, { text: '🔧 read a.ts (started)', ts: '2', mode: 'line' })
    lines = appendActorStreamLine(lines, { text: '后文', ts: '3', mode: 'delta' })
    expect(lines).toEqual([
      { text: '前文', ts: '1', mode: 'delta' },
      { text: '🔧 read a.ts (started)', ts: '2', mode: 'line' },
      { text: '后文', ts: '3', mode: 'delta' }
    ])
  })

  it('defaults unmarked chunks to independent rows', () => {
    let lines = appendActorStreamLine([], { text: 'a', ts: '1' })
    lines = appendActorStreamLine(lines, { text: 'b', ts: '2' })
    expect(lines).toEqual([
      { text: 'a', ts: '1', mode: 'line' },
      { text: 'b', ts: '2', mode: 'line' }
    ])
  })
})
