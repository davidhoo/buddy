import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyStore read model', () => {
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
})
