import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { isContextWindowLimitError } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('isContextWindowLimitError', () => {
  it('detects Claude context window limit error', () => {
    expect(isContextWindowLimitError('API Error: The model has reached its context window limit.')).toBe(true)
  })

  it('detects context length exceeded', () => {
    expect(isContextWindowLimitError('Error: context length exceeded')).toBe(true)
  })

  it('detects maximum context length', () => {
    expect(isContextWindowLimitError('This model maximum context length is 128000 tokens')).toBe(true)
  })

  it('detects token limit errors', () => {
    expect(isContextWindowLimitError('Token limit exceeded')).toBe(true)
    expect(isContextWindowLimitError('too many tokens in request')).toBe(true)
  })

  it('detects exceeds token errors', () => {
    expect(isContextWindowLimitError('Input exceeds token limit')).toBe(true)
    expect(isContextWindowLimitError('Request exceeded token limit')).toBe(true)
  })

  it('detects input too long', () => {
    expect(isContextWindowLimitError('Input too long for model')).toBe(true)
  })

  it('detects request too large', () => {
    expect(isContextWindowLimitError('Request too large')).toBe(true)
  })

  it('detects "likely context window exhausted" noise-events error (runner.ts:661)', () => {
    expect(isContextWindowLimitError('Actor exited with only noise events (likely context window exhausted)')).toBe(true)
  })

  it('detects "context window likely exhausted" degraded-response error (runner.ts:749)', () => {
    expect(isContextWindowLimitError('Actor produced only noise events (context window likely exhausted): ...')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isContextWindowLimitError('Connection refused')).toBe(false)
    expect(isContextWindowLimitError('Permission denied')).toBe(false)
    expect(isContextWindowLimitError('Actor exited with code 1')).toBe(false)
    expect(isContextWindowLimitError('Command not found')).toBe(false)
    expect(isContextWindowLimitError('')).toBe(false)
  })

  it('matches case-insensitively', () => {
    expect(isContextWindowLimitError('CONTEXT WINDOW LIMIT')).toBe(true)
    expect(isContextWindowLimitError('Context Length Exceeded')).toBe(true)
  })

  it('detects Chinese context limit errors', () => {
    // GLM error: "对话内容太长，已超出当前模型的处理能力"
    expect(isContextWindowLimitError('对话内容太长，已超出当前模型的处理能力。请新建对话，或换用支持更长上下文的模型继续。')).toBe(true)
    expect(isContextWindowLimitError('超出当前模型的处理能力')).toBe(true)
    expect(isContextWindowLimitError('上下文超限')).toBe(true)
    expect(isContextWindowLimitError('上下文超出限制')).toBe(true)
    expect(isContextWindowLimitError('超出模型的最大长度')).toBe(true)
    expect(isContextWindowLimitError('内容过长，请缩短输入')).toBe(true)
    // Full GLM error with JSON wrapper
    expect(isContextWindowLimitError('API Error: 400 {"error":{"message":"对话内容太长，已超出当前模型的处理能力。"},"type":"error"}')).toBe(true)
  })
})

