import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BuddyCoreService } from '../../../src/main/buddy/service'
import type { AcpModelList } from '../../../src/shared/types'

describe('BuddyCoreService listCliModels cache', () => {
  it('reuses TTL cache and inflight requests, and falls back to stale on failure', async () => {
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
      }).cliModelCache
      for (const [key, entry] of cache) {
        cache.set(key, { ...entry, expiresAt: Date.now() - 1 })
      }

      const inflightA = service.listCliModels('agy')
      const inflightB = service.listCliModels('agy')
      await vi.waitFor(() => expect(releaseInflight).toEqual(expect.any(Function)))
      releaseInflight(list)
      await expect(inflightA).resolves.toEqual(list)
      await expect(inflightB).resolves.toEqual(list)
      expect(models).toHaveBeenCalledTimes(2)

      for (const [key, entry] of cache) {
        cache.set(key, { ...entry, expiresAt: Date.now() - 1 })
      }
      models.mockRejectedValueOnce(new Error('agy models boom'))
      const stale = await service.listCliModels('agy')
      expect(stale.models).toEqual(list.models)
      expect(stale.error).toMatch(/boom/i)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
