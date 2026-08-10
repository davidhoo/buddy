import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import type { UpdateInfo as ElectronUpdateInfo } from 'electron-updater'
import { redactSensitiveText } from './buddy/redact'

export interface UpdateInfo {
  version: string
  releaseDate?: string
  mandatory?: boolean
}

export interface DownloadProgress {
  bytesPerSecond: number
  percent: number
  transferred: number
  total: number
}

export type UpdaterPhase = 'check' | 'download' | 'install'

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; info: UpdateInfo }
  | { type: 'not-available' }
  | { type: 'progress'; progress: DownloadProgress }
  | { type: 'downloaded'; info: UpdateInfo }
  | { type: 'installing'; version: string }
  | { type: 'error'; phase: UpdaterPhase; message: string }

// ELECTRON_UPDATER_ALLOW_HTTP is set in src/main/index.ts before this module is imported.

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableDifferentialDownload = true

let mainWindow: BrowserWindow | null = null
let initialized = false
let checkInterval: ReturnType<typeof setInterval> | null = null

// Tracks the current updater phase so the generic error handler can report
// which operation failed. autoDownload=true means download-phase errors arrive
// through the generic handler, not through the downloadUpdate() wrapper.
let currentPhase: UpdaterPhase = 'check'

function sendError(phase: UpdaterPhase, err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err)
  const message = redactSensitiveText(raw) || 'Unknown update error'
  sendToRenderer({ type: 'error', phase, message })
}

function sendToRenderer(event: UpdaterEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:event', event)
  }
}

export function initUpdater(window: BrowserWindow): void {
  if (initialized) return
  initialized = true
  mainWindow = window

  autoUpdater.on('checking-for-update', () => {
    currentPhase = 'check'
    sendToRenderer({ type: 'checking' })
  })

  autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
    // autoDownload=true: electron-updater will start downloading immediately
    currentPhase = 'download'
    sendToRenderer({
      type: 'available',
      info: {
        version: info.version,
        releaseDate: info.releaseDate,
        mandatory: (info as unknown as Record<string, unknown>).mandatory === true
      }
    })
  })

  autoUpdater.on('update-not-available', () => {
    sendToRenderer({ type: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress: { bytesPerSecond: number; percent: number; transferred: number; total: number }) => {
    currentPhase = 'download'
    sendToRenderer({
      type: 'progress',
      progress: {
        bytesPerSecond: progress.bytesPerSecond,
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      }
    })
  })

  autoUpdater.on('update-downloaded', (info: ElectronUpdateInfo) => {
    currentPhase = 'install'
    sendToRenderer({
      type: 'downloaded',
      info: {
        version: info.version,
        releaseDate: info.releaseDate
      }
    })
  })

  autoUpdater.on('error', (err: Error | null) => {
    sendError(currentPhase, err)
  })

  // Delay first check to avoid impacting startup
  setTimeout(() => {
    currentPhase = 'check'
    autoUpdater.checkForUpdates().catch(() => {})
  }, 5000)

  // Periodic re-check every 30 minutes
  checkInterval = setInterval(() => {
    currentPhase = 'check'
    autoUpdater.checkForUpdates().catch(() => {})
  }, 30 * 60 * 1000)
}

export function setUpdaterWindow(window: BrowserWindow): void {
  mainWindow = window
}

export function checkForUpdates(): Promise<void> {
  currentPhase = 'check'
  return autoUpdater.checkForUpdates().then(() => undefined).catch((err) => {
    sendError('check', err)
    throw err
  })
}

export function downloadUpdate(): Promise<void> {
  currentPhase = 'download'
  return autoUpdater.downloadUpdate().then(() => undefined).catch((err) => {
    sendError('download', err)
    throw err
  })
}

export function quitAndInstall(): void {
  currentPhase = 'install'
  try {
    const version = autoUpdater.currentVersion?.version || ''
    sendToRenderer({ type: 'installing', version })
    autoUpdater.quitAndInstall()
  } catch (err) {
    sendError('install', err)
  }
}
