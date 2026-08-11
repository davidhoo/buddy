// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateNotification } from '../../../src/renderer/components/UpdateNotification'

describe('UpdateNotification', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
        clear: vi.fn(() => store.clear())
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  function defaultProps(overrides: Record<string, unknown> = {}) {
    return {
      status: 'downloaded' as const,
      version: '1.2.13',
      progress: { percent: 100, bytesPerSecond: 0 },
      dismissed: false,
      errorMessage: '',
      errorPhase: null as 'check' | 'download' | 'install' | null,
      onInstall: vi.fn(),
      onRetry: vi.fn(),
      onDismiss: vi.fn(),
      ...overrides
    }
  }

  it('renders installing state with correct text', () => {
    const props = defaultProps({ status: 'installing' })
    render(<UpdateNotification {...props} />)

    expect(screen.getByText('Restarting & Installing…')).toBeTruthy()
  })

  it('does not show dismiss button in installing state', () => {
    const props = defaultProps({ status: 'installing' })
    render(<UpdateNotification {...props} />)

    // No X button — installing cannot be dismissed
    const buttons = screen.queryAllByRole('button')
    expect(buttons).toHaveLength(0)
  })

  it('renders error state with error message and retry button', () => {
    const props = defaultProps({
      status: 'error',
      errorPhase: 'check',
      errorMessage: 'Code signature did not pass validation'
    })
    render(<UpdateNotification {...props} />)

    expect(screen.getByText('Check for updates failed')).toBeTruthy()
    expect(screen.getByText('Code signature did not pass validation')).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
  })

  it('retry button calls onRetry exactly once', () => {
    const onRetry = vi.fn()
    const props = defaultProps({
      status: 'error',
      errorPhase: 'install',
      errorMessage: 'Install failed',
      onRetry
    })
    render(<UpdateNotification {...props} />)

    fireEvent.click(screen.getByText('Retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('install button calls onInstall exactly once', () => {
    const onInstall = vi.fn()
    const props = defaultProps({
      status: 'downloaded',
      onInstall
    })
    render(<UpdateNotification {...props} />)

    fireEvent.click(screen.getByText('Restart to Update'))
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it('error message is truncated with title attribute for full text', () => {
    const longError = 'A'.repeat(200)
    const html = renderToStaticMarkup(
      <UpdateNotification {...defaultProps({ status: 'error', errorPhase: 'check', errorMessage: longError })} />
    )
    expect(html).toContain(`title="${longError}"`)
    expect(html).toContain('line-clamp-3')
  })

  it('does not auto-dismiss error notification', () => {
    const props = defaultProps({
      status: 'error',
      errorPhase: 'check',
      errorMessage: 'Failed',
      dismissed: false
    })
    render(<UpdateNotification {...props} />)

    expect(screen.getByText('Check for updates failed')).toBeTruthy()
  })

  it('returns null for idle/checking/available states', () => {
    const html = renderToStaticMarkup(
      <UpdateNotification {...defaultProps({ status: 'idle' })} />
    )
    expect(html).toBe('')
  })

  it('renders nothing when dismissed and status is error', () => {
    const html = renderToStaticMarkup(
      <UpdateNotification {...defaultProps({
        status: 'error',
        errorPhase: 'check',
        errorMessage: 'Network error',
        dismissed: true
      })} />
    )
    expect(html).toBe('')
  })

  it('still renders installing when dismissed (no close button)', () => {
    const html = renderToStaticMarkup(
      <UpdateNotification {...defaultProps({ status: 'installing', dismissed: true })} />
    )
    expect(html).toContain('Restarting &amp; Installing…')
    expect(html).not.toContain('aria-label')
  })

  it('dismiss (X) button calls onDismiss and has accessible name', () => {
    const onDismiss = vi.fn()
    const props = defaultProps({
      status: 'error',
      errorPhase: 'check',
      errorMessage: 'Network unreachable',
      onDismiss
    })
    render(<UpdateNotification {...props} />)

    const dismissBtn = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(dismissBtn)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('uses phase-specific error titles', () => {
    const checkHtml = renderToStaticMarkup(
      <UpdateNotification {...defaultProps({ status: 'error', errorPhase: 'check', errorMessage: 'a' })} />
    )
    expect(checkHtml).toContain('Check for updates failed')

    const downloadHtml = renderToStaticMarkup(
      <UpdateNotification {...defaultProps({ status: 'error', errorPhase: 'download', errorMessage: 'b' })} />
    )
    expect(downloadHtml).toContain('Download failed')

    const installHtml = renderToStaticMarkup(
      <UpdateNotification {...defaultProps({ status: 'error', errorPhase: 'install', errorMessage: 'c' })} />
    )
    expect(installHtml).toContain('Install failed')
  })
})
