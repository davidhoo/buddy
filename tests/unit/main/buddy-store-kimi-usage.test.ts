import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempHome = join(tmpdir(), `buddy-test-store-kimi-usage-${process.pid}`)

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => tempHome
  }
})

const SESSION_ID = 'session_aaaa-bbbb'
const WORKSPACE_KEY = 'abc123def456'
const RUN_ID = 'run_1784561664618_567073'

async function setupTask(root: string): Promise<void> {
  const taskDir = join(root, 'workspaces', WORKSPACE_KEY, 'tasks', 'demo')
  await mkdir(join(taskDir, 'artifacts'), { recursive: true })
  await writeFile(join(taskDir, 'settings.json'), JSON.stringify({
    protocol_version: '1',
    countdown_seconds: 30,
    flow_policy: 'claude_then_codex',
    role_mode: 'kimi_implements',
    launchers: {}
  }))
  await writeFile(join(taskDir, 'state.json'), JSON.stringify({
    status: 'DONE',
    round: 1,
    next_actor: 'kimi',
    repo_root: '/tmp/repo',
    kimi_session_id: SESSION_ID
  }))
  // kimi events: role-based lines without usage/model (as the CLI actually emits)
  await writeFile(join(taskDir, 'artifacts', `${RUN_ID}-events.jsonl`), [
    JSON.stringify({ role: 'assistant', content: '{"type":"chat","content":"done"}' }),
    JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: SESSION_ID })
  ].join('\n'))
  // transcript: one kimi run ending at 15:34:57Z after 32579ms
  await writeFile(join(taskDir, 'transcript.jsonl'), [
    JSON.stringify({ role: 'kimi', content: '...', ts: '2026-07-20T15:34:57.000Z', meta: { run_id: RUN_ID, elapsed_ms: 32579, round: 1 } })
  ].join('\n'))
}

async function writeKimiWire(lines: string[]): Promise<void> {
  const dir = join(tempHome, '.kimi-code', 'sessions', 'wd_repo_abc123', SESSION_ID, 'agents', 'main')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'wire.jsonl'), lines.join('\n'))
}

function usageRecord(timeMs: number, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'usage.record', model: 'kimi-code/k3', usage, usageScope: 'turn', time: timeMs })
}

describe('BuddyStore getTaskStats kimi usage attribution', () => {
  beforeEach(async () => {
    await mkdir(tempHome, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  it('attributes wire.jsonl usage to the run window and fills the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-kimi-usage-'))
    await setupTask(root)
    // Run window: [15:34:57.000 - 32.579s - 5s, 15:34:57.000 + 5s]
    await writeKimiWire([
      usageRecord(Date.parse('2026-07-20T15:34:40.000Z'), { inputOther: 100, output: 10, inputCacheRead: 900, inputCacheCreation: 0 }),
      usageRecord(Date.parse('2026-07-20T15:34:55.000Z'), { inputOther: 200, output: 20, inputCacheRead: 800, inputCacheCreation: 0 }),
      // Outside every run window (e.g. health-check ping) — must not be counted
      usageRecord(Date.parse('2026-07-20T15:00:00.000Z'), { inputOther: 999, output: 999, inputCacheRead: 999, inputCacheCreation: 0 })
    ])

    const { BuddyStore } = await import('../../../src/main/buddy/store')
    const store = new BuddyStore(root)
    const stats = await store.getTaskStats('demo', WORKSPACE_KEY)

    expect(stats).not.toBeNull()
    expect(stats!.actors).toHaveLength(1)
    const kimi = stats!.actors[0]
    expect(kimi.actor).toBe('kimi')
    expect(kimi.inputTokens).toBe(300)
    expect(kimi.outputTokens).toBe(30)
    expect(kimi.cacheReadTokens).toBe(1700)
    expect(kimi.model).toBe('kimi-code/k3')
    expect(stats!.totalInputTokens).toBe(300)
    expect(stats!.totalCacheReadTokens).toBe(1700)
  })

  it('leaves tokens at zero when no wire file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-store-kimi-usage-'))
    await setupTask(root)

    const { BuddyStore } = await import('../../../src/main/buddy/store')
    const store = new BuddyStore(root)
    const stats = await store.getTaskStats('demo', WORKSPACE_KEY)

    expect(stats).not.toBeNull()
    expect(stats!.actors[0].inputTokens).toBe(0)
    expect(stats!.actors[0].outputTokens).toBe(0)
  })
})
