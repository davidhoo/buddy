import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyRunner } from '../../../src/main/buddy/runner'
import { BuddyStore } from '../../../src/main/buddy/store'
import { BuddyEventBus } from '../../../src/main/buddy/events'

describe('BuddyRunner with ACP protocol', () => {
  it('executes ACP agent round, receives stream events, and saves session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-acp-'))
    const fakeAcpServer = join(root, 'fake-acp-agent.js')

    // Fake ACP Server in Node.js
    const serverScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });

      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: '1.0',
              agentInfo: { name: 'fake-opencode-acp', version: '1.0.0' },
              capabilities: { streaming: true, tools: true }
            }
          }) + '\\n');
        } else if (req.method === 'session/new' || req.method === 'session/load') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { sessionId: 'acp_session_999' }
          }) + '\\n');
        } else if (req.method === 'session/prompt') {
          // Stream some content delta
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/contentDelta',
            params: { text: 'Hello from ACP agent!' }
          }) + '\\n');

          // Complete the prompt
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { status: 'completed' }
          }) + '\\n');
        }
      });
    `
    await writeFile(fakeAcpServer, serverScript)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const events = new BuddyEventBus()

    const stdoutDeltas: string[] = []
    events.subscribe((envelope) => {
      if (envelope.event.type === 'actor.stdout') {
        stdoutDeltas.push((envelope.event.payload as { text: string }).text)
      }
    })

    const created = await store.createTask({
      task_id: 'acp-demo',
      repo_root: '/tmp/repo',
      settings: {
        flow_policy: 'claude_then_codex',
        launchers: {
          opencode: {
            protocol: 'acp',
            command: process.execPath,
            args: [fakeAcpServer],
            env: {},
            timeout_seconds: 10
          }
        }
      }
    })

    const runner = new BuddyRunner(store, { events })

    await runner.startTask('acp-demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    const detail = await store.getTaskDetail('acp-demo', created.workspace_key)
    expect(detail.state.status).toBe('PAUSED')
    expect(detail.state.actor_sessions?.['opencode']).toBe('acp_session_999')
    expect(detail.state.opencode_session_id).toBe('acp_session_999')
    expect(stdoutDeltas).toContain('Hello from ACP agent!')

    const transcriptJsonl = await readFile(
      join(root, 'workspaces', created.workspace_key, 'tasks', 'acp-demo', 'transcript.jsonl'),
      'utf8'
    )
    const transcriptRow = JSON.parse(transcriptJsonl.split('\n')[0])
    expect(transcriptRow.content).toBe('Hello from ACP agent!')
  })

  it('handles buddy_propose_break tool invocation and marks pending break', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-acp-break-'))
    const fakeAcpServer = join(root, 'fake-acp-break-agent.js')

    const serverScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });

      let promptId = null;
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '1.0', agentInfo: { name: 'break-agent' }, capabilities: {} }
          }) + '\\n');
        } else if (msg.method === 'session/new' || msg.method === 'session/load') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { sessionId: 'sess_break' }
          }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          promptId = msg.id;
          // Call host tool buddy_propose_break
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 'call_1',
            method: 'tools/call',
            params: {
              name: 'buddy_propose_break',
              input: { reason: 'Implementation complete and all tests passing.' }
            }
          }) + '\\n');
        } else if (msg.id === 'call_1') {
          // Host responded to tool call, now finish prompt
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: promptId,
            result: { status: 'completed' }
          }) + '\\n');
        }
      });
    `
    await writeFile(fakeAcpServer, serverScript)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })

    const created = await store.createTask({
      task_id: 'acp-break-demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          opencode: {
            protocol: 'acp',
            command: process.execPath,
            args: [fakeAcpServer],
            env: {},
            timeout_seconds: 10
          }
        }
      }
    })

    const runner = new BuddyRunner(store)

    await runner.startTask('acp-break-demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    const detail = await store.getTaskDetail('acp-break-demo', created.workspace_key)
    expect(detail.state.pending_break).toEqual({
      actor: 'opencode',
      round: 1
    })
  })

  it('completes task when both actors confirm break (Dual-Break)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-acp-dual-break-'))
    const fakeAcpServer = join(root, 'dual-break-agent.js')

    const serverScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });

      let promptId = null;
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '1.0', agentInfo: { name: 'dual-agent' }, capabilities: {} }
          }) + '\\n');
        } else if (msg.method === 'session/new' || msg.method === 'session/load') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { sessionId: 'sess_dual' }
          }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          promptId = msg.id;
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 'call_break',
            method: 'tools/call',
            params: {
              name: 'buddy_propose_break',
              input: { reason: 'Done' }
            }
          }) + '\\n');
        } else if (msg.id === 'call_break') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: promptId,
            result: { status: 'completed' }
          }) + '\\n');
        }
      });
    `
    await writeFile(fakeAcpServer, serverScript)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 10 })

    const created = await store.createTask({
      task_id: 'dual-break-demo',
      repo_root: '/tmp/repo',
      settings: {
        flow_policy: 'claude_then_codex',
        implementer_actor: 'opencode',
        reviewer_actor: 'kimi',
        launchers: {
          opencode: {
            protocol: 'acp',
            command: process.execPath,
            args: [fakeAcpServer],
            env: {},
            timeout_seconds: 10
          },
          kimi: {
            protocol: 'acp',
            command: process.execPath,
            args: [fakeAcpServer],
            env: {},
            timeout_seconds: 10
          }
        }
      }
    })

    const runner = new BuddyRunner(store)

    // Round 1: opencode runs, proposes break
    await runner.startTask('dual-break-demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    // After round 1, round 2 (kimi) auto-advances or can be run.
    // If auto-advance happened, state is already DONE or we check current state:
    const detailAfterRounds = await store.getTaskDetail('dual-break-demo', created.workspace_key)
    expect(detailAfterRounds.state.status).toBe('DONE')
    expect(detailAfterRounds.events.some((e) => e.type === 'task.done')).toBe(true)
  })

  it('persists ACP artifacts and extracts round events (thinking and tool calls)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-acp-artifacts-'))
    const fakeAcpServer = join(root, 'fake-acp-artifacts-agent.js')

    const serverScript = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });

      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '1.0', agentInfo: { name: 'artifacts-agent' }, capabilities: {} }
          }) + '\\n');
        } else if (msg.method === 'session/new' || msg.method === 'session/load') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { sessionId: 'art_session_123' }
          }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          // Send thinking delta
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/thinkingDelta',
            params: { thinking: 'Deep reasoning in ACP mode...' }
          }) + '\\n');

          // Send tool call notification
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/toolCall',
            params: { id: 'call_1', name: 'bash', input: { command: 'pnpm test' } }
          }) + '\\n');

          // Send final text
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/contentDelta',
            params: { text: 'Done running tests.' }
          }) + '\\n');

          // Complete
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { status: 'completed' }
          }) + '\\n');
        }
      });
    `
    await writeFile(fakeAcpServer, serverScript)

    const store = new BuddyStore(root)
    await store.updateGlobalSettings({ max_rounds: 1 })
    const created = await store.createTask({
      task_id: 'art-demo',
      repo_root: '/tmp/repo',
      task_text: 'Test artifacts extraction',
      settings: {
        launchers: {
          opencode: {
            protocol: 'acp',
            command: process.execPath,
            args: [fakeAcpServer],
            env: {},
            timeout_seconds: 10
          }
        }
      }
    })

    const runner = new BuddyRunner(store)
    await runner.startTask('art-demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    const detail = await store.getTaskDetail('art-demo', created.workspace_key)
    const runId = detail.transcript[0]?.meta?.run_id as string
    expect(runId).toBeDefined()

    // Query round events
    const summary = await store.getRoundEvents('art-demo', runId, created.workspace_key, 'opencode')
    expect(summary).not.toBeNull()
    expect(summary?.events.some((e) => e.type === 'thinking' && e.thinkingLength! > 0)).toBe(true)
    expect(summary?.events.some((e) => e.type === 'tool_use' && e.toolName === 'bash')).toBe(true)

    // Verify artifacts exist on filesystem
    const taskDir = store.taskDirectory('art-demo', created.workspace_key)
    const outputMd = await readFile(join(taskDir, 'artifacts', `${runId}-output.md`), 'utf8')
    expect(outputMd).toBe('Done running tests.')
    const promptMd = await readFile(join(taskDir, 'artifacts', `${runId}-prompt.md`), 'utf8')
    expect(promptMd.length).toBeGreaterThan(0)
  })
})

