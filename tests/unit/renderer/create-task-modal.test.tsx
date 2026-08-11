// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { CreateTaskModal } from '../../../src/renderer/App'
import type { TFunction } from '../../../src/renderer/hooks/useI18n'

// A `t` that returns the translation key verbatim. Tests assert on these keys
// so they stay coupled to the i18n contract, not to any locale's wording.
const t = ((key: string) => key) as unknown as TFunction

vi.mock('../../../src/renderer/hooks/useBuddy', () => ({
  useGitStatus: () => ({ data: null, isLoading: false })
}))

vi.mock('../../../src/renderer/components/BranchModal', () => ({
  BranchModal: () => null
}))

type CreateTaskModalProps = Parameters<typeof CreateTaskModal>[0]

function mockWindowApi() {
  const api = {
    selectDirectory: vi.fn().mockResolvedValue(null),
    readClipboardFilePaths: vi.fn().mockResolvedValue([]),
    readFileAsDataURL: vi.fn().mockResolvedValue('')
  }
  const buddy = {
    detectActorModels: vi.fn().mockResolvedValue({})
  }
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  Object.defineProperty(window, 'buddy', { configurable: true, value: buddy })
  return { api, buddy }
}

function renderModal(overrides: Partial<CreateTaskModalProps> = {}) {
  const onCreate = vi.fn()
  mockWindowApi()
  const props: CreateTaskModalProps = {
    onClose: vi.fn(),
    onCreate,
    defaultRepoRoot: '/tmp/repo',
    globalSettings: null,
    t,
    ...overrides
  }
  render(<CreateTaskModal {...props} />)
  return { onCreate, ...props }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CreateTaskModal execution mode', () => {
  beforeEach(() => {
    // jsdom in this project exposes no localStorage by default; stub a minimal
    // in-memory store so the component's read/write of recent actor prefs works.
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

  it('defaults to immediate execution with the switch in the footer', () => {
    renderModal()

    const toggle = screen.getByRole('switch', {
      name: 'modal.create.executionMode.immediate'
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    // The switch lives in the same footer row as the cancel / submit buttons.
    // Walk up from the cancel button to the border-t footer row that contains
    // both the left (switch) and right (actions) groups — asserting on the row
    // rather than on the immediate parent, which is just the right-side group.
    let footer: HTMLElement = screen.getByText('common.cancel')
    while (footer.parentElement && !footer.className.includes('border-t')) {
      footer = footer.parentElement
    }
    expect(footer).toContainElement(toggle)
    expect(footer).toContainElement(screen.getByText('modal.create.submit'))

    // The old execution mode block (title, two buttons, hint paragraph) is gone.
    // The only switch-named control is the footer toggle; see the next test.
  })

  it('does not render the old two-button execution mode selector', () => {
    renderModal()
    // No buttons whose labels are the bare execution mode names (the old
    // segmented control used the same text as switch labels, so the switch
    // itself is the only switch-named control).
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(1)
  })

  it('submits with queued after toggling the switch off', () => {
    const { onCreate } = renderModal()

    // Enter a valid task name so canSubmit becomes true.
    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), {
      target: { value: 'ui-layout' }
    })

    // Toggle the switch off.
    const toggle = screen.getByRole('switch', {
      name: 'modal.create.executionMode.immediate'
    })
    fireEvent.click(toggle)

    // Accessible name now reflects the queued label and state is unchecked.
    expect(
      screen.getByRole('switch', { name: 'modal.create.executionMode.queued' })
    ).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(
      'ui-layout',
      expect.any(String),
      '/tmp/repo',
      expect.any(Object),
      undefined,
      'queued'
    )
  })

  it('submits with immediate by default', () => {
    const { onCreate } = renderModal()

    fireEvent.change(screen.getByPlaceholderText('modal.create.taskNamePlaceholder'), {
      target: { value: 'ui-layout' }
    })

    fireEvent.click(screen.getByRole('button', { name: /modal.create.submit/ }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    const args = onCreate.mock.calls[0]
    expect(args[args.length - 1]).toBe('immediate')
  })
})
