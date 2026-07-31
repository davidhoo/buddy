import { describe, expect, it } from 'vitest'
import { parseEventLine, parseTaskState, parseGlobalSettings } from '../../../src/main/buddy/schemas'

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

  it('parses buddy-python round window and context tracking fields', () => {
    const state = parseTaskState({
      status: 'READY',
      round: 0,
      rounds_in_window: 0,
      next_actor: 'opencode',
      context_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      context_sent: {
        claude: false,
        codex: true,
        opencode: false,
        kimi: false
      },
      active_run: null,
      last_error: {
        message: 'boom',
        actor: 'codex',
        run_id: 'run-1',
        ts: '2026-05-26T00:00:00.000Z',
        output_file: '/tmp/out.md',
        event_file: '/tmp/events.jsonl'
      }
    })

    expect(state.rounds_in_window).toBe(0)
    expect(state.context_sent?.codex).toBe(true)
    expect(state.last_error?.run_id).toBe('run-1')
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
    expect(state.countdown).toBeNull()
    expect(state.claude_session_id).toBeNull()
  })

  it('preserves buddy-python state fields', () => {
    const state = parseTaskState({
      protocol_version: '1',
      task_id: 'demo',
      repo_root: '/tmp/repo',
      status: 'READY',
      round: 0,
      rounds_in_window: 0,
      next_actor: 'claude',
      claude_session_id: null,
      codex_thread_id: null,
      context_hash: 'abc',
      context_sent: { claude: false, codex: false },
      active_run: null,
      countdown: null,
      last_error: null,
      event_seq: 1,
      transcript_seq: 0,
      consecutive_failures: 0,
      created_at: '2026-05-26T11:11:27Z',
      updated_at: '2026-05-26T11:11:27Z'
    })

    expect(state.task_id).toBe('demo')
    expect(state.rounds_in_window).toBe(0)
    expect(state.context_sent?.claude).toBe(false)
    expect(state.event_seq).toBe(1)
    expect(state.transcript_seq).toBe(0)
    expect(state.last_error).toBeNull()
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
    const event = parseEventLine('{"seq":1,"task_id":"demo","type":"task.created","ts":"2026-05-26T00:00:00.000Z","payload":{}}')

    expect(event.seq).toBe(1)
    expect(event.task_id).toBe('demo')
    expect(event.type).toBe('task.created')
  })

  it('rejects malformed event json lines', () => {
    expect(() => parseEventLine('{bad')).toThrow()
  })

  it('normalizes empty custom_prompt to undefined (global settings)', () => {
    const settings = parseGlobalSettings({ custom_prompt: '   ' })
    expect(settings.custom_prompt).toBeUndefined()

    const populated = parseGlobalSettings({ custom_prompt: 'Always run tests.' })
    expect(populated.custom_prompt).toBe('Always run tests.')
  })
})
