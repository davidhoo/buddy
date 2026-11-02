import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'

/**
 * D4: first-batch new Actor IDs must complete ACP task create → two rounds →
 * dual-break with a real temporary stdio process. This is isolation evidence,
 * not a vendor product verification.
 */
describe('first-batch new Agent ACP roundtrips (isolated stdio)', () => {
  const breakServer = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    let promptId = null;
    let sessionN = 0;
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '1.0', agentInfo: { name: 'batch1-agent' }, capabilities: {} }
        }) + '\\n');
      } else if (msg.method === 'session/new' || msg.method === 'session/load') {
        sessionN += 1;
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { sessionId: 'sess_batch1_' + sessionN }
        }) + '\\n');
      } else if (msg.method === 'session/prompt') {
        promptId = msg.id;
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', method: 'session/contentDelta',
          params: { text: 'batch1 round ok' }
        }) + '\\n');
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: 'call_break', method: 'tools/call',
          params: { name: 'buddy_propose_break', input: { reason: 'Done' } }
        }) + '\\n');
      } else if (msg.id === 'call_break') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: promptId, result: { status: 'completed' }
        }) + '\\n');
      }
    });
  `

  it('runs qwen + goose ACP dual-break and persists sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-batch1-qg-'))
    const server = join(root, 'acp-server.js')
    await writeFile(server, breakServer)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 10 })
    const created = await store.createTask({
      task_id: 'batch1-qwen-goose',
      repo_root: root,
      task_text: 'isolated first-batch ACP roundtrip',
      settings: {
        flow_policy: 'claude_then_codex',
        implementer_actor: 'qwen',
        reviewer_actor: 'goose',
        launchers: {
          qwen: {
            protocol: 'acp',
            command: process.execPath,
            args: [server],
            env: {},
            timeout_seconds: 15
          },
          goose: {
            protocol: 'acp',
            command: process.execPath,
            args: [server],
            env: {},
            timeout_seconds: 15
          }
        }
      }
    })

    const settings = await store.readTaskSettings(created.task, created.workspace_key)
    expect(settings.launchers?.qwen?.protocol).toBe('acp')
    expect(settings.launchers?.goose?.protocol).toBe('acp')

    const runner = new BuddyRunner(store)
    await runner.startTask(created.task, {
      workspace_key: created.workspace_key,
      actor: 'qwen'
    })

    const detail = await store.getTaskDetail(created.task, created.workspace_key)
    expect(detail.state.status).toBe('DONE')
    expect(detail.events.some(e => e.type === 'task.done')).toBe(true)
    expect(detail.state.actor_sessions?.qwen || detail.state.actor_sessions?.['qwen']).toBeTruthy()
  })

  it('runs copilot + droid ACP dual-break', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-batch1-cd-'))
    const server = join(root, 'acp-server.js')
    await writeFile(server, breakServer)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 10 })
    const created = await store.createTask({
      task_id: 'batch1-copilot-droid',
      repo_root: root,
      settings: {
        implementer_actor: 'copilot',
        reviewer_actor: 'droid',
        launchers: {
          copilot: {
            protocol: 'acp',
            command: process.execPath,
            args: [server],
            env: {},
            timeout_seconds: 15
          },
          droid: {
            protocol: 'acp',
            command: process.execPath,
            args: [server],
            env: {},
            timeout_seconds: 15
          }
        }
      }
    })

    const runner = new BuddyRunner(store)
    await runner.startTask(created.task, {
      workspace_key: created.workspace_key,
      actor: 'copilot'
    })

    const detail = await store.getTaskDetail(created.task, created.workspace_key)
    expect(detail.state.status).toBe('DONE')
    expect(detail.events.some(e => e.type === 'task.done')).toBe(true)
  })
})
