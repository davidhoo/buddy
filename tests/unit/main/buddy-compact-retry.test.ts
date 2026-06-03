import { mkdtemp, writeFile } from 'node:fs/promises'
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
})

describe('BuddyRunner context window limit handling', () => {
  it('detects context window limit error and attempts compact+retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-'))
    // First call: fails with context window limit
    // Second call (after compact): also fails (compact itself is a no-op in test, but we simulate)
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
    // Set a session ID so compact can be attempted
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
    // Should have detected context limit and attempted compact
    const contextLimitEvent = detail.events.find((e) => e.type === 'actor.context_limit_detected')
    expect(contextLimitEvent).toBeDefined()
    expect(contextLimitEvent?.payload.error).toContain('context window limit')

    // Compact should have been attempted but failed (since we're using a fake CLI)
    const compactFailedEvent = detail.events.find((e) => e.type === 'actor.compact_failed')
    expect(compactFailedEvent).toBeDefined()

    // Ultimately should still end up as FAILED
    expect(detail.state.status).toBe('FAILED')

    // Check transcript has compact retry notification
    const compactTranscript = detail.transcript.find((t) => t.meta?.kind === 'compact_retry')
    expect(compactTranscript).toBeDefined()
    expect(compactTranscript?.content).toContain('上下文窗口限制')
  })

  it('does not attempt compact when no session ID exists', async () => {
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
    // No session ID set — compact should NOT be attempted

    const runner = new BuddyRunner(store)

    await expect(runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })).rejects.toThrow()

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    // No context limit event because there's no session to compact
    const contextLimitEvent = detail.events.find((e) => e.type === 'actor.context_limit_detected')
    expect(contextLimitEvent).toBeUndefined()
    expect(detail.state.status).toBe('FAILED')
  })

  it('skips compact for non-context-window-limit errors', async () => {
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
    // No compact should be attempted for a regular error
    const contextLimitEvent = detail.events.find((e) => e.type === 'actor.context_limit_detected')
    expect(contextLimitEvent).toBeUndefined()
    expect(detail.state.status).toBe('FAILED')
  })

  it('respects max_compact_retries setting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-compact-max-'))
    const fake = join(root, 'fake-ctx-limit.js')
    await writeFile(fake, `
process.stderr.write('API Error: The model has reached its context window limit.\\n');
process.exit(1);
`)

    const store = new BuddyStore(root)
    // Set max_compact_retries to 0 to disable auto-compact
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
    // With max_compact_retries=0, no compact should be attempted
    const contextLimitEvent = detail.events.find((e) => e.type === 'actor.context_limit_detected')
    expect(contextLimitEvent).toBeUndefined()
    expect(detail.state.status).toBe('FAILED')
  })
})
