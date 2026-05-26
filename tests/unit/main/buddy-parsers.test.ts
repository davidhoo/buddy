import { describe, expect, it } from 'vitest'
import {
  extractActorOutput,
  parseActorLine,
  parseBuddyMessage,
  parseClaudeStreamLine,
  parseCodexJsonLine
} from '../../../src/main/buddy/parsers'

describe('buddy actor parsers', () => {
  it('extracts text from Claude stream-json content blocks', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }]
      },
      session_id: 'claude-session'
    }))

    expect(event).toMatchObject({
      text: 'hello',
      sessionId: 'claude-session'
    })
  })

  it('extracts text from Codex json lines', () => {
    const event = parseCodexJsonLine(JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
      thread_id: 'codex-thread'
    }))

    expect(event).toMatchObject({
      text: 'done',
      threadId: 'codex-thread'
    })
  })

  it('extracts text from current Codex item.completed agent messages', () => {
    const event = parseCodexJsonLine(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '{"type":"chat","content":"review complete"}'
      }
    }))

    expect(event).toMatchObject({
      text: '{"type":"chat","content":"review complete"}'
    })
  })

  it('extracts OpenCode session IDs and text chunks while ignoring reasoning', () => {
    const session = parseActorLine('opencode', JSON.stringify({
      type: 'step_start',
      sessionID: 'opencode-session',
      part: { type: 'step-start' }
    }))
    const text = parseActorLine('opencode', JSON.stringify({
      type: 'text',
      sessionID: 'opencode-session',
      part: { type: 'text', text: 'Hello' }
    }))
    const reasoning = extractActorOutput('opencode', JSON.stringify({
      type: 'reasoning',
      sessionID: 'opencode-session',
      part: { type: 'reasoning', text: 'hidden' }
    }))

    expect(session).toMatchObject({ sessionId: 'opencode-session' })
    expect(text).toMatchObject({ sessionId: 'opencode-session', text: 'Hello' })
    expect(reasoning).toBe('')
  })

  it('keeps OpenCode JSON chunks adjacent when extracting output', () => {
    const output = extractActorOutput('opencode', [
      JSON.stringify({ type: 'text', sessionID: 's1', part: { type: 'text', text: '{"type":"ch' } }),
      JSON.stringify({ type: 'text', sessionID: 's1', part: { type: 'text', text: 'at","content":"hi"}' } })
    ].join('\n'))

    expect(output).toBe('{"type":"chat","content":"hi"}')
  })

  it('keeps only the last Kimi assistant content when extracting output', () => {
    const output = extractActorOutput('kimi', [
      JSON.stringify({ role: 'assistant', content: '{"type":"chat","content":"Part one"}' }),
      JSON.stringify({ role: 'tool', content: 'tool result' }),
      JSON.stringify({ role: 'assistant', content: '{"type":"chat","content":"Part two"}' })
    ].join('\n'))

    expect(output).toBe('{"type":"chat","content":"Part two"}')
  })

  it('extracts stable sessions from buddy.session events', () => {
    expect(parseActorLine('kimi', JSON.stringify({
      type: 'buddy.session',
      actor: 'kimi',
      session_id: 'kimi-session'
    }))).toMatchObject({
      sessionId: 'kimi-session'
    })
  })

  it('detects break messages', () => {
    expect(parseBuddyMessage('type=break\nreason=done')).toMatchObject({
      kind: 'break',
      reason: 'done'
    })
  })

  it('unwraps buddy JSON chat and break envelopes', () => {
    expect(parseBuddyMessage('```json\n{"type":"chat","content":"hello"}\n```')).toMatchObject({
      kind: 'message',
      text: 'hello'
    })
    expect(parseBuddyMessage('{"type":"break","content":"done"}')).toMatchObject({
      kind: 'break',
      content: 'done'
    })
  })
})
