// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult, GlobalSettings } from '../../../src/shared/types'

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (params) return `${key}:${JSON.stringify(params)}`
    return key
  },
  useLanguage: () => 'zh-CN',
}))

let commitPushMock: ReturnType<typeof vi.fn>
vi.mock('../../../src/renderer/hooks/useBuddy', () => ({
  useGitStageAll: () => ({ mutateAsync: vi.fn() }),
  useGitCommitAndPush: () => ({ mutateAsync: (...args: unknown[]) => commitPushMock(...args) }),
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
    upstream: null,
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

describe('CommitModal remote display', () => {
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

  it('hides remote selector and disables push when no remotes', () => {
    renderModal({ gitStatus: { ...makeGitStatus(), remotes: [] } })
    // no remote label
    expect(screen.queryByText('git.remote')).toBeNull()
    // no remote <select>; the remaining select is the actor picker, whose option values are actor names
    const selects = document.querySelectorAll('select')
    for (const sel of Array.from(selects)) {
      const opts = Array.from(sel.options).map(o => o.value)
      expect(opts).not.toContain('origin')
    }
    // push checkbox disabled (the one labeled "Push after commit"), shows noRemote hint
    const pushLabel = screen.getByText('git.push').closest('label') as HTMLElement
    const pushCheckbox = pushLabel.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(pushCheckbox.disabled).toBe(true)
    expect(screen.getByText(/git\.noRemote/)).toBeTruthy()
  })

  it('shows the single remote by name (no URL) and enables push', () => {
    renderModal({ gitStatus: { ...makeGitStatus(), remotes: [{ name: 'origin', url: 'git@github.com:test/repo.git' }] } })
    expect(screen.getByText('git.remote')).toBeTruthy()
    // find the remote select by its origin option
    const selects = Array.from(document.querySelectorAll('select'))
    const select = selects.find(s => Array.from(s.options).some(o => o.value === 'origin')) as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.value).toBe('origin')
    expect(select.options[0].textContent).toBe('origin')
    // 不显示 URL
    expect(document.body.textContent).not.toContain('git@github.com')
    const pushLabel = screen.getByText('git.push').closest('label') as HTMLElement
    const pushCheckbox = pushLabel.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(pushCheckbox.disabled).toBe(false)
  })

  it('marks only the upstream remote with (remote/branch)', () => {
    renderModal({
      gitStatus: {
        ...makeGitStatus(),
        upstream: { remote: 'origin', branch: 'main' },
        remotes: [
          { name: 'origin', url: 'git@github.com:test/origin.git' },
          { name: 'backup', url: 'git@github.com:test/backup.git' }
        ]
      }
    })
    const selects = Array.from(document.querySelectorAll('select'))
    const select = selects.find(s => Array.from(s.options).some(o => o.value === 'origin')) as HTMLSelectElement
    const labels = Array.from(select.options).map(o => o.textContent)
    expect(labels).toEqual(['origin (origin/main)', 'backup'])
  })

  it('shows only remote names when upstream is null', () => {
    renderModal({
      gitStatus: {
        ...makeGitStatus(),
        upstream: null,
        remotes: [
          { name: 'origin', url: 'git@github.com:test/origin.git' },
          { name: 'backup', url: 'git@github.com:test/backup.git' }
        ]
      }
    })
    const selects = Array.from(document.querySelectorAll('select'))
    const select = selects.find(s => Array.from(s.options).some(o => o.value === 'origin')) as HTMLSelectElement
    const labels = Array.from(select.options).map(o => o.textContent)
    expect(labels).toEqual(['origin', 'backup'])
    // 不出现括号标记
    expect(document.body.textContent).not.toContain('(origin/')
  })

  it('keeps remote label and select on the same row, separate from the bottom push row', () => {
    renderModal({ gitStatus: { ...makeGitStatus(), remotes: [{ name: 'origin', url: 'git@github.com:test/repo.git' }] } })
    const remoteLabel = screen.getByText('git.remote')
    const selects = Array.from(document.querySelectorAll('select'))
    const select = selects.find(s => Array.from(s.options).some(o => o.value === 'origin')) as HTMLSelectElement
    // 远端标签与 select 在同一个行容器
    const rowContainer = remoteLabel.parentElement
    expect(rowContainer).toContainElement(select)
    // 左下角 push 行在另一个容器, 不与远端行共享父节点
    const pushLabel = screen.getByText('git.push')
    expect(rowContainer).not.toContainElement(pushLabel)
  })

  it('lists multiple remotes and persists the chosen one per repo', () => {
    renderModal({
      gitStatus: {
        ...makeGitStatus(),
        remotes: [
          { name: 'origin', url: 'git@github.com:test/origin.git' },
          { name: 'backup', url: 'git@github.com:test/backup.git' }
        ]
      }
    })
    const selects = Array.from(document.querySelectorAll('select'))
    const select = selects.find(s => Array.from(s.options).some(o => o.value === 'origin')) as HTMLSelectElement
    expect(select.value).toBe('origin')
    fireEvent.change(select, { target: { value: 'backup' } })
    expect(select.value).toBe('backup')
    expect(window.localStorage.setItem).toHaveBeenCalledWith('buddy.lastRemote./tmp/repo', 'backup')
  })

  it('falls back to first remote when stored remote no longer exists', () => {
    window.localStorage.setItem('buddy.lastRemote./tmp/repo', 'deleted-remote')
    renderModal({ gitStatus: { ...makeGitStatus(), remotes: [{ name: 'origin', url: 'git@github.com:test/origin.git' }] } })
    const selects = Array.from(document.querySelectorAll('select'))
    const select = selects.find(s => Array.from(s.options).some(o => o.value === 'origin')) as HTMLSelectElement
    expect(select.value).toBe('origin')
    // must not fabricate a fake origin when there is no remote; selectedRemote is '' so
    // the persistence effect skips writing.
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith('buddy.lastRemote./tmp/repo', '')
  })
})

describe('CommitModal commit/push result feedback', () => {
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

  async function commitWithResult(result: unknown) {
    commitPushMock = vi.fn().mockResolvedValue(result)
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const onClose = vi.fn()
    render(<CommitModal
      gitStatus={makeGitStatus()}
      repoRoot="/tmp/repo"
      globalSettings={makeSettings(false)}
      taskSettings={null}
      onClose={onClose}
      onSuccess={onSuccess}
      onError={onError}
    />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'msg' } })
    const commitBtn = screen.getByRole('button', { name: /git\.commitTitle|git\.commit/ })
    fireEvent.click(commitBtn)
    await waitFor(() => expect(commitPushMock).toHaveBeenCalled())
    return { onSuccess, onError, onClose }
  }

  it('shows commitSuccess and closes on pushed', async () => {
    const { onSuccess, onError, onClose } = await commitWithResult({
      commitHash: 'abc1234', pushStatus: 'pushed', remote: 'origin', upstreamCreated: false, pushError: null
    })
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    expect(onSuccess.mock.calls[0][0]).toContain('git.commitSuccess')
    expect(onError).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows commitOnlySuccess and closes on not_requested', async () => {
    const { onSuccess, onError } = await commitWithResult({
      commitHash: 'abc1234', pushStatus: 'not_requested', remote: null, upstreamCreated: false, pushError: null
    })
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    expect(onSuccess.mock.calls[0][0]).toContain('git.commitOnlySuccess')
    expect(onError).not.toHaveBeenCalled()
  })

  it('shows pushFailedAfterCommit with hash/remote/error, then closes without onSuccess', async () => {
    const { onSuccess, onError, onClose } = await commitWithResult({
      commitHash: 'abc1234', pushStatus: 'failed', remote: 'origin', upstreamCreated: false, pushError: 'non-fast-forward'
    })
    await waitFor(() => expect(onError).toHaveBeenCalled())
    const msg = onError.mock.calls[0][0]
    expect(msg).toContain('git.pushFailedAfterCommit')
    expect(msg).toContain('abc1234')
    expect(msg).toContain('origin')
    expect(msg).toContain('non-fast-forward')
    expect(onSuccess).not.toHaveBeenCalled()
    // modal closes after partial-success push failure
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps modal open and shows commitFailed when mutation rejects', async () => {
    commitPushMock = vi.fn().mockRejectedValue(new Error('nothing staged'))
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const onClose = vi.fn()
    render(<CommitModal
      gitStatus={makeGitStatus()}
      repoRoot="/tmp/repo"
      globalSettings={makeSettings(false)}
      taskSettings={null}
      onClose={onClose}
      onSuccess={onSuccess}
      onError={onError}
    />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'msg' } })
    const commitBtn = screen.getByRole('button', { name: /git\.commitTitle|git\.commit/ })
    fireEvent.click(commitBtn)
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(onError.mock.calls[0][0]).toContain('git.commitFailed')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('CommitModal commit allowed while task running', () => {
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

  it('commit button stays enabled with changes and a message (no isTaskRunning prop)', async () => {
    commitPushMock = vi.fn().mockResolvedValue({
      commitHash: 'abc1234', pushStatus: 'not_requested', remote: null, upstreamCreated: false, pushError: null
    })
    render(<CommitModal
      gitStatus={makeGitStatus()}
      repoRoot="/tmp/repo"
      globalSettings={makeSettings(false)}
      taskSettings={null}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
      onError={vi.fn()}
    />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'msg' } })
    const commitBtn = screen.getByRole('button', { name: /git\.commitTitle|git\.commit/ }) as HTMLButtonElement
    expect(commitBtn.disabled).toBe(false)
    fireEvent.click(commitBtn)
    await waitFor(() => expect(commitPushMock).toHaveBeenCalled())
    // 确认提交仍调用 stage + commitAndPush
    expect(api.gitStageFiles).toHaveBeenCalledWith('/tmp/repo', expect.any(Array))
  })
})
