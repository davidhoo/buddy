import { describe, expect, it } from 'vitest'
import { parseEventLine, parseTaskState } from '../../../src/main/buddy/schemas'

describe('buddy schemas', () => {
  it('parses task state with optional fields', () => {
    const state = parseTaskState({
      status: 'READY',
      round: 1,
      next_actor: 'claude',
      active_run: null
    })

    expect(state.status).toBe('READY')
    expect(state.round).toBe(1)
  })

  it('accepts legacy nullable state fields', () => {
    const state = parseTaskState({
      status: 'PAUSED',
      round: 0,
      next_actor: 'claude',
      countdown: null,
      active_run: null,
      claude_session_id: null,
      codex_thread_id: null,
      opencode_session_id: null,
      kimi_session_id: null
    })

    expect(state.status).toBe('PAUSED')
    expect(state.countdown).toBeUndefined()
    expect(state.claude_session_id).toBeUndefined()
  })

  it('accepts legacy countdown objects without remaining seconds', () => {
    const state = parseTaskState({
      status: 'DONE',
      round: 1,
      next_actor: 'claude',
      active_run: null,
      countdown: {
        after_actor: 'codex',
        deadline: '2026-05-22T11:12:52Z',
        default_next_actor: 'claude',
        started_at: '2026-05-22T11:12:22Z',
        status: 'elapsed'
      }
    })

    expect(state.countdown?.remaining).toBe(0)
    expect(state.countdown?.default_next_actor).toBe('claude')
  })

  it('parses event json lines', () => {
    const event = parseEventLine('{"seq":1,"type":"task.created","ts":"2026-05-26T00:00:00.000Z","payload":{}}')

    expect(event.seq).toBe(1)
    expect(event.type).toBe('task.created')
  })

  it('rejects malformed event json lines', () => {
    expect(() => parseEventLine('{bad')).toThrow()
  })
})
