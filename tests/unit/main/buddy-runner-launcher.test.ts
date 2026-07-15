import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyRunner with fake launcher', () => {
  it('records actor output and enters READY after successful run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-launcher-'))
    const fake = join(root, 'fake-actor.js')
    await writeFile(fake, "process.stdout.write(JSON.stringify({type:'message',role:'assistant',content:[{type:'output_text',text:'done'}],thread_id:'t1'}) + '\\n')\n")

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          codex: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'codex'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('PAUSED')
    expect(detail.state.codex_thread_id).toBe('t1')
    expect(detail.events.some((event) => event.type === 'actor.completed')).toBe(true)

    const transcriptJsonl = await readFile(join(root, 'workspaces', created.workspace_key, 'tasks', 'demo', 'transcript.jsonl'), 'utf8')
    const transcriptRow = JSON.parse(transcriptJsonl.split('\n')[0])
    expect(transcriptRow).toMatchObject({
      role: 'codex',
      content: 'done',
      meta: expect.objectContaining({ buddy_type: 'chat' })
    })
    expect(transcriptRow.meta.elapsed_ms).toEqual(expect.any(Number))
  })

  it('runs custom launchers with buddy contract flags and environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-contract-'))
    const fake = join(root, 'contract-actor.js')
    await writeFile(fake, [
      "const fs = require('fs')",
      "const args = process.argv.slice(2)",
      "const required = ['--actor', 'opencode', '--mode', 'start', '--repo-root', process.env.BUDDY_REPO_ROOT, '--task-dir', process.env.BUDDY_TASK_DIR, '--run-id', process.env.BUDDY_RUN_ID, '--prompt-file', process.env.BUDDY_PROMPT_FILE, '--output-file', process.env.BUDDY_OUTPUT_FILE, '--event-file', process.env.BUDDY_EVENT_FILE]",
      "for (const item of required) { if (!args.includes(item)) throw new Error(`missing ${item}`) }",
      "if (process.env.BUDDY_ACTOR !== 'opencode') throw new Error('missing actor env')",
      "if (process.env.BUDDY_MODE !== 'start') throw new Error('missing mode env')",
      "fs.writeFileSync(process.env.BUDDY_OUTPUT_FILE, JSON.stringify({ type: 'chat', content: 'custom output' }))",
      "fs.writeFileSync(process.env.BUDDY_EVENT_FILE, JSON.stringify({ type: 'buddy.session', actor: 'opencode', session_id: 'custom-session' }) + '\\n')"
    ].join('\n'))

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root,
      settings: {
        launchers: {
          opencode: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.opencode_session_id).toBe('custom-session')
    expect(detail.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'opencode', content: 'custom output' })
    ]))
  })

  it('hands off between configured implementer and reviewer actors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-handoff-'))
    const fake = join(root, 'handoff-actor.js')
    await writeFile(fake, [
      "const fs = require('fs')",
      "const actor = process.env.BUDDY_ACTOR",
      "fs.writeFileSync(process.env.BUDDY_OUTPUT_FILE, JSON.stringify({ type: 'chat', content: `${actor} output` }))"
    ].join('\n'))

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 2 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root,
      settings: {
        implementer_actor: 'opencode',
        reviewer_actor: 'kimi',
        launchers: {
          opencode: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 },
          kimi: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    // Start the first actor; it auto-chains to the second, then pauses at max_rounds
    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('PAUSED')
    expect(detail.state.next_actor).toBe('opencode')
    expect(detail.state.round).toBe(2)
    expect(detail.state.rounds_in_window).toBe(2)
    expect(detail.state.context_sent?.opencode).toBe(true)
    expect(detail.state.context_sent?.kimi).toBe(true)
  })

  it('uses seed session and thread ids from settings on the first run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-seed-session-'))
    const fake = join(root, 'seed-actor.js')
    await writeFile(fake, [
      "const fs = require('fs')",
      "const args = process.argv.slice(2)",
      "if (process.env.BUDDY_MODE !== 'resume') throw new Error(`mode ${process.env.BUDDY_MODE}`)",
      "if (process.env.BUDDY_SESSION_ID !== 'seed-session') throw new Error(`session ${process.env.BUDDY_SESSION_ID}`)",
      "if (!args.includes('--session-id') || !args.includes('seed-session')) throw new Error(`args ${args.join(' ')}`)",
      "fs.writeFileSync(process.env.BUDDY_OUTPUT_FILE, JSON.stringify({ type: 'chat', content: 'seeded output' }))",
      "fs.writeFileSync(process.env.BUDDY_EVENT_FILE, JSON.stringify({ type: 'buddy.session', actor: 'opencode', session_id: 'next-session' }) + '\\n')"
    ].join('\n'))

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root,
      settings: {
        seed_opencode_session_id: 'seed-session',
        launchers: {
          opencode: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.opencode_session_id).toBe('next-session')
  })

  it('pauses after a run that reaches max rounds for the current window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-max-rounds-'))
    const fake = join(root, 'max-rounds-actor.js')
    await writeFile(fake, [
      "const fs = require('fs')",
      "fs.writeFileSync(process.env.BUDDY_OUTPUT_FILE, JSON.stringify({ type: 'chat', content: 'one round' }))"
    ].join('\n'))

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root,
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'claude'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('PAUSED')
    expect(detail.state.countdown).toBeNull()
    expect(detail.state.rounds_in_window).toBe(1)
    expect(detail.state.next_actor).toBe('codex')
    expect(detail.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'round_window.paused',
        payload: expect.objectContaining({
          max_rounds: 1,
          rounds_in_window: 1,
          next_actor: 'codex'
        })
      })
    ]))
  })

  it('generates and persists a Kimi session for native Kimi runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-kimi-'))
    const fake = join(root, 'kimi')
    await writeFile(fake, [
      '#!/bin/sh',
      'cat >/dev/null',
      "printf '%s\\n' " + JSON.stringify(JSON.stringify({ role: 'assistant', content: '{"type":"chat","content":"intermediate"}' })),
      "printf '%s\\n' " + JSON.stringify(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'session_abc123-def456', content: 'To resume: kimi -r session_abc123-def456' })),
      "printf '%s\\n' " + JSON.stringify(JSON.stringify({ role: 'assistant', content: '{"type":"chat","content":"final answer"}' }))
    ].join('\n'))
    await chmod(fake, 0o755)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root,
      settings: {
        launchers: {
          kimi: { command: fake, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'kimi'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.kimi_session_id).toBe('session_abc123-def456')
    expect(detail.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'kimi', content: 'final answer' })
    ]))
    expect(detail.transcript).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'kimi', content: 'intermediate' })
    ]))
  })

  it('records dual break confirmations in structured transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-dual-break-'))
    const fake = join(root, 'contract-break.js')
    await writeFile(fake, [
      "const fs = require('fs')",
      "const actor = process.env.BUDDY_ACTOR",
      "fs.writeFileSync(process.env.BUDDY_OUTPUT_FILE, JSON.stringify({ type: 'break', content: `${actor} confirms done` }))"
    ].join('\n'))

    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root,
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 },
          codex: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    // Start first actor (codex) — it will signal break.
    // After completion, the next actor (claude) is auto-started.
    // Claude also signals break, confirming dual-break → DONE.
    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'codex'
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.status).toBe('DONE')
    expect(detail.transcript).toEqual([
      expect.objectContaining({
        role: 'codex',
        content: 'codex confirms done',
        meta: expect.objectContaining({ buddy_type: 'break', round: 1 })
      }),
      expect.objectContaining({
        role: 'system',
        content: 'Codex 请求结束任务，等待 Claude Code 确认。',
        meta: expect.objectContaining({ kind: 'round_notice', round: 1 })
      }),
      expect.objectContaining({
        role: 'claude',
        content: 'claude confirms done',
        meta: expect.objectContaining({ buddy_type: 'break', round: 2 })
      }),
      expect.objectContaining({
        role: 'system',
        content: 'Codex 和 Claude Code 均确认任务完成，任务结束。',
        meta: expect.objectContaining({ kind: 'round_notice', round: 2 })
      })
    ])
  })
})

