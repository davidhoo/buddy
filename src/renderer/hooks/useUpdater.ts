import { useCallback, useEffect, useRef, useState } from 'react'

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; info: { version: string; releaseDate?: string; mandatory?: boolean } }
  | { type: 'not-available' }
  | { type: 'progress'; progress: { bytesPerSecond: number; percent: number; transferred: number; total: number } }
  | { type: 'downloaded'; info: { version: string; releaseDate?: string } }
  | { type: 'installing'; version: string }
  | { type: 'error'; phase: 'check' | 'download' | 'install'; message: string }

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [version, setVersion] = useState<string>('')
  const [progress, setProgress] = useState({ percent: 0, bytesPerSecond: 0 })
  const [mandatory, setMandatory] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const downloaded = useRef(false)

  useEffect(() => {
    if (!window.api?.onUpdaterEvent) return
    return window.api.onUpdaterEvent((event: unknown) => {
      const e = event as UpdaterEvent
      switch (e.type) {
        case 'checking':
          if (!downloaded.current) {
            setStatus('checking')
            setErrorMessage('')
          }
          break
        case 'available':
          downloaded.current = false
          setStatus('available')
          setVersion(e.info.version)
          setMandatory(e.info.mandatory ?? false)
          setDismissed(false)
          setErrorMessage('')
          break
        case 'not-available':
          if (!downloaded.current) {
            setStatus('idle')
            setErrorMessage('')
          }
          break
        case 'progress':
          setStatus('downloading')
          setProgress({ percent: e.progress.percent, bytesPerSecond: e.progress.bytesPerSecond })
          setErrorMessage('')
          break
        case 'downloaded':
          downloaded.current = true
          setStatus('downloaded')
          setVersion(e.info.version)
          setDismissed(false)
          setErrorMessage('')
          break
        case 'installing':
          setStatus('installing')
          setVersion(e.version)
          break
        case 'error':
          setStatus('error')
          setErrorMessage(e.message)
          break
      }
    })
  }, [])

  const checkForUpdates = useCallback(() => {
    window.api?.checkForUpdates?.()
  }, [])

  const downloadUpdate = useCallback(() => {
    window.api?.downloadUpdate?.()
  }, [])

  const installUpdate = useCallback(() => {
    window.api?.installUpdate?.()
  }, [])

  const retryUpdate = useCallback(() => {
    setErrorMessage('')
    setStatus('checking')
    window.api?.checkForUpdates?.()
  }, [])

  const dismissNotification = useCallback(() => {
    setDismissed(true)
  }, [])

  return { status, version, progress, mandatory, dismissed, errorMessage, checkForUpdates, downloadUpdate, installUpdate, retryUpdate, dismissNotification }
}
