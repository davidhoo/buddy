import { describe, expect, it, vi } from 'vitest'
import { createBuddyPreloadApi } from '../../../src/preload/buddy-api'

describe('createBuddyPreloadApi', () => {
  it('maps methods to buddy IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValue({ version: 'native' })
    const on = vi.fn()
    const removeListener = vi.fn()
    const api = createBuddyPreloadApi({ invoke, on, removeListener })

    await expect(api.bootstrap()).resolves.toEqual({ version: 'native' })
    expect(invoke).toHaveBeenCalledWith('buddy:bootstrap')
  })

  it('returns unsubscribe for live task events', () => {
    const invoke = vi.fn()
    const on = vi.fn()
    const removeListener = vi.fn()
    const api = createBuddyPreloadApi({ invoke, on, removeListener })
    const callback = vi.fn()

    const unsubscribe = api.onTaskEvent(callback)
    expect(on).toHaveBeenCalledWith('buddy:event', expect.any(Function))

    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('buddy:event', expect.any(Function))
  })

  it('invokes buddy:gitCommitAndPush with repoRoot, message, remote, push in order', async () => {
    const invoke = vi.fn().mockResolvedValue({
      commitHash: 'abc1234',
      pushStatus: 'pushed',
      remote: 'origin',
      upstreamCreated: true,
      pushError: null
    })
    const api = createBuddyPreloadApi({ invoke, on: vi.fn(), removeListener: vi.fn() })

    const result = await api.gitCommitAndPush('/tmp/repo', 'msg', 'origin', true)
    expect(invoke).toHaveBeenCalledWith('buddy:gitCommitAndPush', '/tmp/repo', 'msg', 'origin', true)
    expect(result.pushStatus).toBe('pushed')
  })
})
