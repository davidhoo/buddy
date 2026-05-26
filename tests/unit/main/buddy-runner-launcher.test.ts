import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyRunner with fake launcher', () => {
  it('records actor output and enters countdown after successful run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-launcher-'))
    const fake = join(root, 'fake-actor.js')
    await writeFile(fake, "process.stdout.write(JSON.stringify({type:'message',role:'assistant',content:[{type:'output_text',text:'done'}],thread_id:'t1'}) + '\\n')\n")

    const store = new BuddyStore(root)
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
    expect(detail.state.status).toBe('COUNTDOWN')
    expect(detail.state.codex_thread_id).toBe('t1')
    expect(detail.events.some((event) => event.type === 'actor.completed')).toBe(true)

    const transcriptJsonl = await readFile(join(root, 'workspaces', created.workspace_key, 'tasks', 'demo', 'transcript.jsonl'), 'utf8')
    expect(transcriptJsonl).toContain('"role":"codex"')
    expect(transcriptJsonl).toContain('"content":"done"')
    expect(transcriptJsonl).toContain('"buddy_type":"chat"')
    expect(transcriptJsonl).toContain('"elapsed_ms"')
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

  it('generates and persists a Kimi session for native Kimi runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-kimi-'))
    const fake = join(root, 'kimi')
    await writeFile(fake, [
      '#!/bin/sh',
      'cat >/dev/null',
      "printf '%s\\n' " + JSON.stringify(JSON.stringify({ role: 'assistant', content: '{"type":"chat","content":"intermediate"}' })),
      "printf '%s\\n' " + JSON.stringify(JSON.stringify({ role: 'assistant', content: '{"type":"chat","content":"final answer"}' }))
    ].join('\n'))
    await chmod(fake, 0o755)

    const store = new BuddyStore(root)
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
    expect(detail.state.kimi_session_id).toMatch(/^[a-f0-9]{16}$/)
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
        countdown_seconds: 1,
        launchers: {
          claude: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 },
          codex: { command: `${process.execPath} ${fake}`, env: {}, timeout_seconds: 5 }
        }
      }
    })
    const runner = new BuddyRunner(store)

    await runner.startTask('demo', {
      workspace_key: created.workspace_key,
      actor: 'codex'
    })
    await runner.skipCountdown('demo', {
      workspace_key: created.workspace_key,
      next_actor: 'claude'
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
