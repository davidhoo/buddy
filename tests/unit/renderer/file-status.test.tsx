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
    generateCommitMessage: vi.fn().mockResolvedValue({ message: '' }),
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
import { api } from '../../../src/renderer/lib/api'

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
    taskSettings: null,
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

describe('CommitModal actor selection', () => {
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

  it('defaults to task implementer when no stored actor', () => {
    const { props } = renderModal({ taskSettings: { implementer_actor: 'codex' } })
    const select = screen.getByDisplayValue('Codex') as HTMLSelectElement
    expect(select.value).toBe('codex')
  })

  it('uses stored actor from localStorage when valid', () => {
    localStorage.setItem('buddy.lastCommitMessageActor', 'cursor')
    renderModal({ taskSettings: { implementer_actor: 'codex' } })
    const select = screen.getByDisplayValue('Cursor') as HTMLSelectElement
    expect(select.value).toBe('cursor')
  })

  it('falls back to task implementer when stored actor is invalid', () => {
    localStorage.setItem('buddy.lastCommitMessageActor', 'invalid_actor')
    renderModal({ taskSettings: { implementer_actor: 'kimi' } })
    const select = screen.getByDisplayValue('Kimi') as HTMLSelectElement
    expect(select.value).toBe('kimi')
  })

  it('falls back to claude when both stored and implementer are invalid', () => {
    localStorage.setItem('buddy.lastCommitMessageActor', 'invalid')
    renderModal({ taskSettings: null })
    const select = screen.getByDisplayValue('Claude') as HTMLSelectElement
    expect(select.value).toBe('claude')
  })

  it('generates commit message with correct actor', async () => {
    const mockGenerate = vi.mocked(api.generateCommitMessage)
    mockGenerate.mockResolvedValue({ message: 'feat: test message' })

    renderModal({ taskSettings: { implementer_actor: 'codex' } })

    // Find and click the generate button
    const generateBtn = screen.getByText(/git\.generateMessage/)
    fireEvent.click(generateBtn)

    await vi.waitFor(() => {
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'codex',
          repoRoot: '/tmp/repo',
          lang: 'zh-CN',
          paths: expect.any(Array),
          taskSettings: expect.objectContaining({ implementer_actor: 'codex' })
        })
      )
    })
  })

  it('cancels old generation when switching actor', () => {
    const mockCancel = vi.mocked(api.cancelGenerateCommitMessage)
    const mockGenerate = vi.mocked(api.generateCommitMessage)
    mockGenerate.mockReturnValue(new Promise(() => {})) // never resolves

    renderModal({ taskSettings: { implementer_actor: 'codex' }, globalSettings: makeSettings(false) })

    // Start generation
    const generateBtn = screen.getByText(/git\.generateMessage/)
    fireEvent.click(generateBtn)

    // Switch actor while generating
    const select = screen.getByDisplayValue('Codex') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'claude' } })

    expect(mockCancel).toHaveBeenCalled()
  })

  it('cancels generation on close via Escape', () => {
    const mockCancel = vi.mocked(api.cancelGenerateCommitMessage)
    const mockGenerate = vi.mocked(api.generateCommitMessage)
    mockGenerate.mockReturnValue(new Promise(() => {}))

    renderModal({ taskSettings: { implementer_actor: 'codex' }, globalSettings: makeSettings(false) })

    const generateBtn = screen.getByText(/git\.generateMessage/)
    fireEvent.click(generateBtn)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(mockCancel).toHaveBeenCalled()
  })

  it('displays multi-line commit message in textarea', async () => {
    const mockGenerate = vi.mocked(api.generateCommitMessage)
    const multiLineMessage = 'docs: 新增安装渠道\n\n- README 新增小节\n  提供安装命令\n\n对应 Tap 仓库。'
    mockGenerate.mockResolvedValue({ message: multiLineMessage })

    renderModal({ taskSettings: { implementer_actor: 'codex' }, globalSettings: makeSettings(false) })

    const generateBtn = screen.getByText(/git\.generateMessage/)
    fireEvent.click(generateBtn)

    await vi.waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      expect(textarea.value).toContain('docs: 新增安装渠道')
      expect(textarea.value).toContain('- README 新增小节')
      expect(textarea.value).toContain('  提供安装命令')
      expect(textarea.value).toContain('对应 Tap 仓库。')
    })
  })

  it('preserves bullets, blank lines, and indentation in textarea', async () => {
    const mockGenerate = vi.mocked(api.generateCommitMessage)
    const message = 'feat: test\n\n- item 1\n  continued\n- item 2\n\nparagraph'
    mockGenerate.mockResolvedValue({ message })

    renderModal({ taskSettings: { implementer_actor: 'codex' }, globalSettings: makeSettings(false) })

    const generateBtn = screen.getByText(/git\.generateMessage/)
    fireEvent.click(generateBtn)

    await vi.waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      expect(textarea.value).toBe(message)
    })
  })
})