describe('BuddyRunner context window limit handling', () => {
  it('detects context window limit error and resets session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-'))
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    // Set a session ID so session reset can be triggered
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'test-session-123'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    // Should have detected context limit
    const contextLimitEvent = detail.events.find((e) => e.type === 'actor.context_limit_detected')
    expect(contextLimitEvent).toBeDefined()
    expect(contextLimitEvent?.payload.error).toContain('context window limit')

    // Should NOT have compact events — we skip /compact entirely
    const compactSucceededEvent = detail.events.find((e) => e.type === 'actor.compact_succeeded')
    expect(compactSucceededEvent).toBeUndefined()
    const compactFailedEvent = detail.events.find((e) => e.type === 'actor.compact_failed')
    expect(compactFailedEvent).toBeUndefined()

    // Should have session_reset event
    const resetEvent = detail.events.find((e) => e.type === 'actor.session_reset')
    expect(resetEvent).toBeDefined()
    expect(resetEvent?.payload.reason).toBe('context_window_limit')

    // Ultimately should still end up as FAILED
    expect(detail.state.status).toBe('FAILED')

    // Check transcript has session_reset notification
    const resetTranscript = detail.transcript.find((t) => t.meta?.kind === 'session_reset')
    expect(resetTranscript).toBeDefined()
    expect(resetTranscript?.content).toContain('重置会话')
  })

  it('does not attempt session reset when no session ID exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-no-session-'))
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    // No session ID set — session reset should NOT be attempted

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    // No context limit event because there's no session to reset
    const contextLimitEvent = detail.events.find((e) => e.type === 'actor.context_limit_detected')
    expect(contextLimitEvent).toBeUndefined()
    expect(detail.state.status).toBe('FAILED')
  })

  it('skips session reset for non-context-window-limit errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-non-ctx-'))
    const fake = join(root, 'fake-normal-error.js')
    await writeFile(fake, `
process.stderr.write('Some other error\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'test-session-456'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    // No session reset should be attempted for a regular error
    const contextLimitEvent = detail.events.find((e) => e.type === 'actor.context_limit_detected')
    expect(contextLimitEvent).toBeUndefined()
    expect(detail.state.status).toBe('FAILED')
  })

  it('respects max_compact_retries setting (controls max reset attempts)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-max-'))
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    // Set max_compact_retries to 0 to disable session reset
    await store.updateGlobalSettings({ max_compact_retries: 0 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'test-session-789'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    // With max_compact_retries=0, no session reset should be attempted
    const contextLimitEvent = detail.events.find((e) => e.type === 'actor.context_limit_detected')
    expect(contextLimitEvent).toBeUndefined()
    expect(detail.state.status).toBe('FAILED')
  })

  it('resets session and clears session ID on context limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-reset-'))
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'session-to-be-cleared'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    // Should have a session_reset event
    const resetEvent = detail.events.find((e) => e.type === 'actor.session_reset')
    expect(resetEvent).toBeDefined()
    expect(resetEvent?.payload.reason).toBe('context_window_limit')

    // Should have a session_reset transcript entry
    const resetTranscript = detail.transcript.find((t) => t.meta?.kind === 'session_reset')
    expect(resetTranscript).toBeDefined()
    expect(resetTranscript?.content).toContain('重置会话')

    // Session ID should be cleared after reset
    expect(detail.state.claude_session_id).toBeNull()
  })

  it('writes compact context summary to context.md on session reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-summary-'))
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'test-session-summary'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    // Check that context.md was rewritten with compact summary
    const detail = await store.getTaskDetail('demo', created.workspace_key)
    const taskDir = store.taskDirectory('demo', created.workspace_key)
    const contextFile = join(taskDir, 'context.md')
    const contextContent = await readFile(contextFile, 'utf-8')
    expect(contextContent).toContain('上下文窗口限制已重置')
    // Task text may be empty in this test, so just verify the reset notice exists
    expect(contextContent).toContain('请基于以上摘要继续工作')
    // Should be much shorter than the original context
    expect(contextContent.length).toBeLessThan(5000)
  })

  it('always goes directly to session reset without attempting /compact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-direct-'))
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'test-session-direct'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    // Should have NO compact events at all — we never attempt /compact
    const compactEvents = detail.events.filter((e) =>
      e.type === 'actor.compact_succeeded' || e.type === 'actor.compact_failed' || e.type === 'actor.compact_output'
    )
    expect(compactEvents.length).toBe(0)

    // Should have NO compact_retry transcript entries
    const compactRetryTranscripts = detail.transcript.filter((t) => t.meta?.kind === 'compact_retry')
    expect(compactRetryTranscripts.length).toBe(0)

    // Should have session_reset transcript entries instead
    const resetTranscripts = detail.transcript.filter((t) => t.meta?.kind === 'session_reset')
    expect(resetTranscripts.length).toBeGreaterThanOrEqual(1)
  })

  it('attempts LLM summarization and falls back to truncation on failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-summarize-'))
    // Fake CLI that always fails — simulates LLM summarization failure
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'test-session-summarize'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    // Should have attempted LLM summarization (which fails because fake CLI
    // is a contract launcher, not native Claude, so stdin isn't used)
    const summarizeFailedEvent = detail.events.find((e) => e.type === 'actor.summarize_failed')
    expect(summarizeFailedEvent).toBeDefined()

    // Session reset should record that it fell back to truncation
    const resetEvent = detail.events.find((e) => e.type === 'actor.session_reset')
    expect(resetEvent).toBeDefined()
    expect(resetEvent?.payload.summary_method).toBe('truncation')

    // context.md should contain the truncation fallback content
    const taskDir = store.taskDirectory('demo', created.workspace_key)
    const contextFile = join(taskDir, 'context.md')
    const contextContent = await readFile(contextFile, 'utf-8')
    expect(contextContent).toContain('上下文窗口限制已重置')
  })

  it('records summarize attempt events even when using fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-events-'))
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    await store.updateTaskState('demo', created.workspace_key, (state) => ({
      ...state,
      claude_session_id: 'test-session-events'
    }))

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    // Should have both summarize_failed and session_reset events
    const summarizeFailed = detail.events.find((e) => e.type === 'actor.summarize_failed')
    expect(summarizeFailed).toBeDefined()

    const sessionReset = detail.events.find((e) => e.type === 'actor.session_reset')
    expect(sessionReset).toBeDefined()
    expect(sessionReset?.payload.summary_method).toBe('truncation')
  })
})
