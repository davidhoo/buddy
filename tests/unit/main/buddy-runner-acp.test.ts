import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
    const promptMd = await readFile(join(taskDir, 'artifacts', `${runId}-output.md`), 'utf8')
    expect(promptMd.length).toBeGreaterThan(0)
  })

  it('automatically recovers ACP protocol and args from globalSettings during health check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-acp-recover-'))
    const fakeAcpServer = join(root, 'fake-acp-agent.js')

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
              agentInfo: { name: 'recovered-acp', version: '1.0.0' },
              capabilities: { streaming: true, tools: true }
            }
          }) + '\\n');
        }
      });
    `
    await writeFile(fakeAcpServer, serverScript)

    const store = new BuddyStore(root)
    // Global settings has wecode_claude configured with ACP protocol
    await store.updateGlobalSettings({
      launchers: {
        wecode_claude: {
          protocol: 'acp',
          command: process.execPath,
          args: [fakeAcpServer],
          env: {},
          timeout_seconds: 10
        }
      }
    })

    // Simulate a task whose settings launcher dropped protocol and args (e.g. only command was stored)
    const created = await store.createTask({
      task_id: 'recover-demo',
      repo_root: '/tmp/repo',
      task_text: 'Test ACP protocol recovery',
      settings: {
        launchers: {
          wecode_claude: {
            command: process.execPath,
            env: {},
            timeout_seconds: 10
          }
        }
      }
    })

    const runner = new BuddyRunner(store)
    const ping = await (runner as any).executePing('recover-demo', created.workspace_key, 'wecode_claude')
    expect(ping.success).toBe(true)
  })

  it('applies the selected ACP model via session/set_model before prompting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runner-acp-model-'))
    const fakeAcpServer = join(root, 'fake-acp-model-agent.js')
    const marker = join(root, 'set-model.json')

    const serverScript = `
      const fs = require('fs');
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });

      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { protocolVersion: '1.0', agentInfo: { name: 'model-agent' }, capabilities: {} }
          }) + '\\n');
        } else if (req.method === 'session/new' || req.method === 'session/load') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              sessionId: 'sess_model',
              models: {
                currentModelId: 'sonnet-4.5',
                availableModels: [
                  { modelId: 'opus-4.6', name: 'Opus 4.6' },
                  { modelId: 'sonnet-4.5', name: 'Sonnet 4.5' }
                ]
              }
            }
          }) + '\\n');
        } else if (req.method === 'session/set_model') {
          fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(req.params));
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
        } else if (req.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/contentDelta',
            params: { text: 'ok' }
          }) + '\\n');
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
    const created = await store.createTask({
      task_id: 'model-demo',
      repo_root: '/tmp/repo',
      settings: {
        launchers: {
          opencode: {
            protocol: 'acp',
            command: process.execPath,
            args: [fakeAcpServer],
            env: {},
            timeout_seconds: 10,
            model: 'opus-4.6'
          }
        }
      }
    })

    const runner = new BuddyRunner(store)
    await runner.startTask('model-demo', {
      workspace_key: created.workspace_key,
      actor: 'opencode'
    })

    const recorded = JSON.parse(await readFile(marker, 'utf8'))
    expect(recorded).toEqual({ sessionId: 'sess_model', modelId: 'opus-4.6' })
  })

  describe('ACP context window overflow', () => {
    async function setupOverflowFixture(options: {
      overflowMode: 'rpc' | 'stopReason' | 'chinese' | 'other' | 'hang'
      overflowUntil?: number
      maxCompactRetries?: number
      includeReviewerSession?: boolean
      model?: string
    }) {
      const root = await mkdtemp(join(tmpdir(), 'buddy-runner-acp-overflow-'))
      const fakeAcpServer = join(root, 'fake-acp-overflow-agent.js')
      const methodLog = join(root, 'methods.jsonl')
      const promptDir = join(root, 'prompts')
      const stateFile = join(root, 'prompt-count.txt')
      const modelLog = join(root, 'set-model.json')
      const readyFile = join(root, 'ready.txt')
      await mkdir(promptDir, { recursive: true })

      const serverScript = `
        const fs = require('fs');
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin });
        const logFile = process.env.ACP_METHOD_LOG;
        const promptDir = process.env.ACP_PROMPT_DIR;
        const stateFile = process.env.ACP_STATE_FILE;
        const overflowUntil = Number(process.env.ACP_OVERFLOW_UNTIL || '1');
        const overflowMode = process.env.ACP_OVERFLOW_MODE || 'rpc';
        const modelLog = process.env.ACP_MODEL_LOG;
        const readyFile = process.env.ACP_READY_FILE;

        function readCount() {
          try { return Number(fs.readFileSync(stateFile, 'utf8')); } catch { return 0; }
        }
        function writeCount(n) { fs.writeFileSync(stateFile, String(n)); }
        function logMethod(method, extra) {
          if (!logFile) return;
          fs.appendFileSync(logFile, JSON.stringify({ method, ...extra }) + '\\n');
        }

        rl.on('line', (line) => {
          const req = JSON.parse(line);
          if (req.method === 'initialize') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { protocolVersion: '1.0', agentInfo: { name: 'overflow-agent' }, capabilities: {} }
            }) + '\\n');
          } else if (req.method === 'session/new' || req.method === 'session/load') {
            logMethod(req.method, { sessionId: req.params && req.params.sessionId });
            const sessionId = req.method === 'session/load'
              ? (req.params && req.params.sessionId) || 'loaded_session'
              : 'fresh_session';
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                sessionId,
                models: {
                  currentModelId: 'sonnet-4.5',
                  availableModels: [
                    { modelId: 'opus-4.6', name: 'Opus 4.6' },
                    { modelId: 'sonnet-4.5', name: 'Sonnet 4.5' }
                  ]
                }
              }
            }) + '\\n');
          } else if (req.method === 'session/set_model' || req.method === 'session/set_config_option') {
            if (modelLog) fs.writeFileSync(modelLog, JSON.stringify(req.params));
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
          } else if (req.method === 'session/prompt') {
            if (readyFile) fs.writeFileSync(readyFile, 'ready');
            if (overflowMode === 'hang') return;
            const n = readCount();
            writeCount(n + 1);
            logMethod(req.method, { promptIndex: n, sessionId: req.params && req.params.sessionId });
            if (promptDir) {
              const blocks = req.params && req.params.prompt;
              const text = Array.isArray(blocks)
                ? blocks.map((b) => (b && b.text) || '').join('')
                : String(blocks || '');
              fs.writeFileSync(promptDir + '/prompt-' + n + '.txt', text);
            }
            if (n < overflowUntil) {
              if (overflowMode === 'stopReason') {
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  result: { status: 'error', stopReason: 'max_tokens' }
                }) + '\\n');
              } else if (overflowMode === 'chinese') {
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  error: { code: -32000, message: '对话内容太长，已超出当前模型的处理能力' }
                }) + '\\n');
              } else if (overflowMode === 'other') {
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  error: { code: -32603, message: 'Permission denied' }
                }) + '\\n');
              } else {
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  error: { code: -32603, message: '超出上下文' }
                }) + '\\n');
              }
            } else {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/contentDelta',
                params: { text: 'Recovered after compact' }
              }) + '\\n');
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                result: { status: 'completed' }
              }) + '\\n');
            }
          }
        });
      `
      await writeFile(fakeAcpServer, serverScript)

      const store = new BuddyStore(root)
      await store.updateGlobalSettings({
        max_rounds: 1,
        ...(options.maxCompactRetries !== undefined ? { max_compact_retries: options.maxCompactRetries } : {})
      })

      const longContext = `UNIQUE_CONTEXT_BLOB ${'x'.repeat(2500)}`
      const created = await store.createTask({
        task_id: 'acp-overflow',
        repo_root: root,
        task_text: 'Implement overflow recovery',
        context_text: longContext,
        settings: {
          implementer_actor: 'opencode',
          reviewer_actor: 'kimi',
          launchers: {
            opencode: {
              protocol: 'acp',
              command: process.execPath,
              args: [fakeAcpServer],
              env: {
                ACP_METHOD_LOG: methodLog,
                ACP_PROMPT_DIR: promptDir,
                ACP_STATE_FILE: stateFile,
                ACP_OVERFLOW_UNTIL: String(options.overflowUntil ?? 1),
                ACP_OVERFLOW_MODE: options.overflowMode,
                ACP_MODEL_LOG: modelLog,
                ACP_READY_FILE: readyFile
              },
              timeout_seconds: 10,
              ...(options.model ? { model: options.model } : {})
            }
          }
        }
      })

      await store.updateTaskState('acp-overflow', created.workspace_key, (state) => ({
        ...state,
        opencode_session_id: 'bloated_opencode',
        kimi_session_id: options.includeReviewerSession === false ? state.kimi_session_id : 'keep_kimi',
        actor_sessions: {
          ...(state.actor_sessions ?? {}),
          opencode: 'bloated_opencode',
          ...(options.includeReviewerSession === false ? {} : { kimi: 'keep_kimi' })
        }
      }))

      return {
        store,
        workspaceKey: created.workspace_key,
        methodLog,
        promptDir,
        modelLog,
        readyFile,
        runner: new BuddyRunner(store)
      }
    }

    function parseMethodLog(text: string): Array<{ method: string; sessionId?: string; promptIndex?: number }> {
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    }

    it.each([
      ['rpc', 'ACP Error with 超出上下文'],
      ['stopReason', 'prompt stopReason max_tokens'],
      ['chinese', 'Chinese 超出处理能力 wrapper']
    ] as const)('resets session and retries with session/new on %s overflow (%s)', async (overflowMode) => {
      const fixture = await setupOverflowFixture({
        overflowMode,
        includeReviewerSession: true,
        model: 'opus-4.6'
      })

      await fixture.runner.startTask('acp-overflow', {
        workspace_key: fixture.workspaceKey,
        actor: 'opencode'
      })

      const detail = await fixture.store.getTaskDetail('acp-overflow', fixture.workspaceKey)
      expect(detail.events.some((e) => e.type === 'actor.session_reset')).toBe(true)
      expect(detail.events.some((e) => e.type === 'actor.context_limit_detected')).toBe(true)
      expect(detail.state.status).not.toBe('FAILED')
      expect(detail.state.kimi_session_id).toBe('keep_kimi')
      expect(detail.state.actor_sessions?.kimi).toBe('keep_kimi')
      expect(detail.state.opencode_session_id).not.toBe('bloated_opencode')
      expect(detail.state.actor_sessions?.opencode).toBe('fresh_session')

      const methods = parseMethodLog(await readFile(fixture.methodLog, 'utf8'))
      expect(methods.some((m) => m.method === 'session/load' && m.sessionId === 'bloated_opencode')).toBe(true)
      expect(methods.some((m) => m.method === 'session/new')).toBe(true)
      const loadIndex = methods.findIndex((m) => m.method === 'session/load')
      const newIndex = methods.findIndex((m) => m.method === 'session/new')
      expect(newIndex).toBeGreaterThan(loadIndex)

      const firstPrompt = await readFile(join(fixture.promptDir, 'prompt-0.txt'), 'utf8')
      const secondPrompt = await readFile(join(fixture.promptDir, 'prompt-1.txt'), 'utf8')
      expect(firstPrompt).toContain('UNIQUE_CONTEXT_BLOB')
      expect(firstPrompt).not.toContain('上下文窗口限制已重置')
      expect(secondPrompt).toContain('上下文窗口限制已重置')
      expect(secondPrompt).toContain('请基于以上摘要继续工作')

      const recordedModel = JSON.parse(await readFile(fixture.modelLog, 'utf8'))
      expect(recordedModel.sessionId).toBe('fresh_session')
      expect(recordedModel.modelId ?? recordedModel.value).toBe('opus-4.6')
    })

    it('does not reset on non-overflow ACP errors', async () => {
      const fixture = await setupOverflowFixture({ overflowMode: 'other' })

      await expect(fixture.runner.startTask('acp-overflow', {
        workspace_key: fixture.workspaceKey,
        actor: 'opencode'
      })).rejects.toThrow(/Permission denied/)

      const detail = await fixture.store.getTaskDetail('acp-overflow', fixture.workspaceKey)
      expect(detail.events.some((e) => e.type === 'actor.session_reset')).toBe(false)
      expect(detail.state.status).toBe('FAILED')
      expect(detail.state.opencode_session_id).toBe('bloated_opencode')
      expect(detail.state.kimi_session_id).toBe('keep_kimi')

      const methods = parseMethodLog(await readFile(fixture.methodLog, 'utf8'))
      expect(methods.some((m) => m.method === 'session/new')).toBe(false)
      expect(methods.some((m) => m.method === 'session/load')).toBe(true)
    })

    it('does not reset when the user interrupts the ACP actor', async () => {
      const fixture = await setupOverflowFixture({ overflowMode: 'hang' })
      const startPromise = fixture.runner.startTask('acp-overflow', {
        workspace_key: fixture.workspaceKey,
        actor: 'opencode'
      })

      await vi.waitFor(async () => {
        await expect(access(fixture.readyFile)).resolves.toBeUndefined()
      })

      await fixture.runner.interrupt('acp-overflow', fixture.workspaceKey)
      await startPromise

      const detail = await fixture.store.getTaskDetail('acp-overflow', fixture.workspaceKey)
      expect(detail.state.status).toBe('PAUSED')
      expect(detail.events.some((e) => e.type === 'actor.session_reset')).toBe(false)
      expect(detail.events.some((e) => e.type === 'actor.interrupted')).toBe(true)
      expect(detail.state.opencode_session_id).toBe('bloated_opencode')
    }, 10_000)

    it('does not auto-reset when max_compact_retries is 0', async () => {
      const fixture = await setupOverflowFixture({
        overflowMode: 'rpc',
        maxCompactRetries: 0
      })

      await expect(fixture.runner.startTask('acp-overflow', {
        workspace_key: fixture.workspaceKey,
        actor: 'opencode'
      })).rejects.toThrow(/超出上下文/)

      const detail = await fixture.store.getTaskDetail('acp-overflow', fixture.workspaceKey)
      expect(detail.events.some((e) => e.type === 'actor.session_reset')).toBe(false)
      expect(detail.events.some((e) => e.type === 'actor.context_limit_detected')).toBe(false)
      expect(detail.state.status).toBe('FAILED')
      expect(detail.state.opencode_session_id).toBe('bloated_opencode')

      const methods = parseMethodLog(await readFile(fixture.methodLog, 'utf8'))
      expect(methods.some((m) => m.method === 'session/new')).toBe(false)
    })
  })
})
