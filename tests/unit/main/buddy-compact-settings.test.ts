import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuddyStore } from '../../../src/main/buddy/store'

describe('GlobalSettings max_compact_retries persistence', () => {
  it('persists max_compact_retries=0 through updateGlobalSettings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-settings-0-'))
    const store = new BuddyStore(root)

    await store.updateGlobalSettings({ max_compact_retries: 0 })
    const read = await store.readGlobalSettings()
    expect(read.max_compact_retries).toBe(0)
  })

  it('persists max_compact_retries=5 through updateGlobalSettings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-settings-5-'))
    const store = new BuddyStore(root)

    await store.updateGlobalSettings({ max_compact_retries: 5 })
    const read = await store.readGlobalSettings()
    expect(read.max_compact_retries).toBe(5)
  })

  it('defaults max_compact_retries to 3 when not set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-settings-default-'))
    const store = new BuddyStore(root)

    const read = await store.readGlobalSettings()
    expect(read.max_compact_retries).toBe(3)
  })
})
