import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Read per-run model / token usage that actor CLIs do NOT include in their
 * stdout stream, from their on-disk session state:
 *
 * - kimi (Kimi Code CLI): stream-json stdout carries only assistant/tool/meta
 *   messages. Token usage and the actual model live in the session wire file:
 *   ~/.kimi-code/sessions/<wd>/<sessionId>/agents/<agent>/wire.jsonl
 *   entries of type "usage.record" → usage.{inputOther, output, inputCacheRead}
 *
 * - opencode: stdout JSON events carry tokens in step_finish but no model.
 *   The model lives in per-session storage:
 *   - newer versions: ~/.local/share/opencode/opencode.db (SQLite, message table)
 *   - older versions: ~/.local/share/opencode/storage/message/<sessionId>/*.json
 */

export interface KimiUsageRecord {
  timeMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export interface KimiSessionInsight {
  records: KimiUsageRecord[]
  model?: string
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Locate every wire.jsonl (main agent + subagents) for a kimi session id. */
async function findKimiWireFiles(sessionId: string): Promise<string[]> {
  const base = join(homedir(), '.kimi-code', 'sessions')
  const results: string[] = []
  let wdDirs: string[] = []
  try {
    wdDirs = await readdir(base)
  } catch {
    return results
  }
  for (const wd of wdDirs) {
    const agentsDir = join(base, wd, sessionId, 'agents')
    let agents: string[] = []
    try {
      agents = await readdir(agentsDir)
    } catch {
      continue
    }
    for (const agent of agents) {
      results.push(join(agentsDir, agent, 'wire.jsonl'))
    }
  }
  return results
}

/**
 * Parse a kimi session's wire files into usage records (one per LLM step)
 * plus the latest model seen. Returns undefined when nothing was found.
 */
export async function readKimiSessionInsight(sessionId: string): Promise<KimiSessionInsight | undefined> {
  if (!sessionId) return undefined
  const records: KimiUsageRecord[] = []
  let model: string | undefined
  for (const file of await findKimiWireFiles(sessionId)) {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line.includes('"usage.record"')) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.type !== 'usage.record') continue
        const usage = entry.usage as Record<string, unknown> | undefined
        if (!usage) continue
        records.push({
          timeMs: asNumber(entry.time),
          inputTokens: asNumber(usage.inputOther),
          outputTokens: asNumber(usage.output),
          cacheReadTokens: asNumber(usage.inputCacheRead)
        })
        if (typeof entry.model === 'string' && entry.model) model = entry.model
      } catch {
        // Malformed line — skip
      }
    }
  }
  if (records.length === 0 && !model) return undefined
  return { records, model }
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId)
}

/** opencode ≥ new storage: model from the SQLite message table via the sqlite3 CLI. */
async function readOpencodeModelFromDb(sessionId: string): Promise<string | undefined> {
  if (!isSafeSessionId(sessionId)) return undefined
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  const query = `SELECT json_extract(data,'$.providerID') || '/' || json_extract(data,'$.modelID') FROM message WHERE session_id='${sessionId}' AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.modelID') IS NOT NULL ORDER BY time_created DESC LIMIT 1;`
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('sqlite3', ['-readonly', dbPath, query], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(undefined)
      return
    }
    const chunks: Buffer[] = []
    child.stdout!.on('data', (c: Buffer) => chunks.push(c))
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve(undefined)
    }, 5_000)
    once(child, 'exit').then((exitArgs: unknown[]) => {
      clearTimeout(timer)
      const code = exitArgs[0] as number | null
      const out = Buffer.concat(chunks).toString('utf8').trim()
      if (code === 0 && out && out !== '/') resolve(out)
      else resolve(undefined)
    }).catch(() => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

/** opencode old storage: JSON files under storage/message/<sessionId>/. */
async function readOpencodeModelFromFiles(sessionId: string): Promise<string | undefined> {
  const dir = join(homedir(), '.local', 'share', 'opencode', 'storage', 'message', sessionId)
  let files: string[] = []
  try {
    files = await readdir(dir)
  } catch {
    return undefined
  }
  let latestMs = -1
  let model: string | undefined
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, name), 'utf8')
      const msg = JSON.parse(raw) as Record<string, unknown>
      const m = msg.model as Record<string, unknown> | undefined
      const providerID = m?.providerID
      const modelID = m?.modelID
      if (typeof providerID !== 'string' || typeof modelID !== 'string' || !modelID) continue
      const created = asNumber((msg.time as Record<string, unknown> | undefined)?.created)
      if (created >= latestMs) {
        latestMs = created
        model = providerID ? `${providerID}/${modelID}` : modelID
      }
    } catch {
      // Unreadable file — skip
    }
  }
  return model
}

/**
 * Detect the model an opencode session actually used, from its local session
 * storage. Tries the legacy JSON-file storage first, then the SQLite database.
 */
export async function readOpencodeSessionModel(sessionId: string): Promise<string | undefined> {
  if (!sessionId) return undefined
  const fromFiles = await readOpencodeModelFromFiles(sessionId)
  if (fromFiles) return fromFiles
  return readOpencodeModelFromDb(sessionId)
}
