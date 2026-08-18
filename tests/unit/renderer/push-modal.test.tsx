// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult, GitPushAvailability, GitPushResult } from '../../../src/shared/types'

let pushAvailData: GitPushAvailability | undefined = undefined
let pushAvailLoading = false
let pushAvailError = false
const pushAvailRefetch = vi.fn()

let pushMutateAsync: ReturnType<typeof vi.fn>

const invalidateQueries = vi.fn().mockResolvedValue(undefined)
const getQueryData = vi.fn()

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (params) return key + ':' + JSON.stringify(params)
    return key
  },
  useLanguage: () => 'zh-CN',
}))

vi.mock('../../../src/renderer/hooks/useBuddy', () => ({
  useGitPushAvailability: vi.fn(() => ({
    data: pushAvailData,
    isLoading: pushAvailLoading,
    isError: pushAvailError,
    error: pushAvailError ? new Error('boom') : null,
    refetch: pushAvailRefetch,
  })),
  useGitPush: () => ({ mutateAsync: (...args: unknown[]) => pushMutateAsync(...args) }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries, getQueryData }),
}))

import { PushModal } from '../../../src/renderer/components/PushModal'
import { useGitPushAvailability } from '../../../src/renderer/hooks/useBuddy'

function makeGitStatus(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    branch: 'main',
    diff: null,
    staged: null,
    untracked: 0,
    files: [],
    remotes: [{ name: 'origin', url: 'git@github.com:test/repo.git' }],
    upstream: null,
    ...overrides,
  }
}

function makeAvail(overrides: Partial<GitPushAvailability> = {}): GitPushAvailability {
  return {
    state: 'ahead',
    remote: 'origin',
    branch: 'main',
    ahead: 1,
    behind: 0,
    pendingCommits: [],
    upstreamCreatedOnPush: false,
    ...overrides,
  }
}

function makePushResult(overrides: Partial<GitPushResult> = {}): GitPushResult {
  return {
    pushStatus: 'pushed',
    remote: 'origin',
    upstreamCreated: false,
    pushError: null,
    ...overrides,
  }
}

function resetState() {
  pushAvailData = undefined
  pushAvailLoading = false
  pushAvailError = false
  pushAvailRefetch.mockClear()
  vi.mocked(useGitPushAvailability).mockClear()
  pushMutateAsync = vi.fn()
  invalidateQueries.mockClear()
  getQueryData.mockClear()
}

function renderModal(overrides: Record<string, unknown> = {}) {
  const onClose = vi.fn()
  const onSuccess = vi.fn()
  const onError = vi.fn()
  const props = {
    gitStatus: makeGitStatus(),
    repoRoot: '/tmp/repo',
    initialRemote: 'origin',
    onClose,
    onSuccess,
    onError,
    ...overrides,
  }
  render(<PushModal {...props} />)
  return { onClose, onSuccess, onError, props }
}

