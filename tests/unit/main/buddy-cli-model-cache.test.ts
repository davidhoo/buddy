import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BuddyCoreService } from '../../../src/main/buddy/service'
import {
  MODEL_CACHE_ERROR_TTL_MS,
  MODEL_CACHE_FILE,
  ModelCatalogDiskCache,
  modelCatalogCacheKey
} from '../../../src/main/buddy/model-cache'
import type { AcpModelList } from '../../../src/shared/types'

const agyKey = modelCatalogCacheKey({ protocol: 'cli', actor: 'agy', command: 'agy', args: [], env: {} })
const cursorKey = modelCatalogCacheKey({ protocol: 'cli', actor: 'cursor', command: 'cursor', args: [], env: {} })

describe('BuddyCoreService listCliModels cache', () => {
  it('publishes model-catalog updates after a background refresh succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-model-push-'))
    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const agents = (service as unknown as {
        agents: {
          getInventory: () => Promise<unknown>
          models: (id: string) => Promise<AcpModelList>
        }
        cliModelCache: Map<string, { list: AcpModelList; expiresAt: number }>
      })
      vi.spyOn(agents.agents, 'getInventory').mockResolvedValue({
        agents: [{
          id: 'agy',
          selectedProtocol: 'cli',
          runnable: true,
          cli: { command: 'agy', args: [], env: {}, timeout_seconds: 20 }
        }]
      })
      const firstList: AcpModelList = { models: [{ id: 'old', name: 'Old' }] }
      const nextList: AcpModelList = { models: [{ id: 'new', name: 'New' }] }
      const models = vi.spyOn(agents.agents, 'models')
        .mockResolvedValueOnce(firstList)
        .mockResolvedValueOnce(nextList)

      const updates: Array<{ actor: string; protocol: string; list: AcpModelList }> = []
      service.subscribeModelCatalog(update => updates.push(update))

      await expect(service.listCliModels('agy')).resolves.toMatchObject({ models: firstList.models })
      await vi.waitFor(() => expect(updates.length).toBeGreaterThanOrEqual(1))

      for (const [key, entry] of agents.cliModelCache) {
        agents.cliModelCache.set(key, { ...entry, expiresAt: Date.now() - 1 })
      }
      const stale = await service.listCliModels('agy')
      expect(stale.models).toEqual(firstList.models)
      await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(updates.some(u => u.list.models[0]?.id === 'new')).toBe(true))
      expect(updates.every(u => u.actor === 'agy' && u.protocol === 'cli')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('reuses TTL cache, serves stale immediately while refreshing, and falls back on failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-cli-model-cache-'))
    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const agents = (service as unknown as {
        agents: {
          getInventory: () => Promise<unknown>
          models: (id: string) => Promise<AcpModelList>
        }
      }).agents

      vi.spyOn(agents, 'getInventory').mockResolvedValue({
        agents: [{
          id: 'agy',
          selectedProtocol: 'cli',
          runnable: true,
          cli: { command: 'agy', args: [], env: {}, timeout_seconds: 20 }
        }]
      })

      const list: AcpModelList = {
        models: [
          { id: 'gemini-flash', name: 'Gemini Flash' },
          { id: 'claude-sonnet', name: 'Claude Sonnet' }
        ]
      }
      const models = vi.spyOn(agents, 'models').mockResolvedValue(list)

      const first = await service.listCliModels('agy')
      expect(first.models).toEqual(list.models)
      expect(models).toHaveBeenCalledTimes(1)

      const second = await service.listCliModels('agy')
      expect(second.models).toEqual(list.models)
      expect(models).toHaveBeenCalledTimes(1)

      let releaseInflight!: (value: AcpModelList) => void
      models.mockImplementationOnce(
        () => new Promise(resolve => { releaseInflight = resolve })
      )

      const cache = (service as unknown as {
        cliModelCache: Map<string, { list: AcpModelList; expiresAt: number }>
        cliModelInflight: Map<string, Promise<AcpModelList>>
      })
      for (const [key, entry] of cache.cliModelCache) {
        cache.cliModelCache.set(key, { ...entry, expiresAt: Date.now() - 1 })
      }

      // Expired + stale: Cache-First returns immediately and refreshes in background.
      const staleWhileRefresh = await service.listCliModels('agy')
      expect(staleWhileRefresh.models).toEqual(list.models)
      await vi.waitFor(() => expect(releaseInflight).toEqual(expect.any(Function)))
      expect(models).toHaveBeenCalledTimes(2)
      expect(cache.cliModelInflight.size).toBe(1)

      const shared = cache.cliModelInflight.values().next().value as Promise<AcpModelList>
      releaseInflight(list)
      await expect(shared).resolves.toEqual(list)
      await vi.waitFor(() => expect(cache.cliModelInflight.size).toBe(0))

      for (const [key, entry] of cache.cliModelCache) {
        cache.cliModelCache.set(key, { ...entry, expiresAt: Date.now() - 1 })
      }
      models.mockRejectedValueOnce(new Error('agy models boom'))
      const immediate = await service.listCliModels('agy')
      expect(immediate.models).toEqual(list.models)
      await vi.waitFor(() => expect(cache.cliModelInflight.size).toBe(0))

      const afterError = [...cache.cliModelCache.values()][0]
      expect(afterError.expiresAt).toBeGreaterThan(Date.now())
      expect(afterError.expiresAt).toBeLessThanOrEqual(Date.now() + MODEL_CACHE_ERROR_TTL_MS + 50)

      const callsBeforePenaltyHit = models.mock.calls.length
      const stillThere = await service.listCliModels('agy')
      expect(stillThere.models).toEqual(list.models)
      expect(models.mock.calls.length).toBe(callsBeforePenaltyHit)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('persists model catalogs to disk and serves them after restart without waiting on CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-cli-model-disk-'))
    const dataRoot = join(root, 'data')
    try {
      const list: AcpModelList = {
        models: [
          { id: 'gemini-flash', name: 'Gemini Flash' },
          { id: 'claude-sonnet', name: 'Claude Sonnet' }
        ]
      }

      const first = new BuddyCoreService({ dataRoot })
      const firstAgents = (first as unknown as {
        agents: {
          getInventory: () => Promise<unknown>
          models: (id: string) => Promise<AcpModelList>
        }
      }).agents
      vi.spyOn(firstAgents, 'getInventory').mockResolvedValue({
        agents: [{
          id: 'agy',
          selectedProtocol: 'cli',
          runnable: true,
          cli: { command: 'agy', args: [], env: {}, timeout_seconds: 20 }
        }]
      })
      vi.spyOn(firstAgents, 'models').mockResolvedValue(list)
      await expect(first.listCliModels('agy')).resolves.toMatchObject({ models: list.models })

      const diskPath = join(dataRoot, 'global', MODEL_CACHE_FILE)
      await vi.waitFor(async () => {
        const raw = JSON.parse(await readFile(diskPath, 'utf8'))
        expect(raw.schemaVersion).toBe(2)
        expect(Object.keys(raw.entries).every((key: string) => /^[a-f0-9]{64}$/.test(key))).toBe(true)
        expect(Object.values(raw.entries).some((entry: { models: unknown }) =>
          JSON.stringify(entry.models) === JSON.stringify(list.models)
        )).toBe(true)
      })

      // Age the disk entry so restart behaves like a cold open past the memory TTL.
      const aged = JSON.parse(await readFile(diskPath, 'utf8')) as {
        schemaVersion: number
        entries: Record<string, { models: AcpModelList['models']; fetchedAt: string }>
      }
      for (const entry of Object.values(aged.entries)) {
        entry.fetchedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      }
      await writeFile(diskPath, JSON.stringify(aged))

      const second = new BuddyCoreService({ dataRoot })
      const secondAgents = (second as unknown as {
        agents: {
          getInventory: () => Promise<unknown>
          models: (id: string) => Promise<AcpModelList>
        }
        cliModelInflight: Map<string, Promise<AcpModelList>>
      })
      vi.spyOn(secondAgents.agents, 'getInventory').mockResolvedValue({
        agents: [{
          id: 'agy',
          selectedProtocol: 'cli',
          runnable: true,
          cli: { command: 'agy', args: [], env: {}, timeout_seconds: 20 }
        }]
      })
      let release!: (value: AcpModelList) => void
      const models = vi.spyOn(secondAgents.agents, 'models').mockImplementation(
        () => new Promise(resolve => { release = resolve })
      )

      // Disk hydrate must win even if the CLI probe never finishes.
      const cached = await second.listCliModels('agy')
      expect(cached.models).toEqual(list.models)
      await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(1))
      expect(secondAgents.cliModelInflight.size).toBe(1)
      release(list)
      await vi.waitFor(() => expect(secondAgents.cliModelInflight.size).toBe(0))
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('merges concurrent ensureLoaded and keeps peer entries when set races a cold load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-model-disk-race-'))
    const dataRoot = join(root, 'data')
    const globalDir = join(dataRoot, 'global')
    await mkdir(globalDir, { recursive: true })
    const diskPath = join(globalDir, MODEL_CACHE_FILE)
    const agedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    await writeFile(diskPath, JSON.stringify({
      schemaVersion: 2,
      entries: {
        [cursorKey]: {
          models: [{ id: 'gpt', name: 'GPT' }],
          fetchedAt: agedAt
        },
        [agyKey]: {
          models: [{ id: 'flash', name: 'Flash' }],
          fetchedAt: agedAt
        }
      }
    }))

    try {
      const cache = new ModelCatalogDiskCache(dataRoot)
      await Promise.all([cache.ensureLoaded(), cache.ensureLoaded()])
      expect(cache.get(cursorKey)?.list.models).toEqual([{ id: 'gpt', name: 'GPT' }])
      expect(cache.get(agyKey)?.list.models).toEqual([{ id: 'flash', name: 'Flash' }])

      // set() must hydrate first so writing one key cannot wipe the other.
      const fresh = new ModelCatalogDiskCache(dataRoot)
      await fresh.set(agyKey, { models: [{ id: 'pro', name: 'Pro' }] })
      const raw = JSON.parse(await readFile(diskPath, 'utf8')) as {
        entries: Record<string, { models: AcpModelList['models'] }>
      }
      expect(raw.entries[cursorKey].models).toEqual([{ id: 'gpt', name: 'GPT' }])
      expect(raw.entries[agyKey].models).toEqual([{ id: 'pro', name: 'Pro' }])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('serves concurrent cold-start actors from disk without duplicate probes racing load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-cli-model-cold-'))
    const dataRoot = join(root, 'data')
    const globalDir = join(dataRoot, 'global')
    await mkdir(globalDir, { recursive: true })
    const agedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    await writeFile(join(globalDir, MODEL_CACHE_FILE), JSON.stringify({
      schemaVersion: 2,
      entries: {
        [cursorKey]: {
          models: [{ id: 'gpt', name: 'GPT' }],
          fetchedAt: agedAt
        },
        [agyKey]: {
          models: [{ id: 'flash', name: 'Flash' }],
          fetchedAt: agedAt
        }
      }
    }))

    try {
      const service = new BuddyCoreService({ dataRoot })
      const agents = (service as unknown as {
        agents: {
          getInventory: () => Promise<unknown>
          models: (id: string) => Promise<AcpModelList>
        }
        cliModelInflight: Map<string, Promise<AcpModelList>>
      })
      vi.spyOn(agents.agents, 'getInventory').mockResolvedValue({
        agents: [
          { id: 'cursor', selectedProtocol: 'cli', runnable: true, cli: { command: 'cursor', args: [], env: {}, timeout_seconds: 20 } },
          { id: 'agy', selectedProtocol: 'cli', runnable: true, cli: { command: 'agy', args: [], env: {}, timeout_seconds: 20 } }
        ]
      })
      const releases = new Map<string, (value: AcpModelList) => void>()
      const models = vi.spyOn(agents.agents, 'models').mockImplementation(
        (id: string) => new Promise(resolve => { releases.set(id, resolve) })
      )

      const [cursorList, agyList] = await Promise.all([
        service.listCliModels('cursor'),
        service.listCliModels('agy')
      ])
      expect(cursorList.models).toEqual([{ id: 'gpt', name: 'GPT' }])
      expect(agyList.models).toEqual([{ id: 'flash', name: 'Flash' }])
      await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(2))
      expect(agents.cliModelInflight.size).toBe(2)

      // Same actor again must reuse the occupied inflight, not queue another probe.
      const again = service.listCliModels('agy')
      expect(models).toHaveBeenCalledTimes(2)
      releases.get('cursor')!({ models: [{ id: 'gpt', name: 'GPT' }] })
      releases.get('agy')!({ models: [{ id: 'flash', name: 'Flash' }] })
      await expect(again).resolves.toMatchObject({ models: [{ id: 'flash', name: 'Flash' }] })
      await vi.waitFor(() => expect(agents.cliModelInflight.size).toBe(0))
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
