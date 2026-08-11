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
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(
      new Error('Code signature at URL https://example.com did not pass validation')
    )

    const errorHandler = getHandler('error')!
    // Fire the generic 'error' event while the manual check is still in flight,
    // mirroring how electron-updater couples the error event with rejection.
    const p = mod.checkForUpdates()
    errorHandler(new Error('Code signature at URL https://example.com did not pass validation'))
    await p.catch(() => {})

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvents = sentEvents.filter(e => (e as any).type === 'error')
    // Same failure must dispatch exactly one error event (no generic + promise dup).
    expect(errorEvents).toHaveLength(1)
    expect((errorEvents[0] as any).message).toContain('Code signature')
    expect((errorEvents[0] as any).phase).toBe('check')

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

  it('manual checkForUpdates sends error event on failure with check phase', async () => {
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

  it('manual check sends only one error event for a single failure (no duplicate from generic handler + promise)', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_CLOSED'))

    await expect(mod.checkForUpdates()).rejects.toThrow()

    const errorEvents = mockWebContents.send.mock.calls
      .map(c => c[1])
      .filter(e => (e as any).type === 'error')
    expect(errorEvents).toHaveLength(1)
    expect((errorEvents[0] as any).phase).toBe('check')
  })

  it('repeated identical check errors across separate manual checks are both surfaced (dedup is per-operation)', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    // Two consecutive manual checks that fail with the same message.
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_CLOSED'))
    await expect(mod.checkForUpdates()).rejects.toThrow()
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_CLOSED'))
    await expect(mod.checkForUpdates()).rejects.toThrow()

    const errorEvents = mockWebContents.send.mock.calls
      .map(c => c[1])
      .filter(e => (e as any).type === 'error')
    // Each operation must surface its own error — dedup can't span operations.
    expect(errorEvents).toHaveLength(2)
    expect((errorEvents[0] as any).phase).toBe('check')
    expect((errorEvents[1] as any).phase).toBe('check')
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

  it('download phase error dedups between generic handler and promise catch', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('Download interrupted'))

    const errorHandler = getHandler('error')!
    // Mimic electron-updater: 'error' event AND promise rejection for one failure.
    const p = mod.downloadUpdate()
    errorHandler(new Error('Download interrupted'))
    await p.catch(() => {})

    const errorEvents = mockWebContents.send.mock.calls
      .map(c => c[1])
      .filter(e => (e as any).type === 'error')
    expect(errorEvents).toHaveLength(1)
    expect((errorEvents[0] as any).phase).toBe('download')
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
    // Without a manual origin set, a check-phase error stays silent.
    errorHandler(new Error('Cannot reach update server'))

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error') as any
    expect(errorEvent).toBeUndefined()
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

  it('background check failure does not send a user-visible error', async () => {
    const mod = await freshImport()
    mod.initUpdater(mockWindow as any)
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_CLOSED'))

    // Simulate the internal background runner (the 5s/30min path) by calling
    // autoUpdater.checkForUpdates via the same origin the timer uses. We can't
    // reach runCheck directly, but the generic 'error' handler is what fires
    // on a background check failure — verify it stays silent without a manual
    // origin.
    const errorHandler = getHandler('error')!
    mockWebContents.send.mockClear()
    errorHandler(new Error('net::ERR_CONNECTION_CLOSED'))

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeUndefined()
  })

  it('background check that finds a new version still enters the download flow', async () => {
    const { initUpdater } = await freshImport()
    initUpdater(mockWindow as any)

    const availableHandler = getHandler('update-available')!
    mockWebContents.send.mockClear()
    availableHandler({ version: '1.2.15', releaseDate: '' })

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const availableEvent = sentEvents.find(e => (e as any).type === 'available') as any
    expect(availableEvent).toBeDefined()
    expect(availableEvent.info.version).toBe('1.2.15')
  })

  it('current version equals latest does not trigger a download (not-available path)', async () => {
    const { initUpdater } = await freshImport()
    initUpdater(mockWindow as any)

    const notAvailableHandler = getHandler('update-not-available')!
    mockWebContents.send.mockClear()
    notAvailableHandler()

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const notAvailableEvent = sentEvents.find(e => (e as any).type === 'not-available')
    expect(notAvailableEvent).toBeDefined()
    // No available/progress/downloaded events should fire.
    expect(sentEvents.find(e => (e as any).type === 'available')).toBeUndefined()
    expect(sentEvents.find(e => (e as any).type === 'downloaded')).toBeUndefined()
  })
})
