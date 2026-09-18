import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('renderer api', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', {
      buddy: {
        checkHealth: vi.fn().mockResolvedValue(true),
        bootstrap: vi.fn().mockResolvedValue({ version: 'native', tasks: [] }),
        getTasks: vi.fn().mockResolvedValue([]),
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
        testLauncher: vi.fn().mockResolvedValue({ actor: 'agy', success: true, phase: 'ping' }),
        updateTaskLauncherModel: vi.fn().mockResolvedValue({ launchers: {} })
      }
    })
  })

  it('uses the preload buddy API for health checks', async () => {
    const { api } = await import('../../../src/renderer/lib/api')

    await expect(api.checkHealth()).resolves.toBe(true)
    expect(window.buddy.checkHealth).toHaveBeenCalled()
  })

  it('uses the preload buddy API for bootstrap', async () => {
    const { api } = await import('../../../src/renderer/lib/api')

    await expect(api.bootstrap()).resolves.toEqual({ version: 'native', tasks: [] })
    expect(window.buddy.bootstrap).toHaveBeenCalled()
  })

  it('forwards actor, command, and env to window.buddy.testLauncher', async () => {
    const { api } = await import('../../../src/renderer/lib/api')

    await expect(
      api.testLauncher('agy', 'agy', { http_proxy: 'http://127.0.0.1:7893' })
    ).resolves.toEqual({ actor: 'agy', success: true, phase: 'ping' })
    expect(window.buddy.testLauncher).toHaveBeenCalledWith('agy', 'agy', {
      http_proxy: 'http://127.0.0.1:7893'
    })
  })

  it('forwards a per-task ACP model update to window.buddy.updateTaskLauncherModel', async () => {
    const { api } = await import('../../../src/renderer/lib/api')

    await expect(
      api.updateTaskLauncherModel('demo', 'ws', 'claude', 'opus-4.6')
    ).resolves.toEqual({ launchers: {} })
    expect(window.buddy.updateTaskLauncherModel).toHaveBeenCalledWith('demo', 'ws', 'claude', 'opus-4.6')
  })
})
