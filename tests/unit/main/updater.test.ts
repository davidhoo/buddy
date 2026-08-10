import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockAutoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  disableDifferentialDownload: true,
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
  currentVersion: { version: '1.2.12' }
}

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater
}))

const mockWebContents = { send: vi.fn() }
const mockWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: mockWebContents
}

vi.mock('electron', () => ({
  BrowserWindow: vi.fn()
}))

async function freshImport() {
  vi.resetModules()
  vi.doMock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }))
  vi.doMock('electron', () => ({ BrowserWindow: vi.fn() }))
  return await import('../../../src/main/updater')
}

function getHandler(event: string) {
  const call = mockAutoUpdater.on.mock.calls.find(c => c[0] === event)
  return call?.[1] as ((...args: unknown[]) => void) | undefined
}

describe('updater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAutoUpdater.on.mockClear()
    mockAutoUpdater.checkForUpdates.mockReset()
    mockAutoUpdater.downloadUpdate.mockReset()
    mockAutoUpdater.quitAndInstall.mockReset()
    mockWebContents.send.mockClear()
  })

  it('sends real error message on autoUpdater error, not not-available', async () => {
    const { initUpdater } = await freshImport()
    initUpdater(mockWindow as any)

    const errorHandler = getHandler('error')!
    errorHandler(new Error('Code signature at URL https://example.com did not pass validation'))

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).message).toContain('Code signature')
    expect((errorEvent as any).phase).toBe('check')

    const notAvailableEvent = sentEvents.find(e => (e as any).type === 'not-available')
    expect(notAvailableEvent).toBeUndefined()
  })

  it('sends installing event before quitAndInstall', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockWebContents.send.mockClear()

    mod.quitAndInstall()

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const installingEvent = sentEvents.find(e => (e as any).type === 'installing')
    expect(installingEvent).toBeDefined()
    expect((installingEvent as any).version).toBe('1.2.12')
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalled()
  })

  it('sends error event when quitAndInstall throws', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('Installation failed')
    })
    mockWebContents.send.mockClear()

    mod.quitAndInstall()

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).message).toBe('Installation failed')
    expect((errorEvent as any).phase).toBe('install')
  })

  it('checkForUpdates sends error event on failure with check phase', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('Network unreachable'))

    await expect(mod.checkForUpdates()).rejects.toThrow('Network unreachable')

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).phase).toBe('check')
    expect((errorEvent as any).message).toContain('Network unreachable')
  })

  it('downloadUpdate sends error event on failure with download phase', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('Download interrupted'))

    await expect(mod.downloadUpdate()).rejects.toThrow('Download interrupted')

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).phase).toBe('download')
    expect((errorEvent as any).message).toContain('Download interrupted')
  })

  it('generic error handler uses download phase after update-available fires (auto-download path)', async () => {
    const { initUpdater } = await freshImport()
    initUpdater(mockWindow as any)

    const availableHandler = getHandler('update-available')!
    const errorHandler = getHandler('error')!

    availableHandler({ version: '1.2.13', releaseDate: '' })
    mockWebContents.send.mockClear()
    errorHandler(new Error('Code signature at URL ... did not pass validation'))

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error') as any
    expect(errorEvent).toBeDefined()
    expect(errorEvent.phase).toBe('download')
  })

  it('generic error handler uses check phase before any update is found', async () => {
    const { initUpdater } = await freshImport()
    initUpdater(mockWindow as any)

    const checkingHandler = getHandler('checking-for-update')!
    const errorHandler = getHandler('error')!

    checkingHandler()
    mockWebContents.send.mockClear()
    errorHandler(new Error('Cannot reach update server'))

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error') as any
    expect(errorEvent.phase).toBe('check')
  })

  it('generic error handler uses install phase after update-downloaded fires', async () => {
    const { initUpdater } = await freshImport()
    initUpdater(mockWindow as any)

    const downloadedHandler = getHandler('update-downloaded')!
    const errorHandler = getHandler('error')!

    downloadedHandler({ version: '1.2.13', releaseDate: '' })
    mockWebContents.send.mockClear()
    errorHandler(new Error('Quit and install failed'))

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error') as any
    expect(errorEvent.phase).toBe('install')
  })

  it('redacts sensitive data (token, cookie) from error messages', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(
      new Error('Request failed: token=abc123secret cookie=session_xyz')
    )

    await expect(mod.checkForUpdates()).rejects.toThrow()

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error') as any
    expect(errorEvent).toBeDefined()
    expect(errorEvent.message).not.toContain('abc123secret')
    expect(errorEvent.message).not.toContain('session_xyz')
    expect(errorEvent.message).toContain('[REDACTED]')
  })

  it('redacts API keys from error messages', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(
      new Error('Auth failed for sk-ant-api03-1234567890abcdefghijklmnop')
    )

    await expect(mod.downloadUpdate()).rejects.toThrow()

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error') as any
    expect(errorEvent).toBeDefined()
    expect(errorEvent.message).not.toContain('sk-ant-api03-1234567890abcdefghijklmnop')
    expect(errorEvent.message).toContain('[REDACTED]')
  })
})
