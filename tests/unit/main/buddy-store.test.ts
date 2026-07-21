import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyStore read model', () => {
  it('creates buddy-python compatible initial state from implementer settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-create-python-parity-'))
    const store = new BuddyStore(root)

    const created = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo',
      task_text: '# Demo',
      context_text: 'background',
      settings: {
        role_mode: 'codex_implements',
        implementer_actor: 'opencode',
        reviewer_actor: 'kimi',
        launchers: {}
      }
    })

    const detail = await store.getTaskDetail('demo', created.workspace_key)

    expect(detail.state.round).toBe(0)
    expect(detail.state.rounds_in_window).toBe(0)
    expect(detail.state.next_actor).toBe('opencode')
    expect(detail.state.context_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(detail.state.context_sent).toEqual({
      claude: false,
      codex: false,
      opencode: false,
      kimi: false,
      'cursor-agent': false
    })
    expect(detail.state.countdown).toBeNull()
    expect(detail.state.last_error).toBeNull()
  })

  it('loads tasks and task detail from the buddy data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      launchers: {}
    }))
    await writeFile(join(taskDir, 'state.json'), JSON.stringify({
      status: 'READY',
      round: 1,
      next_actor: 'claude',
      active_run: null,
      updated_at: '2026-05-26T00:00:00.000Z',
      repo_root: '/tmp/repo'
    }))
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({
      task_text: 'Build it',
      context_text: 'Use tests'
    }))
    await writeFile(join(taskDir, 'transcript.md'), 'hello transcript')
    await writeFile(join(taskDir, 'events.jsonl'), [
      '{"seq":1,"type":"task.created","ts":"2026-05-26T00:00:00.000Z","payload":{}}',
      '{"seq":2,"type":"message.added","ts":"2026-05-26T00:01:00.000Z","payload":{"message":"Please adjust"}}',
      '{"seq":3,"type":"actor.completed","actor":"codex","ts":"2026-05-26T00:02:00.000Z","payload":{"text":"Done"}}',
      ''
    ].join('\n'))

    const store = new BuddyStore(root)

    await expect(store.getTasks()).resolves.toEqual([
      expect.objectContaining({
        task_id: 'demo',
        workspace_key: 'abc123def456',
        status: 'READY',
        repo_root: '/tmp/repo'
      })
    ])

    await expect(store.getTaskDetail('demo', 'abc123def456')).resolves.toMatchObject({
      task_id: 'demo',
      workspace_key: 'abc123def456',
      task_text: 'Build it',
      context_text: 'Use tests',
      transcript: [],
      events: expect.arrayContaining([
        expect.objectContaining({ seq: 1 }),
        expect.objectContaining({ seq: 2 }),
        expect.objectContaining({ seq: 3 })
      ])
    })
  })

  it('does not derive chat transcript from events without transcript jsonl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-legacy-events-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      launchers: {}
    }))
    await writeFile(join(taskDir, 'state.json'), JSON.stringify({
      status: 'READY',
      round: 1,
      next_actor: 'claude',
      active_run: null
    }))
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({
      task_text: 'Build it',
      context_text: ''
    }))
    await writeFile(join(taskDir, 'events.jsonl'), [
      '{"seq":1,"type":"human.message","ts":"2026-05-26T00:01:00.000Z","payload":{"content":"More context"}}',
      '{"seq":2,"type":"assistant","actor":"claude","ts":"2026-05-26T00:02:00.000Z","payload":{"message":{"content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"```json\\n{\\"type\\":\\"chat\\",\\"content\\":\\"I will do it\\"}\\n```"}]}}}',
      ''
    ].join('\n'))

    const store = new BuddyStore(root)

    await expect(store.getTaskDetail('demo', 'abc123def456')).resolves.toMatchObject({
      transcript: []
    })
  })

  it('loads transcript jsonl as the conversation source of truth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-jsonl-transcript-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      launchers: {}
    }))
    await writeFile(join(taskDir, 'state.json'), JSON.stringify({
      status: 'DONE',
      round: 2,
      next_actor: 'claude',
      active_run: null
    }))
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({
      task_text: 'Build it',
      context_text: ''
    }))
    await writeFile(join(taskDir, 'transcript.jsonl'), [
      '{"seq":1,"ts":"2026-05-26T00:01:00.000Z","role":"claude","content":"Claude final","meta":{"buddy_type":"chat","round":1,"run_id":"run-001","elapsed_ms":1000}}',
      '{"seq":2,"ts":"2026-05-26T00:02:00.000Z","role":"system","content":"Claude Code 请求结束任务，等待 Codex 确认。","meta":{"kind":"round_notice","round":2}}',
      ''
    ].join('\n'))
    await writeFile(join(taskDir, 'events.jsonl'), [
      '{"seq":1,"type":"assistant","actor":"claude","ts":"2026-05-26T00:00:30.000Z","run_id":"run-001","payload":{"message":{"content":[{"type":"text","text":"Started run."}]}}}',
      ''
    ].join('\n'))

    const store = new BuddyStore(root)

    await expect(store.getTaskDetail('demo', 'abc123def456')).resolves.toMatchObject({
      transcript: [
        expect.objectContaining({
          role: 'claude',
          content: 'Claude final',
          meta: expect.objectContaining({ buddy_type: 'chat', round: 1, elapsed_ms: 1000 })
        }),
        expect.objectContaining({
          role: 'system',
          content: 'Claude Code 请求结束任务，等待 Codex 确认。',
          meta: expect.objectContaining({ kind: 'round_notice', round: 2 })
        })
      ]
    })
  })

  it('does not derive chat transcript from legacy final actor events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-legacy-final-events-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      launchers: {}
    }))
    await writeFile(join(taskDir, 'state.json'), JSON.stringify({
      status: 'DONE',
      round: 5,
      next_actor: 'codex',
      active_run: null
    }))
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({
      task_text: 'Build it',
      context_text: ''
    }))
    await writeFile(join(taskDir, 'events.jsonl'), [
      '{"seq":1,"type":"assistant","actor":"claude","ts":"2026-05-26T00:01:00.000Z","run_id":"run-003","payload":{"message":{"content":[{"type":"text","text":"现在验证类型检查。"}]}}}',
      '{"seq":2,"type":"result","actor":"claude","ts":"2026-05-26T00:01:10.000Z","run_id":"run-003","payload":{"result":"```json\\n{\\"type\\":\\"chat\\",\\"content\\":\\"Claude final\\"}\\n```"}}',
      '{"seq":3,"type":"actor.finished","actor":"claude","ts":"2026-05-26T00:01:10.000Z","run_id":"run-003","payload":{"elapsed_ms":38000}}',
      '{"seq":4,"type":"item.completed","actor":"codex","ts":"2026-05-26T00:03:00.000Z","run_id":"run-004","payload":{"item":{"type":"agent_message","text":"{\\"type\\":\\"break\\",\\"content\\":\\"Codex final\\"}"}}}',
      '{"seq":5,"type":"actor.finished","actor":"codex","ts":"2026-05-26T00:03:00.000Z","run_id":"run-004","payload":{"elapsed_ms":119835}}',
      '{"seq":6,"type":"break.pending","actor":"codex","ts":"2026-05-26T00:03:00.000Z","run_id":"run-004","payload":{"pending_confirmation_from":"claude"}}',
      '{"seq":7,"type":"actor.started","actor":"claude","ts":"2026-05-26T00:03:30.000Z","run_id":"run-005","payload":{"message":"Started run."}}',
      '{"seq":8,"type":"result","actor":"claude","ts":"2026-05-26T00:03:35.000Z","run_id":"run-005","payload":{"result":"{\\"type\\":\\"break\\",\\"content\\":\\"Claude confirms\\"}"}}',
      '{"seq":9,"type":"actor.finished","actor":"claude","ts":"2026-05-26T00:03:35.000Z","run_id":"run-005","payload":{"elapsed_ms":5031}}',
      '{"seq":10,"type":"task.done","ts":"2026-05-26T00:03:35.000Z","payload":{"first_actor":"codex","second_actor":"claude","round":5,"reason":"dual_break_confirmed"}}',
      ''
    ].join('\n'))

    const store = new BuddyStore(root)
    const detail = await store.getTaskDetail('demo', 'abc123def456')

    expect(detail.transcript).toEqual([])
  })

  it('does not fall back to transcript markdown for chat transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-transcript-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      launchers: {}
    }))
    await writeFile(join(taskDir, 'state.json'), JSON.stringify({
      status: 'READY',
      round: 1,
      next_actor: 'claude',
      active_run: null
    }))
    await writeFile(join(taskDir, 'task.json'), JSON.stringify({
      task_text: 'Build it',
      context_text: ''
    }))
    await writeFile(join(taskDir, 'transcript.md'), [
      '# demo',
      '',
      '## Task',
      'Build it',
      '',
      '## Human',
      'Please continue',
      '',
      '## Claude',
      'Continuing now',
      ''
    ].join('\n'))
    await writeFile(join(taskDir, 'events.jsonl'), '{"seq":1,"type":"task.created","ts":"2026-05-26T00:00:00.000Z","payload":{}}\n')

    const store = new BuddyStore(root)

    await expect(store.getTaskDetail('demo', 'abc123def456')).resolves.toMatchObject({
      transcript: []
    })
  })

  it('loads legacy markdown tasks with nullable state fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-legacy-'))
    const taskDir = join(root, 'workspaces', 'buddy-macos-31bd2c697ab4', 'tasks', '设置页基本功能')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(root, 'workspaces', 'buddy-macos-31bd2c697ab4', 'workspace.json'), JSON.stringify({
      default_repo_root: '/tmp/buddy-macos'
    }))
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      launchers: {}
    }))
    await writeFile(join(taskDir, 'state.json'), JSON.stringify({
      status: 'PAUSED',
      round: 0,
      next_actor: 'claude',
      active_run: null,
      countdown: null,
      claude_session_id: null,
      codex_thread_id: null,
      updated_at: '2026-05-25T08:56:45Z',
      repo_root: '/tmp/buddy-macos'
    }))
    await writeFile(join(taskDir, 'task.md'), 'Legacy task text')
    await writeFile(join(taskDir, 'context.md'), 'Legacy context text')
    await writeFile(join(taskDir, 'events.jsonl'), '{"seq":1,"type":"task.created","ts":"2026-05-25T08:00:00.000Z","payload":{}}\n')

    const store = new BuddyStore(root)

    await expect(store.getTasks()).resolves.toEqual([
      expect.objectContaining({
        task_id: '设置页基本功能',
        workspace_key: 'buddy-macos-31bd2c697ab4',
        status: 'PAUSED',
        repo_root: '/tmp/buddy-macos'
      })
    ])

    await expect(store.getTaskDetail('设置页基本功能', 'buddy-macos-31bd2c697ab4')).resolves.toMatchObject({
      task_text: 'Legacy task text',
      context_text: 'Legacy context text'
    })
  })

  it('parses Cursor Agent camelCase token usage from a result event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-cursor-usage-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(join(taskDir, 'artifacts'), { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      role_mode: 'claude_implements',
      launchers: {
        'cursor-agent': { command: 'agent', backend: 'cursor', env: {}, timeout_seconds: 600 }
      }
    }))
    await writeFile(join(taskDir, 'artifacts', 'run-1-events.jsonl'), [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"{\\"type\\":\\"chat\\",\\"content\\":\\"ok\\"}"}]},"session_id":"s1"}',
      '{"type":"result","subtype":"success","duration_ms":19095,"result":"{\\"type\\":\\"chat\\",\\"content\\":\\"ok\\"}","session_id":"s1","usage":{"inputTokens":3,"outputTokens":472,"cacheReadTokens":216683,"cacheWriteTokens":6001}}',
      ''
    ].join('\n'))

    const store = new BuddyStore(root)
    const summary = await store.getRoundEvents('demo', 'run-1', 'abc123def456', 'cursor-agent')

    expect(summary).not.toBeNull()
    expect(summary?.inputTokens).toBe(6004)
    expect(summary?.outputTokens).toBe(472)
    expect(summary?.cacheReadTokens).toBe(216683)
    expect(summary?.durationMs).toBe(19095)
  })

  it('uses aggregate Claude modelUsage and counts cache creation as input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-claude-usage-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(join(taskDir, 'artifacts'), { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      role_mode: 'claude_implements',
      launchers: {
        claude: { command: 'claude', backend: 'claude', env: {}, timeout_seconds: 600 }
      }
    }))
    await writeFile(join(taskDir, 'artifacts', 'run-1-events.jsonl'), [
      '{"type":"system","subtype":"init","model":"claude-opus-4-8"}',
      '{"type":"result","duration_ms":1000,"usage":{"input_tokens":1,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":3},"modelUsage":{"claude-opus-4-8":{"inputTokens":5,"cacheCreationInputTokens":100,"cacheReadInputTokens":200,"outputTokens":50}}}',
      ''
    ].join('\n'))

    const store = new BuddyStore(root)
    const summary = await store.getRoundEvents('demo', 'run-1', 'abc123def456', 'claude')

    expect(summary).toMatchObject({
      inputTokens: 105,
      outputTokens: 50,
      cacheReadTokens: 200,
      tokenUsageScope: 'run',
      model: 'claude-opus-4-8'
    })
  })

  it('takes the latest cumulative Codex counters once per resumed thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-codex-usage-'))
    const taskDir = join(root, 'workspaces', 'abc123def456', 'tasks', 'demo')
    await mkdir(join(taskDir, 'artifacts'), { recursive: true })
    await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
      protocol_version: '1',
      countdown_seconds: 30,
      role_mode: 'codex_implements',
      launchers: {
        codex: { command: 'codex', backend: 'codex', env: {}, timeout_seconds: 600 }
      }
    }))
    await writeFile(join(taskDir, 'transcript.jsonl'), [
      '{"seq":1,"ts":"2026-07-20T00:00:00Z","role":"codex","content":"one","meta":{"run_id":"run-1","round":1,"elapsed_ms":1000}}',
      '{"seq":2,"ts":"2026-07-20T00:01:00Z","role":"codex","content":"two","meta":{"run_id":"run-2","round":2,"elapsed_ms":2000}}',
      ''
    ].join('\n'))
    await writeFile(join(taskDir, 'artifacts', 'run-1-events.jsonl'), [
      '{"type":"thread.started","thread_id":"thread-1"}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":10}}',
      ''
    ].join('\n'))
    await writeFile(join(taskDir, 'artifacts', 'run-2-events.jsonl'), [
      '{"type":"thread.started","thread_id":"thread-1"}',
      '{"type":"turn.completed","usage":{"input_tokens":180,"cached_input_tokens":110,"output_tokens":18}}',
      ''
    ].join('\n'))

    const store = new BuddyStore(root)
    const secondRound = await store.getRoundEvents('demo', 'run-2', 'abc123def456', 'codex')
    const stats = await store.getTaskStats('demo', 'abc123def456')
    const firstRoundStats = await store.getTaskStats('demo', 'abc123def456', 1)

    expect(secondRound).toMatchObject({
      inputTokens: 70,
      outputTokens: 18,
      cacheReadTokens: 110,
      tokenUsageScope: 'session',
      tokenUsageSessionId: 'thread-1'
    })
    expect(stats).toMatchObject({
      version: 2,
      totalInputTokens: 70,
      totalOutputTokens: 18,
      totalCacheReadTokens: 110,
      totalDurationMs: 3000,
      totalRounds: 2,
      actors: [
        expect.objectContaining({
          actor: 'codex',
          inputTokens: 70,
          outputTokens: 18,
          cacheReadTokens: 110,
          rounds: 2
        })
      ]
    })
    expect(firstRoundStats).toMatchObject({
      totalInputTokens: 40,
      totalOutputTokens: 10,
      totalCacheReadTokens: 60,
      totalRounds: 1
    })
  })
})
