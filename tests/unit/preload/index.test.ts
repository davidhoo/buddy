import { describe, expect, it, vi } from 'vitest'
import { ipcRenderer } from 'electron'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn()
  }
}))

describe('preload updater API', () => {
  it('checkForUpdates returns a promise from ipcRenderer.invoke', async () => {
    vi.resetModules()
    vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce(undefined)
    await import('../../../src/preload/index')

    // Access the api object exposed via contextBridge
    const { contextBridge } = await import('electron')
    const exposed = vi.mocked(contextBridge.exposeInMainWorld)
    expect(exposed).toHaveBeenCalledWith('api', expect.any(Object))

    const api = exposed.mock.calls.find(c => c[0] === 'api')?.[1] as any
    expect(api.checkForUpdates).toBeTypeOf('function')
    expect(api.downloadUpdate).toBeTypeOf('function')
    expect(api.installUpdate).toBeTypeOf('function')

    await api.checkForUpdates()
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('updater:check')
  })

  it('installUpdate returns a promise (not fire-and-forget)', async () => {
    vi.resetModules()
    vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce({ error: 'test' })
    await import('../../../src/preload/index')

    const { contextBridge } = await import('electron')
    const exposed = vi.mocked(contextBridge.exposeInMainWorld)
    const api = exposed.mock.calls.find(c => c[0] === 'api')?.[1] as any

    const result = await api.installUpdate()
    expect(result).toEqual({ error: 'test' })
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('updater:install')
  })

  it('onUpdaterEvent subscribes and returns unsubscribe', async () => {
    vi.resetModules()
    await import('../../../src/preload/index')

    const { contextBridge } = await import('electron')
    const exposed = vi.mocked(contextBridge.exposeInMainWorld)
    const api = exposed.mock.calls.find(c => c[0] === 'api')?.[1] as any

    const cb = vi.fn()
    const unsub = api.onUpdaterEvent(cb)
    expect(ipcRenderer.on).toHaveBeenCalledWith('updater:event', expect.any(Function))
    expect(unsub).toBeTypeOf('function')

    unsub()
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('updater:event', expect.any(Function))
  })
})
