import { describe, expect, it } from 'vitest'
import {
  extractActorOutput,
  parseActorLine,
  parseBuddyMessage,
  parseClaudeStreamLine,
  parseCodexJsonLine,
  parseCursorStreamLine,
  parseJsonlBuffer
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

  it('parses Cursor Agent stream-json text and session IDs', () => {
    const event = parseCursorStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '{"type":"chat","content":"cursor done"}' }]
      },
      session_id: 'cursor-session'
    }))

    expect(event).toMatchObject({
      text: '{"type":"chat","content":"cursor done"}',
      sessionId: 'cursor-session',
      rawType: 'assistant'
    })
  })

  it('skips duplicate Cursor partial-stream flushes and prefers terminal result output', () => {
    const duplicate = parseCursorStreamLine(JSON.stringify({
      type: 'assistant',
      timestamp_ms: 100,
      model_call_id: 'call-1',
      message: { content: [{ type: 'text', text: 'duplicate' }] },
      session_id: 'cursor-session'
    }), true)
    const finalFlush = parseCursorStreamLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'final duplicate' }] },
      session_id: 'cursor-session'
    }), true)
    const output = extractActorOutput('cursor', [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-session', model: 'Composer 2.5' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'intermediate' }] }, session_id: 'cursor-session' }),
      JSON.stringify({ type: 'result', result: '{"type":"break","content":"finished"}', session_id: 'cursor-session' })
    ].join('\n'))

    expect(duplicate).toMatchObject({ noise: true, sessionId: 'cursor-session' })
    expect(duplicate.text).toBeUndefined()
    expect(finalFlush).toMatchObject({ noise: true, sessionId: 'cursor-session' })
    expect(output).toBe('{"type":"break","content":"finished"}')
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

  it('extracts buddy messages from OpenCode tool_use output (echo commands)', () => {
    const output = extractActorOutput('opencode', [
      JSON.stringify({ type: 'text', sessionID: 's1', part: { type: 'text', text: 'Task done.' } }),
      JSON.stringify({ type: 'tool_use', sessionID: 's1', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: "echo '{\"type\": \"break\", \"content\": \"All done.\"}'" }, output: '{"type": "break", "content": "All done."}' } } }),
    ].join('\n'))
    const message = parseBuddyMessage(output)

    expect(message).toEqual({ kind: 'break', content: 'All done.' })
  })

  it('extracts buddy messages from OpenCode tool_use when text events have no buddy JSON', () => {
    const output = extractActorOutput('opencode', [
      JSON.stringify({ type: 'text', sessionID: 's1', part: { type: 'text', text: 'I will signal completion.' } }),
      JSON.stringify({ type: 'tool_use', sessionID: 's1', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: "echo hi" }, output: '{"type": "break", "content": "Done."}' } } }),
      JSON.stringify({ type: 'text', sessionID: 's1', part: { type: 'text', text: 'Echo command executed.' } }),
    ].join('\n'))
    const message = parseBuddyMessage(output)

    expect(message.kind).toBe('break')
  })

  it('streams buddy messages from OpenCode tool_use events', () => {
    const event = parseActorLine('opencode', JSON.stringify({
      type: 'tool_use',
      sessionID: 's1',
      part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: "echo break" }, output: '{"type": "break", "content": "Done."}' } }
    }))

    expect(event.text).toContain('"type": "break"')
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

  it('extracts session ID from kimi session.resume_hint meta event', () => {
    expect(parseActorLine('kimi', JSON.stringify({
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'session_f811580a-d17e-4e01-b900-92048f4b1455',
      command: 'kimi -r session_f811580a-d17e-4e01-b900-92048f4b1455',
      content: 'To resume this session: kimi -r session_f811580a-d17e-4e01-b900-92048f4b1455'
    }))).toMatchObject({
      sessionId: 'session_f811580a-d17e-4e01-b900-92048f4b1455',
      text: undefined
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

  it('preserves markdown content from buddy JSON envelopes', () => {
    const markdown = '## Summary\n\n- Updated `src/main`\n- Kept transcript JSONL compatible\n'
    const message = parseBuddyMessage(JSON.stringify({ type: 'chat', content: markdown }))

    expect(message).toEqual({
      kind: 'message',
      text: markdown
    })
  })

  it('loosely extracts markdown content with unescaped quotes like buddy-python', () => {
    const message = parseBuddyMessage('```json\n{"type": "chat", "content": "## 结果\n\n这是一段包含"引号"的 markdown"}\n```')

    expect(message).toEqual({
      kind: 'message',
      text: '## 结果\n\n这是一段包含"引号"的 markdown'
    })
  })

  it('extracts buddy JSON preceded by preamble text', () => {
    const text = '所有测试通过，类型检查通过。让我总结一下所做的更改。\n{"type": "chat", "content": "## Changes Made\n\n### Root Cause\nThe error was fixed."}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: '## Changes Made\n\n### Root Cause\nThe error was fixed.'
    })
  })

  it('extracts buddy JSON with unescaped content after preamble', () => {
    const text = 'Preamble text here. {"type": "chat", "content": "Hello world"}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: 'Hello world'
    })
  })

  it('extracts break message from JSON with preamble', () => {
    const text = 'Task complete. {"type": "break", "content": "All done"}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'break',
      content: 'All done'
    })
  })

  it('extracts content with inline code containing brace-like patterns', () => {
    const text = '{"type": "chat", "content": "The fix uses `spawn kimi ENOENT` error handling in launchers.ts"}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: 'The fix uses `spawn kimi ENOENT` error handling in launchers.ts'
    })
  })

  it('extracts multiline content with code blocks containing braces', () => {
    const text = '{"type": "chat", "content": "## Changes\\n\\n```json\\n{\\"key\\": \\"value\\"}\\n```\\n\\nAll done."}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: '## Changes\n\n```json\n{"key": "value"}\n```\n\nAll done.'
    })
  })

  it('extracts content containing quote-brace pattern inside backticks', () => {
    const text = '{"type": "chat", "content": "Example closing: `"} at the end"}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: 'Example closing: `"} at the end'
    })
  })

  it('extracts buddy JSON from escaped JSON in preamble', () => {
    const text = 'Preamble \\"type\\": \\"chat\\" but real message: {"type": "chat", "content": "Working fix"}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: 'Working fix'
    })
  })

  it('handles fully escaped JSON embedded in text', () => {
    const text = 'Summary: {\\"type\\": \\"chat\\", \\"content\\": \\"All tests pass\\"}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: 'All tests pass'
    })
  })

  it('extracts long multiline content with preamble intact', () => {
    const text = 'Summary text here.\\n{"type": "chat", "content": "## Changes Made\\n\\n### Root Cause\\nThe `spawn kimi ENOENT` error occurs.\\n\\n### Files Changed\\n- file1.ts\\n- file2.ts\\n\\n### Verification\\nAll tests pass."}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: '## Changes Made\n\n### Root Cause\nThe `spawn kimi ENOENT` error occurs.\n\n### Files Changed\n- file1.ts\n- file2.ts\n\n### Verification\nAll tests pass.'
    })
  })

  it('handles valid JSON after preamble without quotes in preamble', () => {
    const text = 'Done. Here is the summary.\\n\\n{"type": "chat", "content": "Summary text."}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: 'Summary text.'
    })
  })

  it('extracts content when buddy JSON has actual newlines in content value', () => {
    const text = '所有修改看起来都正确。现在我将输出伙伴协议消息。\n{"type": "chat", "content": "## Changes Summary\n\n### Fix 1: Kimi ENOENT error\n\nThe error was fixed.\n- file1.ts\n- file2.ts\n\nAll tests pass."}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: '## Changes Summary\n\n### Fix 1: Kimi ENOENT error\n\nThe error was fixed.\n- file1.ts\n- file2.ts\n\nAll tests pass.'
    })
  })

  it('extracts content with actual newlines and inline code backticks', () => {
    const text = 'Preamble.\n{"type": "chat", "content": "The `kimi` binary was not found in PATH.\n\nInstall with `pip install kimi-cli`."}'
    const message = parseBuddyMessage(text)

    expect(message).toEqual({
      kind: 'message',
      text: 'The `kimi` binary was not found in PATH.\n\nInstall with `pip install kimi-cli`.'
    })
  })

  it('end-to-end: Claude stream-json with preamble + buddy JSON', () => {
    // Simulate what extractClaudeOutput produces when Claude outputs:
    // "All tests pass. Let me summarize.\n\n{"type": "chat", "content": "## Changes\n\n### Fix 1..."}"
    const streamEvents = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: '所有修改看起来都正确。现在我将输出伙伴协议消息。\n\n{"type": "chat", "content": "## Changes Summary\\n\\n### Fix 1: Kimi ENOENT error\\n\\nAll tests pass."}'
          }]
        }
      })
    ].join('\n')
    const outputText = extractActorOutput('claude', streamEvents)
    const message = parseBuddyMessage(outputText)

    expect(message.kind).toBe('message')
    if (message.kind === 'message') {
      expect(message.text).not.toContain('"type"')
      expect(message.text).not.toContain('"content"')
      expect(message.text).toContain('## Changes Summary')
      expect(message.text).toContain('All tests pass.')
    }
  })

  it('end-to-end: Claude output with actual newlines in buddy JSON content', () => {
    // When Claude outputs buddy JSON with actual newlines (not \n escapes) in the content value,
    // the JSON is invalid. The loose extractor should still handle it.
    const streamEvents = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: '所有修改看起来都正确。现在我将输出伙伴协议消息。\n\n{"type": "chat", "content": "## Changes Summary\n\n### Fix 1: Kimi ENOENT error\n\nAll tests pass."}'
          }]
        }
      })
    ].join('\n')
    const outputText = extractActorOutput('claude', streamEvents)
    const message = parseBuddyMessage(outputText)

    expect(message.kind).toBe('message')
    if (message.kind === 'message') {
      expect(message.text).not.toContain('"type"')
      expect(message.text).not.toContain('"content"')
      expect(message.text).toContain('## Changes Summary')
    }
  })

  it('end-to-end: Claude output with preamble on same line as JSON', () => {
    // Preamble + JSON on the same line (no newline between)
    const streamEvents = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: '所有修改看起来都正确。现在我将输出伙伴协议消息。{"type": "chat", "content": "## Changes Summary\\n\\nAll tests pass."}'
          }]
        }
      })
    ].join('\n')
    const outputText = extractActorOutput('claude', streamEvents)
    const message = parseBuddyMessage(outputText)

    expect(message.kind).toBe('message')
    if (message.kind === 'message') {
      expect(message.text).not.toContain('"type"')
      expect(message.text).not.toContain('"content"')
      expect(message.text).toContain('## Changes Summary')
    }
  })

  it('extracts content with unescaped quotes in content (actual newlines in JSON)', () => {
    // When Claude outputs buddy JSON with actual newlines AND unescaped " in content,
    // the JSON is invalid but loose extractor should still find the content
    const text = '所有修改看起来都正确。\n{"type": "chat", "content": "Run `echo "$PATH"` to check.\n\nAll done."}'
    const message = parseBuddyMessage(text)

    expect(message.kind).toBe('message')
    if (message.kind === 'message') {
      expect(message.text).toContain('Run')
      expect(message.text).toContain('All done.')
    }
  })

  it('real-world: preamble + buddy JSON with long markdown content', () => {
    const content = '## Changes Summary\\n\\n### Fix 1: Kimi ENOENT error\\n\\n**Root cause**: macOS GUI apps don\'t inherit the user\'s shell PATH.\\n\\n**Files changed:**\\n- **`src/main/buddy/shell-path.ts`** (new)\\n- **`src/main/index.ts`**\\n- **`src/main/buddy/launchers.ts`**\\n\\n### Tests\\n- All 151 tests pass, typecheck clean, build succeeds'
    const streamEvents = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text: '所有修改看起来都正确。现在我将输出伙伴协议消息。\n\n{"type": "chat", "content": "' + content + '"}'
          }]
        }
      })
    ].join('\n')
    const outputText = extractActorOutput('claude', streamEvents)
    const message = parseBuddyMessage(outputText)

    expect(message.kind).toBe('message')
    if (message.kind === 'message') {
      expect(message.text).not.toContain('"type"')
      expect(message.text).not.toContain('"content"')
      expect(message.text).toContain('## Changes Summary')
      expect(message.text).toContain('shell-path.ts')
      expect(message.text).toContain('151 tests pass')
    }
  })

  it('real-world: preamble with buddy JSON that has actual newlines in raw text', () => {
    const rawText = '所有修改看起来都正确。现在我将输出伙伴协议消息。\n{"type": "chat", "content": "## Changes Summary\\n\\nFix 1: Kimi ENOENT error (original task)"}'
    const message = parseBuddyMessage(rawText)

    expect(message.kind).toBe('message')
    if (message.kind === 'message') {
      expect(message.text).not.toContain('"type"')
      expect(message.text).not.toContain('"content"')
      expect(message.text).toContain('## Changes Summary')
      expect(message.text).toContain('Kimi ENOENT')
    }
  })

  it('real-world: chinese preamble with buddy JSON, newlines escaped as literal backslash-n', () => {
    const rawText = '所有修改看起来都正确。现在我将输出伙伴协议消息。\\n\\n{\\"type\\": \\"chat\\", \\"content\\": \\"## Changes Summary\\n\\nFix 1: Kimi ENOENT error (original task)\\"}'
    const message = parseBuddyMessage(rawText)

    expect(message.kind).toBe('message')
    if (message.kind === 'message') {
      expect(message.text).not.toContain('"type"')
      expect(message.text).not.toContain('"content"')
      expect(message.text).toContain('## Changes Summary')
      expect(message.text).toContain('Kimi ENOENT')
    }
  })

  describe('parseJsonlBuffer recovery from broken events', () => {
    it('recovers valid events after a broken JSON event', () => {
      // Simulate Claude stream-json where a tool_result event has
      // control characters that break JSON parsing, followed by valid events
      const broken = '{"type":"user","message":{"content":[{"type":"tool_result","content":"diff with\ttab"}]}}'
      const valid1 = '{"type":"assistant","message":{"content":[{"type":"text","text":"Done!"}]}}'
      const valid2 = '{"type":"result","result":"Done!","session_id":"s1"}'

      const raw = [broken, valid1, valid2].join('\n')
      const events = parseJsonlBuffer(raw)

      // Should parse at least the valid events after the broken one
      expect(events.length).toBeGreaterThanOrEqual(2)
      expect(events.some(e => e.type === 'assistant')).toBe(true)
      expect(events.some(e => e.type === 'result')).toBe(true)
    })

    it('recovers result event when tool_result has raw newlines', () => {
      // This simulates the real-world bug: a user event with tool_result
      // containing a diff with raw control chars breaks JSON parsing,
      // and the result event that follows is lost
      const brokenEvent = '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"tu_1","type":"tool_result","content":"diff --git a/file.ts b/file.ts\nindex abc..def\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n line1\n+line2\n line3"}]}}'
      const assistantEvent = '{"type":"assistant","message":{"content":[{"type":"text","text":"Based on the diff, here is my conclusion."}]}}'
      const resultEvent = '{"type":"result","subtype":"success","result":"Based on the diff, here is my conclusion.","session_id":"sess1"}'

      const raw = brokenEvent + '\n' + assistantEvent + '\n' + resultEvent
      const events = parseJsonlBuffer(raw)

      // The broken event may or may not parse, but the valid events MUST be recovered
      expect(events.some(e => e.type === 'assistant')).toBe(true)
      expect(events.some(e => e.type === 'result')).toBe(true)

      const resultEventParsed = events.find(e => e.type === 'result')
      expect(resultEventParsed?.result).toBe('Based on the diff, here is my conclusion.')
    })

    it('preserves normal JSONL parsing when no broken events', () => {
      const raw = [
        '{"type":"system","subtype":"init","session_id":"s1"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
        '{"type":"result","result":"hello"}'
      ].join('\n')
      const events = parseJsonlBuffer(raw)

      expect(events).toHaveLength(3)
      expect(events[0].type).toBe('system')
      expect(events[1].type).toBe('assistant')
      expect(events[2].type).toBe('result')
    })
  })

  describe('parseBuddyMessage with preamble containing tool_result content', () => {
    it('extracts buddy JSON when tool_result content appears before it', () => {
      // When extractClaudeOutput fails (e.g., broken events) and the fallback
      // parsedText includes raw tool_result content with "content":" keys,
      // looseExtractBuddyMessage must find "content":" relative to the
      // buddy JSON's "type":"chat" match, not the tool_result's "content" key
      const toolResultContent = '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"tu_1","type":"tool_result","content":"diff output here"}]}}'
      const buddyJson = '{"type":"chat","content":"My conclusion after review."}'
      const text = toolResultContent + '\n' + buddyJson

      const message = parseBuddyMessage(text)

      expect(message).toEqual({
        kind: 'message',
        text: 'My conclusion after review.'
      })
    })

    it('extracts buddy JSON from fallback parsedText with raw tool_result and diff content', () => {
      // Simulates the real fallback path: extractClaudeOutput returns empty,
      // parsedText includes raw broken events + assistant text with buddy JSON
      const brokenLine1 = '{"type":"user","message":{"content":[{"type":"tool_result","content":"diff --git a/parsers.ts b/parsers.ts"}'
      const brokenLine2 = 'more diff content with "content":" keys inside'
      const assistantText = 'Here is my analysis.\n{"type":"chat","content":"Fixed the parsing bug."}'

      const text = [brokenLine1, brokenLine2, assistantText].join('\n')
      const message = parseBuddyMessage(text)

      expect(message).toEqual({
        kind: 'message',
        text: 'Fixed the parsing bug.'
      })
    })

    it('end-to-end: Claude stream with broken tool_result event', () => {
      // Full simulation of the real-world bug:
      // 1. Claude uses a tool (git diff), the tool_result has raw control chars
      // 2. The result event is recovered by parseJsonlBuffer fix
      // 3. extractClaudeOutput returns the correct text
      // 4. parseBuddyMessage extracts the buddy content
      const brokenEvent = '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"tu_1","type":"tool_result","content":"diff --git a/file.ts b/file.ts\nindex abc..def\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n line1\n+added\n line3"}]}}'
      const assistantEvent = '{"type":"assistant","message":{"content":[{"type":"text","text":"Based on the diff:\\n\\n{"type":"chat","content":"## Changes\\n\\n1. Added new line to file.ts\\n\\nAll tests pass."}"}]}}'
      const resultEvent = '{"type":"result","subtype":"success","result":"Based on the diff:\\n\\n{\\"type\\":\\"chat\\",\\"content\\":\\"## Changes\\\\n\\\\n1. Added new line to file.ts\\\\n\\\\nAll tests pass.\\"}","session_id":"sess1"}'

      const raw = [
        '{"type":"system","subtype":"init","session_id":"sess1"}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"git diff"}}]}}',
        brokenEvent,
        assistantEvent,
        resultEvent
      ].join('\n')

      const extracted = extractActorOutput('claude', raw)
      const message = parseBuddyMessage(extracted)

      expect(message.kind).toBe('message')
      if (message.kind === 'message') {
        expect(message.text).not.toContain('diff --git')
        expect(message.text).not.toContain('"type"')
        expect(message.text).toContain('## Changes')
        expect(message.text).toContain('All tests pass.')
      }
    })
  })
})
