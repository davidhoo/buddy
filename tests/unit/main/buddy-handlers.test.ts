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
      cancelTask: vi.fn(),
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
      gitStageFiles: vi.fn(),
      gitCommitAndPush: vi.fn(),
      gitDiffForCommitMessage: vi.fn(),
      gitFileDiff: vi.fn(),
      gitBranches: vi.fn(),
      gitCheckout: vi.fn(),
      gitCreateBranch: vi.fn(),
      gitPushAvailability: vi.fn(),
      gitPush: vi.fn(),
      generateCommitMessage: vi.fn(),
      cancelGenerateCommitMessage: vi.fn(),
      testLauncher: vi.fn(),
      detectActorModels: vi.fn(),
      listAcpModels: vi.fn(),
      updateTaskText: vi.fn(),
      updateTaskLauncherModel: vi.fn(),
      checkAcpGlobalAdapters: vi.fn(),
      onTaskEvent: vi.fn()
    }

    registerBuddyHandlers({ handle }, service)

    expect(handle).toHaveBeenCalledWith('buddy:bootstrap', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:startTask', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitFileDiff', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitBranches', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitCheckout', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitCreateBranch', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitPushAvailability', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitPush', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:gitStageFiles', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:cancelGenerateCommitMessage', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:detectActorModels', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:listAcpModels', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:updateTaskLauncherModel', expect.any(Function))
    expect(handle).toHaveBeenCalledWith('buddy:checkAcpGlobalAdapters', expect.any(Function))
    const cancelHandler = handle.mock.calls.find(([channel]) => channel === 'buddy:cancelTask')![1]
    cancelHandler({}, 'task', 'workspace')
    expect(service.cancelTask).toHaveBeenCalledWith('task', 'workspace')

    const testLauncherHandler = handle.mock.calls.find(([channel]) => channel === 'buddy:testLauncher')![1]
    testLauncherHandler({}, 'agy', 'agy', { http_proxy: 'http://custom:7893' })
    expect(service.testLauncher).toHaveBeenCalledWith('agy', 'agy', { http_proxy: 'http://custom:7893' })

    const checkAcpHandler = handle.mock.calls.find(([channel]) => channel === 'buddy:checkAcpGlobalAdapters')![1]
    checkAcpHandler({})
    expect(service.checkAcpGlobalAdapters).toHaveBeenCalled()

    const updateModelHandler = handle.mock.calls.find(([channel]) => channel === 'buddy:updateTaskLauncherModel')![1]
    updateModelHandler({}, 'task', 'workspace', 'claude', 'opus-4.6')
    expect(service.updateTaskLauncherModel).toHaveBeenCalledWith('task', 'workspace', 'claude', 'opus-4.6')

    expect(handle).toHaveBeenCalledTimes(39)
  })
})
