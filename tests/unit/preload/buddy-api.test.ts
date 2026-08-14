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

  it('invokes buddy:gitPushAvailability with repoRoot and remote in order', async () => {
    const invoke = vi.fn().mockResolvedValue({
      state: 'ahead',
      remote: 'origin',
      branch: 'main',
      ahead: 1,
      behind: 0,
      upstreamCreatedOnPush: false
    })
    const api = createBuddyPreloadApi({ invoke, on: vi.fn(), removeListener: vi.fn() })

    const result = await api.gitPushAvailability('/tmp/repo', 'origin')
    expect(invoke).toHaveBeenCalledWith('buddy:gitPushAvailability', '/tmp/repo', 'origin')
    expect(result.state).toBe('ahead')
  })

  it('invokes buddy:gitPush with repoRoot and remote in order', async () => {
    const invoke = vi.fn().mockResolvedValue({
      pushStatus: 'pushed',
      remote: 'origin',
      upstreamCreated: false,
      pushError: null
    })
    const api = createBuddyPreloadApi({ invoke, on: vi.fn(), removeListener: vi.fn() })

    const result = await api.gitPush('/tmp/repo', 'origin')
    expect(invoke).toHaveBeenCalledWith('buddy:gitPush', '/tmp/repo', 'origin')
    expect(result.pushStatus).toBe('pushed')
  })
})
