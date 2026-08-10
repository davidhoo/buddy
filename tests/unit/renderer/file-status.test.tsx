// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult, GlobalSettings } from '../../../src/shared/types'

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (params) return `${key}:${JSON.stringify(params)}`
    return key
  },
  useLanguage: () => 'zh-CN',
}))

vi.mock('../../../src/renderer/hooks/useBuddy', () => ({
  useGitStageAll: () => ({ mutateAsync: vi.fn() }),
  useGitCommitAndPush: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('../../../src/renderer/lib/api', () => ({
  api: {
    generateCommitMessage: vi.fn(),
    cancelGenerateCommitMessage: vi.fn(),
    gitStageFiles: vi.fn(),
  },
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ cancelQueries: vi.fn() }),
}))

vi.mock('../../../src/renderer/components/ChangesModal', () => ({
  ChangesModal: () => null,
}))
vi.mock('../../../src/renderer/components/BranchModal', () => ({
  BranchModal: () => null,
}))

import { CommitModal } from '../../../src/renderer/components/FileStatus'

function makeGitStatus(): GitStatusResult {
  return {
    branch: 'main',
    diff: { filesChanged: 1, insertions: 5, deletions: 2, summary: '' },
    staged: null,
    untracked: 0,
    files: [
      { path: 'src/app.ts', status: 'M', insertions: 5, deletions: 2 },
    ],
    remotes: [{ name: 'origin', url: 'git@github.com:test/repo.git' }],
  }
}

function makeSettings(autoGenerate = false): GlobalSettings {
  return { auto_generate_commit_message: autoGenerate }
}

function renderModal(overrides: Record<string, unknown> = {}) {
  const onClose = vi.fn()
  const props = {
    gitStatus: makeGitStatus(),
    repoRoot: '/tmp/repo',
    globalSettings: makeSettings(false),
    isTaskRunning: false,
    onClose,
    onSuccess: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
  render(<CommitModal {...props} />)
  return { onClose, props }
}

describe('CommitModal close behavior', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
        clear: vi.fn(() => store.clear()),
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('clicking the overlay (data-buddy-modal) does not call onClose', () => {
    const { onClose } = renderModal()
    const overlay = document.querySelector('[data-buddy-modal]') as HTMLElement
    expect(overlay).toBeTruthy()
    fireEvent.click(overlay)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clicking inside the panel does not call onClose', () => {
    const { onClose } = renderModal()
    const panel = document.querySelector('[data-buddy-modal] > div') as HTMLElement
    expect(panel).toBeTruthy()
    fireEvent.click(panel)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clicking the top-right close button calls onClose once', () => {
    const { onClose } = renderModal()
    const closeBtn = screen.getByText('×')
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the cancel button calls onClose once', () => {
    const { onClose } = renderModal()
    const cancelBtn = screen.getByText(/common\.cancel/)
    fireEvent.click(cancelBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pressing Escape calls onClose once', () => {
    const { onClose } = renderModal()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the overlay preserves already-typed commit message', () => {
    const { onClose } = renderModal()
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'my commit message' } })
    expect(textarea.value).toBe('my commit message')

    const overlay = document.querySelector('[data-buddy-modal]') as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).not.toHaveBeenCalled()
    expect(textarea.value).toBe('my commit message')
  })
})
