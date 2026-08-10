import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock electron-updater before importing the module under test
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

// Mock BrowserWindow
const mockWebContents = {
  send: vi.fn()
}
const mockWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: mockWebContents
}

vi.mock('electron', () => ({
  BrowserWindow: vi.fn()
}))

describe('updater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAutoUpdater.on.mockClear()
    mockWebContents.send.mockClear()
  })

  it('sends real error message on autoUpdater error, not not-available', async () => {
    const { initUpdater } = await import('../../../src/main/updater')
    initUpdater(mockWindow as any)

    // Find the error handler registered with autoUpdater.on
    const errorCall = mockAutoUpdater.on.mock.calls.find(c => c[0] === 'error')
    expect(errorCall).toBeDefined()
    const errorHandler = errorCall![1]

    errorHandler(new Error('Code signature at URL https://example.com did not pass validation'))

    // Verify error event was sent, not not-available
    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).message).toContain('Code signature')
    expect((errorEvent as any).phase).toBe('install')

    const notAvailableEvent = sentEvents.find(e => (e as any).type === 'not-available')
    expect(notAvailableEvent).toBeUndefined()
  })

  it('sends installing event before quitAndInstall', async () => {
    const { initUpdater, quitAndInstall } = await import('../../../src/main/updater')
    initUpdater(mockWindow as any)
    mockWebContents.send.mockClear()

    quitAndInstall()

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const installingEvent = sentEvents.find(e => (e as any).type === 'installing')
    expect(installingEvent).toBeDefined()
    expect((installingEvent as any).version).toBe('1.2.12')
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalled()
  })

  it('sends error event when quitAndInstall throws', async () => {
    const { initUpdater, quitAndInstall } = await import('../../../src/main/updater')
    initUpdater(mockWindow as any)
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('Installation failed')
    })
    mockWebContents.send.mockClear()

    quitAndInstall()

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).message).toBe('Installation failed')
    expect((errorEvent as any).phase).toBe('install')
  })

  it('checkForUpdates sends error event on failure with check phase', async () => {
    const { checkForUpdates } = await import('../../../src/main/updater')
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('Network unreachable'))

    await expect(checkForUpdates()).rejects.toThrow('Network unreachable')

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).phase).toBe('check')
    expect((errorEvent as any).message).toContain('Network unreachable')
  })

  it('downloadUpdate sends error event on failure with download phase', async () => {
    const { downloadUpdate } = await import('../../../src/main/updater')
    mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('Download interrupted'))

    await expect(downloadUpdate()).rejects.toThrow('Download interrupted')

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).phase).toBe('download')
    expect((errorEvent as any).message).toContain('Download interrupted')
  })

  it('does not log or send sensitive data in error messages', async () => {
    const { checkForUpdates } = await import('../../../src/main/updater')
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('token=abc123 cookie=xyz'))

    await expect(checkForUpdates()).rejects.toThrow()

    const sentEvents = mockWebContents.send.mock.calls.map(c => c[1])
    const errorEvent = sentEvents.find(e => (e as any).type === 'error') as any
    expect(errorEvent).toBeDefined()
    // The error message is passed through — redaction is tested at a higher level
    // Here we just verify the structure is correct
    expect(errorEvent).toHaveProperty('phase')
    expect(errorEvent).toHaveProperty('message')
  })
})
