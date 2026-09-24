import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const WORKSPACE_KEY = 'agy-duration-workspace'
const roots: string[] = []

async function createTaskDir(): Promise<{ root: string; taskDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'buddy-store-agy-duration-'))
  roots.push(root)
  const taskDir = join(root, 'workspaces', WORKSPACE_KEY, 'tasks', 'demo')
  await mkdir(join(taskDir, 'artifacts'), { recursive: true })
  return { root, taskDir }
}

async function writeAgyRun(
  taskDir: string,
  runId: string,
  durationSeconds: number,
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number }
): Promise<void> {
  await writeFile(join(taskDir, 'artifacts', `${runId}-events.jsonl`), [
    JSON.stringify({
      event: 'init',
      conversation_id: 'agy-conv-1',
      init: { cwd: '/tmp' }
    }),
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'agy-conv-1',
        status: 'SUCCESS',
        response: 'ok',
        duration_seconds: durationSeconds,
        usage
      }
    })
  ].join('\n'))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('BuddyStore agy duration', () => {
  it('does not treat agy duration_seconds as per-run duration in round events', async () => {
    const { root, taskDir } = await createTaskDir()
    const runId = 'run_agy_1'
    await writeAgyRun(taskDir, runId, 356_359.295869, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 50
    })

    const { BuddyStore } = await import('../../../src/main/buddy/store')
    const summary = await new BuddyStore(root).getRoundEvents(
      'demo',
      runId,
      WORKSPACE_KEY,
      'agy'
    )

    expect(summary).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 50
    })
    expect(summary?.durationMs).toBeUndefined()
  })

  it('aggregates task duration from wall-clock elapsed_ms, not cumulative duration_seconds', async () => {
    const { root, taskDir } = await createTaskDir()
    // Mimic real agy: duration_seconds grows across resumes (conversation lifetime).
    await writeAgyRun(taskDir, 'run_agy_1', 560.183143, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 50
    })
    await writeAgyRun(taskDir, 'run_agy_2', 356_359.295869, {
      input_tokens: 200,
      output_tokens: 20,
      cache_read_tokens: 80
    })
    await writeFile(join(taskDir, 'transcript.jsonl'), [
      JSON.stringify({
        role: 'agy',
        content: 'round one',
        ts: '2026-09-17T04:29:30.000Z',
        meta: { run_id: 'run_agy_1', elapsed_ms: 105_310, round: 1 }
      }),
      JSON.stringify({
        role: 'agy',
        content: 'round two',
        ts: '2026-09-21T07:19:29.000Z',
        meta: { run_id: 'run_agy_2', elapsed_ms: 22_168, round: 2 }
      })
    ].join('\n'))

    const { BuddyStore } = await import('../../../src/main/buddy/store')
    const stats = await new BuddyStore(root).getTaskStats('demo', WORKSPACE_KEY)

    expect(stats).not.toBeNull()
    expect(stats!.actors).toEqual([expect.objectContaining({
      actor: 'agy',
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 130,
      durationMs: 127_478,
      rounds: 2
    })])
    expect(stats!.totalDurationMs).toBe(127_478)
    // Must not sum conversation-lifetime seconds into ~4 days.
    expect(stats!.totalDurationMs).toBeLessThan(60_000_000)
  })
})
