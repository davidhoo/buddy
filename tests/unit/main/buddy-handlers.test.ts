import { describe, expect, it, vi } from 'vitest'
import { registerBuddyHandlers } from '../../../src/main/ipc/buddy-handlers'

const libraryMethods = [
  'getLibrarySnapshot','refreshLibrary','importLibrarySkills','setLibrarySkillAssignment','ejectLibrarySkill',
  'addLibraryServer','importLibraryServers','setLibraryServerAssignment','openLibraryAuthGuidance','openLibraryDir',
  'openLibraryBackupsDir','ensureLibraryAcpHome'
] as const

describe('registerBuddyHandlers', () => {
  it('registers native buddy channels', () => {
    const handle = vi.fn()
    const service = {
      getAgentInventory:vi.fn(),
      refreshLocalAgents:vi.fn(),
      getAgentUpdateState:vi.fn(),
      startAgentUpdates:vi.fn(),
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
      onTaskEvent: vi.fn(),
      getLibrarySnapshot: vi.fn(),
      refreshLibrary: vi.fn(),
      importLibrarySkills: vi.fn(),
      setLibrarySkillAssignment: vi.fn(),
      ejectLibrarySkill: vi.fn(),
      addLibraryServer: vi.fn(),
      importLibraryServers: vi.fn(),
      setLibraryServerAssignment: vi.fn(),
      openLibraryAuthGuidance: vi.fn(),
      openLibraryDir: vi.fn(),
      openLibraryBackupsDir: vi.fn(),
      ensureLibraryAcpHome: vi.fn()
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
    for (const method of libraryMethods) {
      expect(handle).toHaveBeenCalledWith(`buddy:${method}`, expect.any(Function))
    }
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

    const startUpdates=handle.mock.calls.find(([channel])=>channel==='buddy:startAgentUpdates')![1]
    startUpdates({},['codex'],'request-id')
    expect(service.startAgentUpdates).toHaveBeenCalledWith(['codex'],'request-id')

    const importSkills = handle.mock.calls.find(([channel]) => channel === 'buddy:importLibrarySkills')![1]
    importSkills({}, ['id-1'])
    expect(service.importLibrarySkills).toHaveBeenCalledWith(['id-1'])

    const addServer = handle.mock.calls.find(([channel]) => channel === 'buddy:addLibraryServer')![1]
    const config = { type: 'http', url: 'https://example.com/mcp' }
    addServer({}, 'docs', config)
    expect(service.addLibraryServer).toHaveBeenCalledWith('docs', config)

    const assignServer = handle.mock.calls.find(([channel]) => channel === 'buddy:setLibraryServerAssignment')![1]
    assignServer({}, 'server-1', 'codex:buddy-acp:user', true)
    expect(service.setLibraryServerAssignment).toHaveBeenCalledWith('server-1', 'codex:buddy-acp:user', true)

    expect(handle).toHaveBeenCalledTimes(63)
  })
})
