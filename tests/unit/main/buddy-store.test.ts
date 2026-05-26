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
    await writeFile(join(taskDir, 'events.jsonl'), '{"seq":1,"type":"task.created","ts":"2026-05-26T00:00:00.000Z","payload":{}}\n')

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
      events: [expect.objectContaining({ seq: 1 })]
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
