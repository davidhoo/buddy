import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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

  it('runs a named Cursor Agent profile with its own model and resumable session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-cursor-'))
    const fake = join(root, 'agent')
    await writeFile(fake, [
      '#!/usr/bin/env node',
      "const args = process.argv.slice(2)",
      "if (!args.includes('--model') || !args.includes('composer-2.5')) process.exit(11)",
      "if (!args.includes('--resume') || !args.includes('cursor-seed')) process.exit(12)",
      "const session_id = 'cursor-next'",
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id, model: 'Composer 2.5' }))",
      "console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '{\"type\":\"chat\",\"content\":\"cursor output\"}' }] }, session_id }))",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: '{\"type\":\"chat\",\"content\":\"cursor output\"}', session_id }))"
    ].join('\n'))
    await chmod(fake, 0o755)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'cursor-demo',
      repo_root: root,
      settings: {
        implementer_actor: 'cursor-agent',
        reviewer_actor: 'codex',
        seed_agent_sessions: { 'cursor-agent': 'cursor-seed' },
        launchers: {
          'cursor-agent': {
            command: fake,
            env: {},
            timeout_seconds: 5,
            backend: 'cursor',
            display_name: 'Cursor Implementer',
            model: 'composer-2.5',
            cursor: { force: true, trust: true }
          }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await runner.startTask('cursor-demo', {
      workspace_key: created.workspace_key,
      actor: 'cursor-agent'
    })

    const detail = await store.getTaskDetail('cursor-demo', created.workspace_key)
    expect(detail.state.status).toBe('PAUSED')
    expect(detail.state.agent_sessions?.['cursor-agent']).toBe('cursor-next')
    expect(detail.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'cursor-agent',
        content: 'cursor output',
        meta: expect.objectContaining({ backend: 'cursor', display_name: 'Cursor Implementer' })
      })
    ]))
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