describe('BuddyRunner queue terminal notifications', () => {
  // A fake actor that emits a plain chat message so the round auto-advances to the next actor.
  function chatActorScript(): string {
    return [
      "const fs = require('fs')",
      "const actor = process.env.BUDDY_ACTOR",
      "fs.writeFileSync(process.env.BUDDY_OUTPUT_FILE, JSON.stringify({ type: 'chat', content: `${actor} chat` }))"
    ].join('\n')
  }

  // A fake actor that always signals break, used to drive a task to DONE via dual-break.
  function breakActorScript(): string {
    return [
      "const fs = require('fs')",
      "const actor = process.env.BUDDY_ACTOR",
      "fs.writeFileSync(process.env.BUDDY_OUTPUT_FILE, JSON.stringify({ type: 'break', content: `${actor} done` }))"
    ].join('\n')
  }

  // A fake actor that always fails (non-zero exit), driving the task to FAILED.
  function failingActorScript(): string {
    return "process.stderr.write('boom\\n'); process.exit(3)"
  }

  async function makeRunner(root: string, script: string) {
    const fake = join(root, 'actor.js')
    await writeFile(fake, script)
    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root,
      settings: {
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 },
          codex: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const terminal = vi.fn<(ws: string) => void>()
    const runner = new BuddyRunner(store)
    runner.onTaskTerminal = terminal
    return { store, created, runner, terminal }
  }

  it('does not notify the coordinator while auto-advancing through rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-no-notify-advance-'))
    const { created, runner, terminal } = await makeRunner(root, chatActorScript())
    // Cap rounds so the run terminates (pauses at the window). Across multiple auto-advancing
    // rounds the coordinator is notified at most once (the final round-window PAUSED), never
    // once per intermediate round.
    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 3 })
    await runner.startTask('demo', { workspace_key: created.workspace_key, actor: 'claude' })
    expect(terminal.mock.calls.length).toBeLessThanOrEqual(1)
    // The task actually advanced several rounds before pausing.
    const detail = await store.getTaskDetail('demo', created.workspace_key)
    expect(detail.state.round).toBeGreaterThanOrEqual(2)
  }, 30000)

  it('notifies only once when a multi-round task reaches DONE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-notify-done-once-'))
    const { created, runner, terminal } = await makeRunner(root, breakActorScript())
    // codex signals break → claude auto-started → claude signals break → DONE.
    await runner.startTask('demo', { workspace_key: created.workspace_key, actor: 'codex' })
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(terminal.mock.calls[0][0]).toBe(created.workspace_key)
  })

  it('notifies only once when a task fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-notify-failed-once-'))
    // Allow retries so failure_threshold isn't hit (we want FAILED, not PAUSED) — but a single
    // failure still notifies once.
    const { created, runner, terminal } = await makeRunner(root, failingActorScript())
    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_consecutive_failures: 100 })
    await expect(
      runner.startTask('demo', { workspace_key: created.workspace_key, actor: 'claude' })
    ).rejects.toThrow()
    expect(terminal).toHaveBeenCalledTimes(1)
  })

  it('does not notify again when the auto-advance call stack unwinds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-no-double-notify-'))
    const { created, runner, terminal } = await makeRunner(root, breakActorScript())
    await runner.startTask('demo', { workspace_key: created.workspace_key, actor: 'codex' })
    // After the whole startTask promise resolves (all stack frames unwound), DONE was notified
    // exactly once — the previous bug notified once per frame.
    expect(terminal).toHaveBeenCalledTimes(1)
  })
})
