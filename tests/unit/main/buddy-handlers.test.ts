import { describe, expect, it, vi } from 'vitest'
import { registerBuddyHandlers } from '../../../src/main/ipc/buddy-handlers'

describe('registerBuddyHandlers', () => {
  it('registers native buddy channels', () => {
    const handle = vi.fn()
    const service = {
      checkHealth: vi.fn(),
      bootstrap: vi.fn(),
      getTasks: vi.fn(),
      getTaskDetail: vi.fn(),
      createTask: vi.fn(),
      deleteTask: vi.fn(),
      startTask: vi.fn(),
      sendMessage: vi.fn(),
      skipCountdown: vi.fn(),
      pauseCountdown: vi.fn(),
      interrupt: vi.fn(),
      getEvents: vi.fn(),
      updateGlobalSettings: vi.fn(),
      onTaskEvent: vi.fn()
    }

    registerBuddyHandlers({ handle }, service)

    expect(handle).toHaveBeenCalledWith('buddy:bootstrap', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:startTask', expect.any(Function))
    expect(handle).toHaveBeenCalledTimes(13)
  })
})
