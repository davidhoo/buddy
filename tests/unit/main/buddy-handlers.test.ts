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
      enqueueInstruction: vi.fn(),
      dequeueInstruction: vi.fn(),
      clearInstructionQueue: vi.fn(),
      interruptAndInsert: vi.fn(),
      getEvents: vi.fn(),
      getRoundEvents: vi.fn(),
      getTaskStats: vi.fn(),
      updateGlobalSettings: vi.fn(),
      listCursorModels: vi.fn(),
      gitStatus: vi.fn(),
      gitStageAll: vi.fn(),
      gitCommitAndPush: vi.fn(),
      gitDiffForCommitMessage: vi.fn(),
      generateCommitMessage: vi.fn(),
      testLauncher: vi.fn(),
      updateTaskText: vi.fn(),
      onTaskEvent: vi.fn()
    }

    registerBuddyHandlers({ handle }, service)

    expect(handle).toHaveBeenCalledWith('buddy:bootstrap', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:startTask', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:listCursorModels', expect.any(Function))
    expect(handle).toHaveBeenCalledTimes(27)
  })
})
