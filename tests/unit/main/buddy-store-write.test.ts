import { access, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('BuddyStore writes', () => {
  it('creates a task using the buddy-python file layout and initial contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-write-'))
    const repoRoot = await mkdtemp(join(tmpdir(), 'buddy-write-repo-'))
    const store = new BuddyStore(root)

    const result = await store.createTask({
      task_id: 'demo',
      repo_root: repoRoot,
      task_text: 'Build it\n\n',
      context_text: 'Use tests\n\n'
    })
    const expectedRepoRoot = await realpath(repoRoot)

    const taskDir = join(root, 'workspaces', result.workspace_key, 'tasks', 'demo')
    expect(result.workspace_key).toMatch(/^buddy-write-repo-.*-[a-f0-9]{12}$/)
    expect(result.path).toBe(taskDir)

    await expect(readFile(join(root, 'workspaces', result.workspace_key, 'workspace.json'), 'utf8')).resolves.toContain(`"default_repo_root": "${expectedRepoRoot}"`)
    await expect(readFile(join(taskDir, 'task.md'), 'utf8')).resolves.toBe('Build it\n')
    await expect(readFile(join(taskDir, 'context.md'), 'utf8')).resolves.toBe('Use tests\n')
    await expect(readFile(join(taskDir, 'status'), 'utf8')).resolves.toBe('READY\n')
    await expect(access(join(taskDir, 'rounds'))).resolves.toBeUndefined()
    await expect(access(join(taskDir, 'artifacts'))).resolves.toBeUndefined()
    await expect(access(join(taskDir, '.buddy.lock'))).resolves.toBeUndefined()
    await expect(access(join(taskDir, 'task.json'))).rejects.toThrow()
    await expect(access(join(taskDir, 'transcript.md'))).rejects.toThrow()
    await expect(access(join(taskDir, 'transcript.jsonl'))).rejects.toThrow()

    const settings = JSON.parse(await readFile(join(taskDir, 'settings.json'), 'utf8'))
    expect(settings).toMatchObject({
      protocol_version: '1',
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      max_consecutive_failures: 10,
      seed_claude_session_id: '',
      seed_codex_thread_id: '',
      launchers: {
        claude: { command: 'claude', env: {}, timeout_seconds: 7200 },
        codex: { command: 'codex', env: {}, timeout_seconds: 7200 }
      }
    })

    const state = JSON.parse(await readFile(join(taskDir, 'state.json'), 'utf8'))
    expect(state).toMatchObject({
      protocol_version: '1',
      task_id: 'demo',
      repo_root: expectedRepoRoot,
      status: 'READY',
      round: 0,
      rounds_in_window: 0,
      next_actor: 'claude',
      claude_session_id: null,
      codex_thread_id: null,
      context_sent: { claude: false, codex: false },
      active_run: null,
      countdown: null,
      last_error: null,
      event_seq: 1,
      transcript_seq: 0,
      consecutive_failures: 0
    })
    expect(state.context_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(state.created_at).toMatch(/Z$/)
    expect(state.updated_at).toMatch(/Z$/)

    const event = JSON.parse((await readFile(join(taskDir, 'events.jsonl'), 'utf8')).trim())
    expect(event).toMatchObject({
      payload: { task_id: 'demo' },
      seq: 1,
      task_id: 'demo',
      type: 'task.created'
    })
  })

  it('uses global CLI settings when creating a task without explicit launchers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-write-global-'))
    const store = new BuddyStore(root)
    await store.updateGlobalSettings({
      countdown_seconds: 12,
      launchers: {
        codex: {
          command: 'codex --profile native',
          env: { BUDDY_MODE: 'native' },
          timeout_seconds: 123
        }
      }
    })

    const result = await store.createTask({
      task_id: 'demo',
      repo_root: '/tmp/repo'
    })

    const taskDir = join(root, 'workspaces', result.workspace_key, 'tasks', 'demo')
    const settings = JSON.parse(await readFile(join(taskDir, 'settings.json'), 'utf8'))
    expect(settings.launchers.codex).toMatchObject({
      command: 'codex --profile native',
      env: { BUDDY_MODE: 'native' },
      timeout_seconds: 123
    })
  })

  it('deduplicates task IDs by appending numeric suffixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-write-dedup-'))
    const repoRoot = await mkdtemp(join(tmpdir(), 'buddy-write-dedup-repo-'))
    const store = new BuddyStore(root)

    const first = await store.createTask({ task_id: 'demo', repo_root: repoRoot })
    expect(first.task).toBe('demo')

    const second = await store.createTask({ task_id: 'demo', repo_root: repoRoot })
    expect(second.task).toBe('demo_2')

    const third = await store.createTask({ task_id: 'demo', repo_root: repoRoot })
    expect(third.task).toBe('demo_3')

    // Verify all three tasks exist with their own directories
    for (const id of ['demo', 'demo_2', 'demo_3']) {
      const taskDir = join(root, 'workspaces', first.workspace_key, 'tasks', id)
      await expect(access(join(taskDir, 'settings.json'))).resolves.toBeUndefined()
    }
  })

  it('appends transcript rows using buddy-python jsonl formatting and state sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-write-transcript-'))
    const store = new BuddyStore(root)
    const created = await store.createTask({
      task_id: 'demo',
      repo_root: root
    })
    const taskDir = join(root, 'workspaces', created.workspace_key, 'tasks', 'demo')

    await writeFile(
      join(taskDir, 'transcript.jsonl'),
      '{"content": "legacy", "meta": {}, "role": "human", "seq": 99, "ts": "2026-05-26T00:00:00Z"}\n'
    )

    await store.appendTranscript('demo', created.workspace_key, 'human', '补充一下', { source: 'run_once' })
    await store.appendTranscript('demo', created.workspace_key, 'codex', '## 结果\n\n- 完成: yes\n- 路径: `src/main`\n', {
      round: 1,
      run_id: 'run-001',
      elapsed_ms: 12,
      buddy_type: 'chat'
    })

    const lines = (await readFile(join(taskDir, 'transcript.jsonl'), 'utf8')).trimEnd().split('\n')
    expect(lines[1]).toMatch(/^\{"content": "补充一下", "meta": \{"source": "run_once"\}, "role": "human", "seq": 1, "ts": ".*Z"\}$/)
    expect(lines[2]).toMatch(/^\{"content": "## 结果\\n\\n- 完成: yes\\n- 路径: `src\/main`\\n", "meta": \{"buddy_type": "chat", "elapsed_ms": 12, "round": 1, "run_id": "run-001"\}, "role": "codex", "seq": 2, "ts": ".*Z"\}$/)

    const state = JSON.parse(await readFile(join(taskDir, 'state.json'), 'utf8'))
    expect(state.transcript_seq).toBe(2)
  })
})
