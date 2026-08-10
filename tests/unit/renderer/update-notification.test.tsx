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
      errorMessage: 'Code signature did not pass validation'
    })
    render(<UpdateNotification {...props} />)

    expect(screen.getByText('Update failed')).toBeTruthy()
    expect(screen.getByText('Code signature did not pass validation')).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
  })

  it('retry button calls onRetry exactly once', () => {
    const onRetry = vi.fn()
    const props = defaultProps({
      status: 'error',
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
      <UpdateNotification {...defaultProps({ status: 'error', errorMessage: longError })} />
    )
    expect(html).toContain(`title="${longError}"`)
    expect(html).toContain('line-clamp-3')
  })

  it('does not auto-dismiss error notification', () => {
    const props = defaultProps({
      status: 'error',
      errorMessage: 'Failed',
      dismissed: false
    })
    render(<UpdateNotification {...props} />)

    expect(screen.getByText('Update failed')).toBeTruthy()
  })

  it('returns null for idle/checking/available states', () => {
    const html = renderToStaticMarkup(
      <UpdateNotification {...defaultProps({ status: 'idle' })} />
    )
    expect(html).toBe('')
  })
})
