import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempHome = join(tmpdir(), `buddy-test-session-insight-${process.pid}`)

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => tempHome
  }
})

const SESSION_ID = 'session_aaaa-bbbb'

function usageRecordLine(time: number, usage: Record<string, number>, model = 'kimi-code/k3'): string {
  return JSON.stringify({ type: 'usage.record', model, usage, usageScope: 'turn', time })
}

async function writeKimiWire(sessionId: string, agent: string, lines: string[]): Promise<void> {
  const dir = join(tempHome, '.kimi-code', 'sessions', 'wd_repo_abc123', sessionId, 'agents', agent)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'wire.jsonl'), lines.join('\n'))
}

describe('session-insight readKimiSessionInsight', () => {
  beforeEach(async () => {
    await mkdir(tempHome, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  it('aggregates usage records and latest model from the main agent wire file', async () => {
    await writeKimiWire(SESSION_ID, 'main', [
      JSON.stringify({ type: 'session.init', time: 100 }),
      usageRecordLine(1_000, { inputOther: 100, output: 10, inputCacheRead: 900, inputCacheCreation: 0 }),
      usageRecordLine(2_000, { inputOther: 200, output: 20, inputCacheRead: 800, inputCacheCreation: 0 }, 'kimi-code/k4')
    ])

    const { readKimiSessionInsight } = await import('../../../src/main/buddy/session-insight')
    const insight = await readKimiSessionInsight(SESSION_ID)
    expect(insight).toBeDefined()
    expect(insight!.records).toHaveLength(2)
    expect(insight!.records[0]).toEqual({ timeMs: 1_000, inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 })
    expect(insight!.records[1].inputTokens).toBe(200)
    expect(insight!.model).toBe('kimi-code/k4')
  })

  it('includes subagent wire files', async () => {
    await writeKimiWire(SESSION_ID, 'main', [
      usageRecordLine(1_000, { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 })
    ])
    await writeKimiWire(SESSION_ID, 'coder-1', [
      usageRecordLine(1_500, { inputOther: 50, output: 5, inputCacheRead: 500, inputCacheCreation: 0 })
    ])

    const { readKimiSessionInsight } = await import('../../../src/main/buddy/session-insight')
    const insight = await readKimiSessionInsight(SESSION_ID)
    expect(insight!.records).toHaveLength(2)
  })

  it('returns undefined when the session does not exist', async () => {
    const { readKimiSessionInsight } = await import('../../../src/main/buddy/session-insight')
    expect(await readKimiSessionInsight('session_nonexistent')).toBeUndefined()
  })

  it('skips malformed lines', async () => {
    await writeKimiWire(SESSION_ID, 'main', [
      'not json at all',
      '{"type":"usage.record","usage":',
      usageRecordLine(3_000, { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 0 })
    ])

    const { readKimiSessionInsight } = await import('../../../src/main/buddy/session-insight')
    const insight = await readKimiSessionInsight(SESSION_ID)
    expect(insight!.records).toHaveLength(1)
  })
})

describe('session-insight readOpencodeSessionModel', () => {
  beforeEach(async () => {
    await mkdir(tempHome, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  it('reads the latest assistant model from legacy JSON-file storage', async () => {
    const dir = join(tempHome, '.local', 'share', 'opencode', 'storage', 'message', 'ses_test123')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'msg_old.json'), JSON.stringify({
      role: 'assistant',
      time: { created: 100 },
      model: { providerID: 'agnes', modelID: 'agnes-2.0-flash' }
    }))
    await writeFile(join(dir, 'msg_new.json'), JSON.stringify({
      role: 'assistant',
      time: { created: 200 },
      model: { providerID: 'opencode', modelID: 'deepseek-v4-flash-free' }
    }))

    const { readOpencodeSessionModel } = await import('../../../src/main/buddy/session-insight')
    expect(await readOpencodeSessionModel('ses_test123')).toBe('opencode/deepseek-v4-flash-free')
  })

  it('returns undefined when neither storage exists', async () => {
    const { readOpencodeSessionModel } = await import('../../../src/main/buddy/session-insight')
    expect(await readOpencodeSessionModel('ses_missing')).toBeUndefined()
  })

  it('rejects unsafe session ids without touching the db', async () => {
    const { readOpencodeSessionModel } = await import('../../../src/main/buddy/session-insight')
    expect(await readOpencodeSessionModel("x'; DROP TABLE message; --")).toBeUndefined()
  })
})
