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

/** Who initiated the current check — controls whether a check-phase failure is user-visible. */
type UpdateCheckOrigin = 'background' | 'manual'

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

// Origin of the in-flight check. Set before checkForUpdates() and cleared only
// after update-available / update-not-available / error fires, so the generic
// error handler can read it. Null means no check is in flight.
let currentCheckOrigin: UpdateCheckOrigin | null = null
// single-flight guard so overlapping checks don't stack.
let checkInProgress = false
// Suppresses duplicate error dispatch for one failure: electron-updater emits
// 'error' AND rejects the checkForUpdates()/downloadUpdate() promise for the
// same failure. Covers all three phases so no double dispatch slips through.
let lastDispatchedError: { phase: UpdaterPhase; message: string } | null = null

function sendError(phase: UpdaterPhase, err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err)
  const message = redactSensitiveText(raw) || 'Unknown update error'
  // Dedup: the generic 'error' handler and the promise .catch() can both fire
  // for the same failure. Drop an exact repeat (same phase + redacted message).
  if (lastDispatchedError && lastDispatchedError.phase === phase && lastDispatchedError.message === message) {
    return
  }
  lastDispatchedError = { phase, message }
  sendToRenderer({ type: 'error', phase, message })
}

function sendToRenderer(event: UpdaterEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:event', event)
  }
}

/**
 * Internal check runner. Handles single-flight and origin promotion.
 * - background checks that overlap an in-flight check are skipped.
 * - manual checks that overlap a background check promote it to manual, so a
 *   failure becomes user-visible.
 */
function runCheck(origin: UpdateCheckOrigin): Promise<void> {
  // Promote an in-flight background check to manual if the user asked.
  if (checkInProgress) {
    if (origin === 'manual' && currentCheckOrigin === 'background') {
      currentCheckOrigin = 'manual'
    }
    return Promise.resolve()
  }

  checkInProgress = true
  currentCheckOrigin = origin
  currentPhase = 'check'
  // Reset per-operation dedup so a repeated identical error across separate
  // checks (e.g. retry after a network failure) is still surfaced. The dedup
  // window only needs to cover the generic 'error' handler + promise .catch()
  // pair within this one operation.
  lastDispatchedError = null

  // The 'checking-for-update' handler surfaces the checking state; we do NOT
  // send it here to avoid a double dispatch on manual checks.

  return autoUpdater
    .checkForUpdates()
    .then(() => undefined)
    .catch((err) => {
      // Only dispatch a check-phase error for manual checks, and only if the
      // generic 'error' handler hasn't already dispatched one for this cycle.
      if (currentCheckOrigin === 'manual') {
        sendError('check', err)
      }
      throw err
    })
    .finally(() => {
      // Single owner of the in-flight flag — terminal handlers do not touch it,
      // so a late .finally() can never clobber a check that started after an
      // early 'error' event.
      currentCheckOrigin = null
      checkInProgress = false
    })
}

export function initUpdater(window: BrowserWindow): void {
  if (initialized) return
  initialized = true
  mainWindow = window

  autoUpdater.on('checking-for-update', () => {
    currentPhase = 'check'
    // Only surface the checking state for user-initiated checks.
    if (currentCheckOrigin === 'manual') {
      sendToRenderer({ type: 'checking' })
    }
  })

  autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
    // autoDownload=true: electron-updater will start downloading immediately
    currentPhase = 'download'
    currentCheckOrigin = null
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
    currentCheckOrigin = null
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
    if (currentPhase === 'check') {
      // Check-phase error: only surface for manual checks.
      if (currentCheckOrigin === 'manual') {
        sendError('check', err)
      }
      // Do NOT clear checkInProgress here — .finally() owns that flag, so a
      // late .finally() can't clobber a check that started after this event.
    } else {
      // download / install phase errors are always user-visible; sendError()
      // dedups against the promise .catch() path.
      sendError(currentPhase, err)
    }
  })

  // Delay first check to avoid impacting startup
  setTimeout(() => {
    runCheck('background').catch(() => {})
  }, 5000)

  // Periodic re-check every 30 minutes
  checkInterval = setInterval(() => {
    runCheck('background').catch(() => {})
  }, 30 * 60 * 1000)
}

export function setUpdaterWindow(window: BrowserWindow): void {
  mainWindow = window
}

export function checkForUpdates(): Promise<void> {
  return runCheck('manual')
}

export function downloadUpdate(): Promise<void> {
  currentPhase = 'download'
  // Reset per-operation dedup so a repeated identical download error across
  // separate downloads is still surfaced.
  lastDispatchedError = null
  return autoUpdater.downloadUpdate().then(() => undefined).catch((err) => {
    // sendError dedups against the generic 'error' handler that fires for the
    // same failure, so this is at most one dispatch total.
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