describe('CommitModal re-render resilience', () => {
  beforeEach(() => {
    vi.mocked(api.generateCommitMessage).mockClear()
    vi.mocked(api.cancelGenerateCommitMessage).mockClear()
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

  it('does not cancel generation when onClose callback identity changes', async () => {
    const mockCancel = vi.mocked(api.cancelGenerateCommitMessage)
    const mockGenerate = vi.mocked(api.generateCommitMessage)
    // 一个尚未完成的 Promise
    let resolveGenerate!: (v: { message: string }) => void
    const pending = new Promise<{ message: string }>((resolve) => { resolveGenerate = resolve })
    mockGenerate.mockReturnValue(pending)

    const baseProps = {
      gitStatus: makeGitStatus(),
      repoRoot: '/tmp/repo',
      globalSettings: makeSettings(true),
      taskSettings: { implementer_actor: 'codex' },
      isTaskRunning: false,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    }
    const firstOnClose = vi.fn()
    const { rerender } = render(<CommitModal {...baseProps} onClose={firstOnClose} />)

    // 自动生成只应触发一次
    await vi.waitFor(() => {
      expect(mockGenerate).toHaveBeenCalledTimes(1)
    })

    // 用一个新的 onClose 函数引用重新渲染(模拟 StatusBar 每秒重渲染)
    const newOnClose = vi.fn()
    rerender(<CommitModal {...baseProps} onClose={newOnClose} />)

    // onClose 引用变化不得取消正在进行的生成
    expect(mockCancel).not.toHaveBeenCalled()
    // 也没有重新发起生成
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    // 仍在生成状态(生成按钮显示“生成中”文案)
    expect(screen.getByText(/git\.generatingButton/)).toBeTruthy()
    // 没有显示生成失败提示
    expect(screen.queryByText(/git\.generateFailed/)).toBeNull()

    // 让原始生成请求返回合法提交信息
    resolveGenerate({ message: 'feat: resolved via pending promise' })

    await vi.waitFor(() => {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
      expect(textarea.value).toBe('feat: resolved via pending promise')
    })
  })

  it('cancels pending generation when unmounted', () => {
    const mockCancel = vi.mocked(api.cancelGenerateCommitMessage)
    const mockGenerate = vi.mocked(api.generateCommitMessage)
    mockGenerate.mockReturnValue(new Promise(() => {}))

    const onClose = vi.fn()
    const baseProps = {
      gitStatus: makeGitStatus(),
      repoRoot: '/tmp/repo',
      globalSettings: makeSettings(false),
      taskSettings: { implementer_actor: 'codex' },
      isTaskRunning: false,
      onClose,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    }
    const { unmount } = render(<CommitModal {...baseProps} />)

    const generateBtn = screen.getByText(/git\.generateMessage/)
    fireEvent.click(generateBtn)

    unmount()

    // 卸载时清理函数应取消尚未结束的生成
    expect(mockCancel).toHaveBeenCalled()

    // 卸载后触发 Escape 不得再次调用旧 onClose:
    // document 上的 Esc 监听器必须已被移除,残留会导致旧 onClose 被调用。
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
