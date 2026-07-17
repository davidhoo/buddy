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
        updateGlobalSettings: vi.fn(async (settings: unknown) => settings)
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

  it('serializes settings patches without clobbering another tab', async () => {
    const { api } = await import('../../../src/renderer/lib/api')
    const base = { countdown_seconds: 30, launchers: {} }

    const launcherSave = api.updateGlobalSettingsPatch(base, {
      launchers: {
        'cursor-agent': {
          command: 'agent',
          env: {},
          timeout_seconds: 7200,
          backend: 'cursor'
        }
      }
    })
    const promptSave = api.updateGlobalSettingsPatch(base, {
      prompt_presets: [{ id: 'review', name: 'Review', prompt: 'Review carefully.' }]
    })
    await Promise.all([launcherSave, promptSave])

    expect(window.buddy.updateGlobalSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      launchers: expect.objectContaining({ 'cursor-agent': expect.any(Object) }),
      prompt_presets: [{ id: 'review', name: 'Review', prompt: 'Review carefully.' }]
    }))
  })
})
