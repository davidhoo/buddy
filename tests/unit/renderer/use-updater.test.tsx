// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, cleanup, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'

describe('useUpdater', () => {
  let updaterCallback: ((event: unknown) => void) | null = null

  beforeEach(() => {
    updaterCallback = null
    vi.resetModules()
    // Set api on existing window — do NOT replace the whole window object
    ;(window as any).api = {
      onUpdaterEvent: vi.fn((cb: (event: unknown) => void) => {
        updaterCallback = cb
        return () => { updaterCallback = null }
      }),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn()
    }
  })

  afterEach(() => {
    cleanup()
    delete (window as any).api
  })

  function renderHook<T>(hook: () => T): { current: T } {
    const ref: { current: T } = { current: null as unknown as T }
    function TestComponent() {
      ref.current = hook()
      return null
    }
    render(<TestComponent />)
    return ref
  }

  it('starts in idle status', async () => {
    const { useUpdater } = await import('../../../src/renderer/hooks/useUpdater')
    const ref = renderHook(useUpdater)
    expect(ref.current.status).toBe('idle')
    expect(ref.current.errorMessage).toBe('')
  })

  it('transitions downloaded -> installing when install event arrives', async () => {
    const { useUpdater } = await import('../../../src/renderer/hooks/useUpdater')
    const ref = renderHook(useUpdater)

    act(() => {
      updaterCallback?.({ type: 'downloaded', info: { version: '1.2.13' } })
    })
    expect(ref.current.status).toBe('downloaded')

    act(() => {
      updaterCallback?.({ type: 'installing', version: '1.2.13' })
    })
    expect(ref.current.status).toBe('installing')
    expect(ref.current.version).toBe('1.2.13')
  })

  it('transitions to error when error event arrives after downloaded', async () => {
    const { useUpdater } = await import('../../../src/renderer/hooks/useUpdater')
    const ref = renderHook(useUpdater)

    act(() => {
      updaterCallback?.({ type: 'downloaded', info: { version: '1.2.13' } })
    })
    expect(ref.current.status).toBe('downloaded')

    act(() => {
      updaterCallback?.({
        type: 'error',
        phase: 'install',
        message: 'Code signature at URL ... did not pass validation'
      })
    })
    expect(ref.current.status).toBe('error')
    expect(ref.current.errorMessage).toContain('Code signature')
  })

  it('error is distinct from not-available', async () => {
    const { useUpdater } = await import('../../../src/renderer/hooks/useUpdater')
    const ref = renderHook(useUpdater)

    act(() => {
      updaterCallback?.({ type: 'error', phase: 'install', message: 'Install failed' })
    })
    expect(ref.current.status).toBe('error')
    expect(ref.current.errorMessage).toBe('Install failed')

    act(() => {
      updaterCallback?.({ type: 'not-available' })
    })
    expect(ref.current.status).toBe('idle')
    expect(ref.current.errorMessage).toBe('')
  })

  it('retryUpdate clears error and re-checks', async () => {
    const { useUpdater } = await import('../../../src/renderer/hooks/useUpdater')
    const ref = renderHook(useUpdater)

    act(() => {
      updaterCallback?.({ type: 'error', phase: 'install', message: 'Failed' })
    })
    expect(ref.current.status).toBe('error')

    act(() => {
      ref.current.retryUpdate()
    })
    expect(ref.current.status).toBe('checking')
    expect(ref.current.errorMessage).toBe('')
    expect((window as any).api.checkForUpdates).toHaveBeenCalled()
  })

  it('receiving available/progress/downloaded clears error', async () => {
    const { useUpdater } = await import('../../../src/renderer/hooks/useUpdater')
    const ref = renderHook(useUpdater)

    act(() => {
      updaterCallback?.({ type: 'error', phase: 'check', message: 'Network error' })
    })
    expect(ref.current.status).toBe('error')

    act(() => {
      updaterCallback?.({ type: 'available', info: { version: '1.2.13' } })
    })
    expect(ref.current.status).toBe('available')
    expect(ref.current.errorMessage).toBe('')
  })

  it('downloaded status is not ignored when error follows it', async () => {
    const { useUpdater } = await import('../../../src/renderer/hooks/useUpdater')
    const ref = renderHook(useUpdater)

    act(() => {
      updaterCallback?.({ type: 'downloaded', info: { version: '1.2.13' } })
    })
    expect(ref.current.status).toBe('downloaded')

    act(() => {
      updaterCallback?.({ type: 'error', phase: 'install', message: 'Signature failed' })
    })
    expect(ref.current.status).toBe('error')
  })
})
