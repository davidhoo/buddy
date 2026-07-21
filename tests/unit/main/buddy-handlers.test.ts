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
      gitStatus: vi.fn(),
      gitStageAll: vi.fn(),
      gitCommitAndPush: vi.fn(),
      gitDiffForCommitMessage: vi.fn(),
      gitFileDiff: vi.fn(),
      gitBranches: vi.fn(),
      gitCheckout: vi.fn(),
      gitCreateBranch: vi.fn(),
      generateCommitMessage: vi.fn(),
      cancelGenerateCommitMessage: vi.fn(),
      testLauncher: vi.fn(),
      updateTaskText: vi.fn(),
      onTaskEvent: vi.fn()
    }

    registerBuddyHandlers({ handle }, service)

    expect(handle).toHaveBeenCalledWith('buddy:bootstrap', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:startTask', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitFileDiff', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitBranches', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitCheckout', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitCreateBranch', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:cancelGenerateCommitMessage', expect.any(Function))
    expect(handle).toHaveBeenCalledTimes(31)
  })
})