describe('PushModal', () => {
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
    resetState()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not render textbox, file table, stage buttons, generate buttons, or commit-push checkbox', () => {
    pushAvailData = makeAvail()
    renderModal()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.querySelector('table')).toBeNull()
    expect(screen.queryByText(/git\.stageAll/)).toBeNull()
    expect(screen.queryByText(/git\.generateMessage/)).toBeNull()
  })

  it('shows initial remote from availability and ahead status with push enabled', () => {
    pushAvailData = makeAvail({ ahead: 5 })
    renderModal()
    expect(screen.getByText(/git\.pushAhead/).textContent).toContain('5')
    const pushBtn = screen.getByText('git.pushNow').closest('button') as HTMLButtonElement
    expect(pushBtn.disabled).toBe(false)
  })

  it('shows new_branch status with push enabled', () => {
    pushAvailData = makeAvail({ state: 'new_branch' })
    renderModal()
    expect(screen.getByText(/git\.pushNewBranch/)).toBeTruthy()
    const pushBtn = screen.getByText('git.pushNow').closest('button') as HTMLButtonElement
    expect(pushBtn.disabled).toBe(false)
  })

  for (const state of ['up_to_date', 'behind', 'diverged', 'unavailable'] as const) {
    it('disables push button when state is ' + state, () => {
      pushAvailData = makeAvail({ state })
      renderModal()
      const pushBtn = screen.getByText('git.pushNow').closest('button') as HTMLButtonElement
      expect(pushBtn.disabled).toBe(true)
    })
  }

  it('disables push button and shows retry on fetch error', () => {
    pushAvailData = undefined
    pushAvailError = true
    renderModal()
    expect(screen.getByText(/git\.pushCheckFailed/)).toBeTruthy()
    const pushBtn = screen.getByText('git.pushNow').closest('button') as HTMLButtonElement
    expect(pushBtn.disabled).toBe(true)
    fireEvent.click(screen.getByText('common.retry'))
    expect(pushAvailRefetch).toHaveBeenCalled()
  })

  it('shows loading indicator while checking remote status', () => {
    pushAvailData = undefined
    pushAvailLoading = true
    renderModal()
    expect(screen.getByText(/git\.pushChecking/)).toBeTruthy()
    const pushBtn = screen.getByText('git.pushNow').closest('button') as HTMLButtonElement
    expect(pushBtn.disabled).toBe(true)
  })

  it('force refetches before push and only pushes if still ahead', async () => {
    pushAvailData = makeAvail({ state: 'ahead' })
    pushMutateAsync = vi.fn().mockResolvedValue(makePushResult())
    getQueryData.mockReturnValue(makeAvail({ state: 'ahead' }))
    const { onSuccess, onClose } = renderModal()
    const pushBtn = screen.getByText('git.pushNow').closest('button') as HTMLButtonElement
    fireEvent.click(pushBtn)
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['gitPushAvailability'] }))
    await waitFor(() => expect(pushMutateAsync).toHaveBeenCalledWith({ repoRoot: '/tmp/repo', remote: 'origin' }))
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it('does not push if state changed to behind after force refetch', async () => {
    pushAvailData = makeAvail({ state: 'ahead' })
    pushMutateAsync = vi.fn()
    getQueryData.mockReturnValue(makeAvail({ state: 'behind' }))
    renderModal()
    const pushBtn = screen.getByText('git.pushNow').closest('button') as HTMLButtonElement
    fireEvent.click(pushBtn)
    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled())
    await waitFor(() => expect(pushMutateAsync).not.toHaveBeenCalled())
  })

  it('shows success and closes on pushed', async () => {
    pushAvailData = makeAvail({ state: 'ahead' })
    pushMutateAsync = vi.fn().mockResolvedValue(makePushResult({ pushStatus: 'pushed' }))
    getQueryData.mockReturnValue(makeAvail({ state: 'ahead' }))
    const { onSuccess, onClose } = renderModal()
    fireEvent.click(screen.getByText('git.pushNow'))
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    expect(onSuccess.mock.calls[0][0]).toContain('git.pushSuccess')
    expect(onClose).toHaveBeenCalled()
  })

  it('shows failed with raw error and does not report as commit failure', async () => {
    pushAvailData = makeAvail({ state: 'ahead' })
    pushMutateAsync = vi.fn().mockResolvedValue(makePushResult({ pushStatus: 'failed', pushError: 'non-fast-forward' }))
    getQueryData.mockReturnValue(makeAvail({ state: 'ahead' }))
    const { onError, onClose } = renderModal()
    fireEvent.click(screen.getByText('git.pushNow'))
    await waitFor(() => expect(onError).toHaveBeenCalled())
    const msg = onError.mock.calls[0][0]
    expect(msg).toContain('git.pushFailed')
    expect(msg).toContain('non-fast-forward')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('switching remote clears push result and triggers new fetch', () => {
    pushAvailData = makeAvail({ state: 'ahead', remote: 'origin' })
    renderModal({
      gitStatus: makeGitStatus({
        remotes: [
          { name: 'origin', url: 'u1' },
          { name: 'backup', url: 'u2' },
        ],
      }),
    })
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'backup' } })
    const lastCall = vi.mocked(useGitPushAvailability).mock.calls.at(-1)
    expect(lastCall?.[1]).toBe('backup')
  })

  it('closes on Escape', () => {
    pushAvailData = makeAvail()
    const { onClose } = renderModal()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on cancel button', () => {
    pushAvailData = makeAvail()
    const { onClose } = renderModal()
    fireEvent.click(screen.getByText(/common\.cancel/))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders pending commits oldest-first under the target ref when ahead', () => {
    pushAvailData = makeAvail({
      ahead: 2,
      pendingCommits: [
        { hash: 'e4e8330', subject: 'fix: prevent editor bottom scroll jitter' },
        { hash: '972b677', subject: "Merge branch 'codex/editor-bottom-scroll-fix'" }
      ]
    })
    renderModal()
    // 领先数量文案与可推送保持
    expect(screen.getByText(/git\.pushAhead/).textContent).toContain('2')
    const pushBtn = screen.getByText('git.pushNow').closest('button') as HTMLButtonElement
    expect(pushBtn.disabled).toBe(false)

    // 目标引用之后, 按 DOM 顺序出现两个短 SHA 与完整标题
    const list = document.querySelector('ul[data-buddy-pending-commits]')
    expect(list).not.toBeNull()
    const items = within(list as HTMLElement).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('e4e8330')
    expect(items[0]).toHaveTextContent('fix: prevent editor bottom scroll jitter')
    expect(items[1]).toHaveTextContent('972b677')
    expect(items[1]).toHaveTextContent("Merge branch 'codex/editor-bottom-scroll-fix'")

    // 长标题不以省略号截断
    expect(items[0].textContent).not.toContain('…')
  })

  it('wraps long commit subjects instead of truncating', () => {
    const longSubject = 'feat: a very long commit subject that should wrap onto multiple lines rather than being truncated with an ellipsis'
    pushAvailData = makeAvail({
      ahead: 1,
      pendingCommits: [{ hash: 'abc1234', subject: longSubject }]
    })
    renderModal()
    const list = document.querySelector('ul[data-buddy-pending-commits]')
    const item = within(list as HTMLElement).getByRole('listitem')
    expect(item).toHaveTextContent(longSubject)
    // 不使用 truncate / ellipsis
    expect(item.className).not.toMatch(/truncate/)
    expect(item.textContent).not.toContain('…')
  })

  for (const state of ['new_branch', 'up_to_date', 'behind', 'diverged', 'unavailable'] as const) {
    it('does not render pending commit list when state is ' + state, () => {
      pushAvailData = makeAvail({ state, pendingCommits: [] })
      renderModal()
      expect(document.querySelector('ul[data-buddy-pending-commits]')).toBeNull()
    })
  }

  it('does not render pending commit list on fetch error', () => {
    pushAvailData = undefined
    pushAvailError = true
    renderModal()
    expect(document.querySelector('ul[data-buddy-pending-commits]')).toBeNull()
  })

  it('clears the previous remote pending commits after switching to a remote with none', () => {
    // 先以 origin ahead + 提交渲染
    pushAvailData = makeAvail({
      remote: 'origin',
      ahead: 1,
      pendingCommits: [{ hash: 'e4e8330', subject: 'fix: prevent editor bottom scroll jitter' }]
    })
    renderModal({
      gitStatus: makeGitStatus({
        remotes: [
          { name: 'origin', url: 'u1' },
          { name: 'backup', url: 'u2' },
        ],
      }),
    })
    expect(document.querySelector('ul[data-buddy-pending-commits]')).not.toBeNull()

    // 切到 backup 后, hook 返回 up_to_date 且无提交: 旧 origin 提交文本不残留
    pushAvailData = makeAvail({ remote: 'backup', state: 'up_to_date', ahead: 0, pendingCommits: [] })
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'backup' } })
    renderModal({
      gitStatus: makeGitStatus({
        remotes: [
          { name: 'origin', url: 'u1' },
          { name: 'backup', url: 'u2' },
        ],
      }),
    })
    expect(document.querySelector('ul[data-buddy-pending-commits]')).toBeNull()
    expect(screen.queryByText('e4e8330')).toBeNull()
    expect(screen.queryByText('fix: prevent editor bottom scroll jitter')).toBeNull()
  })
})
