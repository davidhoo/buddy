import { createHash } from 'node:crypto'
import { chmod, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { agentModelCacheSchema } from './schemas'
import { atomicWriteJson } from './store'
import type { AcpModelList } from '../../shared/types'

export const MODEL_CACHE_TTL_MS = 5 * 60 * 1000
/** After a failed probe, keep serving stale and avoid retry storms. */
export const MODEL_CACHE_ERROR_TTL_MS = 45 * 1000
export const MODEL_CACHE_FILE = 'agent-model-cache.json'
export const MODEL_CACHE_SCHEMA_VERSION = 2 as const

export type ModelCacheMemEntry = {
  list: AcpModelList
  expiresAt: number
}

type DiskEntry = {
  models: AcpModelList['models']
  currentModelId?: string
  fetchedAt: string
}

export type ModelCatalogLaunchContext = {
  protocol: 'cli' | 'acp'
  actor: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/**
 * Irreversible fingerprint of a launch context. Credentials in env/args change
 * the digest; key order of env does not. Disk never stores the raw context.
 */
export function modelCatalogCacheKey(context: ModelCatalogLaunchContext): string {
  const payload = JSON.stringify([
    context.protocol,
    context.actor,
    context.command,
    context.args ?? [],
    Object.entries(context.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    context.cwd ?? ''
  ])
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Disk-backed model catalog cache. Memory keeps a short TTL; disk survives
 * restarts so cold opens can Cache-First + refresh in the background.
 * Keys are SHA-256 digests — never plaintext launch credentials.
 */
export class ModelCatalogDiskCache {
  private loadPromise: Promise<void> | undefined
  private readonly disk = new Map<string, DiskEntry>()
  private writes: Promise<void> = Promise.resolve()
  private migrated = false

  constructor(private readonly dataRoot: string) {}

  private path() {
    return join(this.dataRoot, 'global', MODEL_CACHE_FILE)
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const rawText = await readFile(this.path(), 'utf8')
          let raw: unknown
          try {
            raw = JSON.parse(rawText)
          } catch {
            await this.discardCorruptCache()
            return
          }
          const version = (raw as { schemaVersion?: unknown })?.schemaVersion
          // v1 (and anything else) stored plaintext launch contexts as keys — drop it.
          if (version !== MODEL_CACHE_SCHEMA_VERSION) {
            this.disk.clear()
            this.migrated = true
            await this.persist()
            return
          }
          const parsed = agentModelCacheSchema.safeParse(raw)
          if (!parsed.success) {
            await this.discardCorruptCache()
            return
          }
          for (const [key, entry] of Object.entries(parsed.data.entries)) {
            this.disk.set(key, {
              models: entry.models,
              currentModelId: entry.currentModelId,
              fetchedAt: entry.fetchedAt
            })
          }
        } catch {
          /* Missing cache is fine; first successful probe seeds it. */
        }
      })()
    }
    await this.loadPromise
  }

  private async discardCorruptCache(): Promise<void> {
    this.disk.clear()
    this.migrated = true
    try {
      await unlink(this.path())
    } catch {
      /* absent or unreadable */
    }
  }

  get(key: string): ModelCacheMemEntry | undefined {
    const entry = this.disk.get(key)
    if (!entry) return undefined
    const fetchedAt = Date.parse(entry.fetchedAt)
    const expiresAt = Number.isFinite(fetchedAt) ? fetchedAt + MODEL_CACHE_TTL_MS : 0
    return {
      list: {
        models: entry.models,
        ...(entry.currentModelId ? { currentModelId: entry.currentModelId } : {})
      },
      expiresAt
    }
  }

  async set(key: string, list: AcpModelList): Promise<void> {
    await this.ensureLoaded()
    // Refuse non-digest keys so a queued old-format writer cannot reintroduce secrets.
    if (!/^[a-f0-9]{64}$/.test(key)) return
    const fetchedAt = new Date().toISOString()
    this.disk.set(key, {
      models: list.models,
      currentModelId: list.currentModelId,
      fetchedAt
    })
    await this.persist()
  }

  private async persist(): Promise<void> {
    const data = {
      schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
      entries: Object.fromEntries(
        [...this.disk.entries()]
          .filter(([k]) => /^[a-f0-9]{64}$/.test(k))
          .map(([k, v]) => [
            k,
            {
              models: v.models,
              ...(v.currentModelId ? { currentModelId: v.currentModelId } : {}),
              fetchedAt: v.fetchedAt
            }
          ])
      )
    }
    const pending = this.writes.catch(() => {}).then(async () => {
      await atomicWriteJson(this.path(), data)
      try {
        await chmod(this.path(), 0o600)
      } catch {
        /* best-effort ACL */
      }
    })
    this.writes = pending
    await pending
  }

  /** Test helper: whether load discarded a legacy/invalid file. */
  didMigrate(): boolean {
    return this.migrated
  }
}
