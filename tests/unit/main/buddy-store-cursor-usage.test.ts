import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const WORKSPACE_KEY = 'cursor-usage-workspace'
const roots: string[] = []

interface CursorUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

async function createTaskDir(): Promise<{ root: string; taskDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'buddy-store-cursor-usage-'))
  roots.push(root)
  const taskDir = join(root, 'workspaces', WORKSPACE_KEY, 'tasks', 'demo')
  await mkdir(join(taskDir, 'artifacts'), { recursive: true })
  return { root, taskDir }
}

async function writeCursorRun(
  taskDir: string,
  runId: string,
  usage: CursorUsage,
  durationMs: number
): Promise<void> {
  await writeFile(join(taskDir, 'artifacts', `${runId}-events.jsonl`), [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'cursor-session',
      model: 'Auto'
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'cursor-session',
      duration_ms: durationMs,
      usage
    })
  ].join('\n'))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('BuddyStore Cursor usage', () => {
  it('parses camelCase token usage from the Cursor result event', async () => {
    const { root, taskDir } = await createTaskDir()
    const runId = 'run_cursor_1'
    await writeCursorRun(taskDir, runId, {
      inputTokens: 25_035,
      outputTokens: 2_556,
      cacheReadTokens: 79_104,
      cacheWriteTokens: 999
    }, 31_498)

    const { BuddyStore } = await import('../../../src/main/buddy/store')
    const summary = await new BuddyStore(root).getRoundEvents(
      'demo',
      runId,
      WORKSPACE_KEY,
      'cursor'
    )

    expect(summary).toMatchObject({
      inputTokens: 25_035,
      outputTokens: 2_556,
      cacheReadTokens: 79_104,
      durationMs: 31_498,
      model: 'Auto'
    })
  })

  it('aggregates Cursor usage across task rounds', async () => {
    const { root, taskDir } = await createTaskDir()
    await writeCursorRun(taskDir, 'run_cursor_1', {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0
    }, 1_500)
    await writeCursorRun(taskDir, 'run_cursor_2', {
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 0
    }, 2_500)
    await writeFile(join(taskDir, 'transcript.jsonl'), [
      JSON.stringify({
        role: 'cursor',
        content: 'round one',
        ts: '2026-08-11T10:00:00.000Z',
        meta: { run_id: 'run_cursor_1', elapsed_ms: 2_000, round: 1 }
      }),
      JSON.stringify({
        role: 'cursor',
        content: 'round two',
        ts: '2026-08-11T10:01:00.000Z',
        meta: { run_id: 'run_cursor_2', elapsed_ms: 3_000, round: 2 }
      })
    ].join('\n'))

    const { BuddyStore } = await import('../../../src/main/buddy/store')
    const stats = await new BuddyStore(root).getTaskStats('demo', WORKSPACE_KEY)

    expect(stats).not.toBeNull()
    expect(stats!.actors).toEqual([expect.objectContaining({
      actor: 'cursor',
      model: 'Auto',
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 3_000,
      durationMs: 4_000,
      rounds: 2
    })])
    expect(stats).toMatchObject({
      totalInputTokens: 300,
      totalOutputTokens: 30,
      totalCacheReadTokens: 3_000,
      totalDurationMs: 4_000,
      totalRounds: 2
    })
  })
})
