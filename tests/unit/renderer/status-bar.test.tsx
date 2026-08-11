// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { StatusBar } from '../../../src/renderer/components/StatusBar'
import type { Event, TaskSettings, TaskState } from '../../../src/shared/types'
import { eventTypeLabel } from '../../../src/renderer/lib/format'
import type { Language } from '../../../src/renderer/lib/i18n'

vi.mock('../../../src/renderer/hooks/useBuddy', () => ({
  useGitStatus: () => ({ data: null, isLoading: false })
}))

type StatusBarProps = Parameters<typeof StatusBar>[0]

const taskSettings: TaskSettings = {
  protocol_version: '1',
  countdown_seconds: 10,
  flow_policy: 'claude_then_codex',
  role_mode: 'claude_implements',
  implementer_actor: 'claude',
  reviewer_actor: 'codex',
  max_rounds: 10,
  launchers: {
    claude: { command: 'claude', env: {}, timeout_seconds: 7200 },
    codex: { command: 'codex', env: {}, timeout_seconds: 7200 }
  }
}

function runningTaskState(status: TaskState['status'] = 'RUNNING_CODEX'): TaskState {
  return {
    status,
    round: 1,
    next_actor: 'claude',
    active_run: {
      actor: 'codex',
      started_at: '2026-05-26T07:06:50.471Z'
    },
    updated_at: '2026-05-26T07:06:50.471Z',
    repo_root: '/tmp/repo',
    pending_break: null
  }
}

function makeEvent(seq: number, type: string, payload: Record<string, unknown> = {}): Event {
  return {
    seq,
    ts: '2026-05-26T07:06:50.471Z',
    task_id: 'demo',
    type,
    payload
  } as Event
}

function renderStatusBar(overrides: Partial<StatusBarProps> = {}) {
  const props: StatusBarProps = {
    isOpen: true,
    width: 280,
    taskState: runningTaskState(),
    taskSettings,
    events: [],
    latestFailure: null,
    onInterrupt: () => {},
    onRetry: () => {},
    onRetryHealthCheck: () => {},
    isRetryingHealthCheck: false,
    onResume: () => {},
    onResize: () => {},
    ...overrides
  }

  return renderToStaticMarkup(<StatusBar {...props} />)
}

function makeTaskState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...runningTaskState(),
    task_id: 'demo',
    ...overrides
  }
}

function renderStatusBarInteractive(overrides: Partial<StatusBarProps> = {}) {
  const props: StatusBarProps = {
    isOpen: true,
    width: 280,
    taskState: makeTaskState(),
    taskSettings,
    events: [],
    latestFailure: null,
    onInterrupt: () => {},
    onRetry: () => {},
    onRetryHealthCheck: () => {},
    isRetryingHealthCheck: false,
    onResume: () => {},
    onResize: () => {},
    ...overrides
  }

  return render(<StatusBar {...props} />)
}

describe('StatusBar session ID copy feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    vi.restoreAllMocks()
  })

  function mockClipboardResolved() {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    return writeText
  }

  function mockClipboardRejected() {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    return writeText
  }

  // 渲染整棵 StatusBar，用于任务切换的 rerender 场景。
  function statusBarProps(overrides: Partial<StatusBarProps> = {}): StatusBarProps {
    return {
      isOpen: true,
      width: 280,
      taskState: makeTaskState(),
      taskSettings,
      events: [],
      latestFailure: null,
      onInterrupt: () => {},
      onRetry: () => {},
      onRetryHealthCheck: () => {},
      isRetryingHealthCheck: false,
      onResume: () => {},
      onResize: () => {},
      ...overrides
    }
  }

  it('shows copy icon initially when session ID exists', () => {
    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-123' })
    })

    const copyBtn = screen.getByTitle('Copy session ID')
    expect(copyBtn).toBeInTheDocument()
    expect(copyBtn.querySelector('.lucide-copy')).toBeInTheDocument()
    expect(copyBtn.querySelector('.lucide-check')).not.toBeInTheDocument()
  })

  it('does not show copy button when there is no session ID', () => {
    renderStatusBarInteractive()

    expect(screen.queryByTitle('Copy session ID')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('writes the full session ID to clipboard on click', async () => {
    const writeText = mockClipboardResolved()

    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'full-session-id-abc' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)

    expect(writeText).toHaveBeenCalledWith('full-session-id-abc')
  })

  it('switches to check icon after successful copy', async () => {
    mockClipboardResolved()

    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-1' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)

    const checkBtn = screen.getByTitle('Session ID copied')
    expect(checkBtn).toBeInTheDocument()
    expect(checkBtn.querySelector('.lucide-check')).toBeInTheDocument()
    expect(checkBtn.querySelector('.lucide-copy')).not.toBeInTheDocument()
  })

  it('keeps check icon before 5 seconds elapse', async () => {
    mockClipboardResolved()

    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-1' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4999)

    expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()
  })

  it('restores copy icon after 5 seconds', async () => {
    mockClipboardResolved()

    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-1' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)

    const copyBtn = screen.getByTitle('Copy session ID')
    expect(copyBtn).toBeInTheDocument()
    expect(copyBtn.querySelector('.lucide-copy')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('restarts the 5 second timer when copied again while check is shown', async () => {
    mockClipboardResolved()

    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-1' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0) // 对号显示，第一个 5s 定时器开始

    // 推进 4s，对号仍在
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()

    // 对号状态下再次点击，重新开始完整的 5s 计时
    fireEvent.click(screen.getByTitle('Session ID copied'))
    await vi.advanceTimersByTimeAsync(0)

    // 距第二次点击 4s，对号仍在
    await vi.advanceTimersByTimeAsync(4000)
    expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()

    // 再过 1s（距第二次点击满 5s），恢复复制图标
    await vi.advanceTimersByTimeAsync(1000)
    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('keeps copy icon when clipboard write fails', async () => {
    mockClipboardRejected()

    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-fail' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)

    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('keeps implementer and reviewer copy states independent', async () => {
    mockClipboardResolved()

    renderStatusBarInteractive({
      taskState: makeTaskState({
        claude_session_id: 'claude-sess',
        codex_thread_id: 'codex-sess'
      })
    })

    const buttons = screen.getAllByTitle('Copy session ID')
    // 点击审查者（codex，第二个）按钮
    fireEvent.click(buttons[1])
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getAllByTitle('Session ID copied')).toHaveLength(1)
    // 执行者仍显示复制图标
    const remainingCopyBtn = screen.getByTitle('Copy session ID')
    expect(remainingCopyBtn).toBeInTheDocument()
    expect(remainingCopyBtn.querySelector('.lucide-copy')).toBeInTheDocument()
  })

  it('does not carry copied state when switching to a different task', async () => {
    mockClipboardResolved()

    const { rerender } = renderStatusBarInteractive({
      taskState: makeTaskState({ task_id: 'task-a', claude_session_id: 'sess-a' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()

    // 切换到任务 B
    rerender(
      <StatusBar
        {...statusBarProps({
          taskState: makeTaskState({ task_id: 'task-b', claude_session_id: 'sess-b' })
        })}
      />
    )

    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('restores copy icon when switching back to the original task within 5 seconds', async () => {
    mockClipboardResolved()

    const { rerender } = renderStatusBarInteractive({
      taskState: makeTaskState({ task_id: 'task-a', claude_session_id: 'sess-a' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()

    // 切到任务 B
    rerender(
      <StatusBar
        {...statusBarProps({
          taskState: makeTaskState({ task_id: 'task-b', claude_session_id: 'sess-b' })
        })}
      />
    )

    // 5s 内切回任务 A，必须显示复制图标
    rerender(
      <StatusBar
        {...statusBarProps({
          taskState: makeTaskState({ task_id: 'task-a', claude_session_id: 'sess-a' })
        })}
      />
    )

    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('cleans up the timer on unmount without later state updates', async () => {
    mockClipboardResolved()

    // 在挂载后开始 spy，避免捕获 StatusBar 1s tick 等无关定时器
    const { setTimeout: realSetTimeout } = globalThis
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    const { unmount } = renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-1' })
    })

    setTimeoutSpy.mockClear()
    clearTimeoutSpy.mockClear()

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)

    // 复制成功后应已调度 5s 定时器；它应是目前唯一被调度的 setTimeout
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    const timerId = setTimeoutSpy.mock.results[0].value

    // 静默恢复 realSetTimeout，避免 advanceTimers 内部依赖被 spy 影响
    setTimeoutSpy.mockImplementation(realSetTimeout as never)

    unmount()

    // 卸载时应清理该定时器，避免卸载后状态更新
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId)

    // 卸载后推进时间不应抛错或产生状态更新
    await vi.advanceTimersByTimeAsync(6000)
  })

  it('does not mark copied when task changes but session ID is the same (race condition)', async () => {
    let resolveCopy: () => void = () => {}
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve }))
    Object.assign(navigator, { clipboard: { writeText } })

    const { rerender } = renderStatusBarInteractive({
      taskState: makeTaskState({ task_id: 'task-1', claude_session_id: 'same-sess' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))

    // 在 Promise 解析前切到另一个任务（同一会话 ID）
    rerender(
      <StatusBar
        {...statusBarProps({
          taskState: makeTaskState({ task_id: 'task-2', claude_session_id: 'same-sess' })
        })}
      />
    )

    // 现在让 task-1 的陈旧 Promise 解析
    resolveCopy()
    await vi.advanceTimersByTimeAsync(0)

    expect(writeText).toHaveBeenCalledWith('same-sess')
    // task-2 不得因相同会话字符串而显示对号
    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('restores copy icon when status bar is reopened', async () => {
    mockClipboardResolved()

    const { rerender } = renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-reopen' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))
    await vi.advanceTimersByTimeAsync(0)
    expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()

    // 关闭再重新打开
    rerender(<StatusBar {...statusBarProps({ isOpen: false, taskState: makeTaskState({ claude_session_id: 'sess-reopen' }) })} />)
    rerender(<StatusBar {...statusBarProps({ isOpen: true, taskState: makeTaskState({ claude_session_id: 'sess-reopen' }) })} />)

    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })
})

describe('StatusBar inline run status', () => {
  it('places the compact status in the run status header and keeps it right aligned', () => {
    const html = renderStatusBar()

    expect(html).toContain('class="flex items-center justify-between gap-3 mb-2"')
    expect(html).toContain('class="text-sm font-semibold min-w-0"')
    expect(html).toContain('class="h-5 flex flex-shrink-0 items-center gap-1.5"')
    expect(html).toContain('lucide-loader-circle')
    expect(html).toContain('animate-spin')
    expect(html).toContain('status-text-running')
    expect(html).not.toContain('Codex running')
    expect(html).not.toContain('Codex 运行中')
  })

  it('keeps failed details below the header while the retry action stays inline', () => {
    const html = renderStatusBar({
      taskState: runningTaskState('FAILED'),
      latestFailure: {
        actor: 'codex',
        ts: '2026-05-26T07:06:50.471Z',
        message: 'Command failed'
      }
    })

    expect(html).toContain('status-dot-danger')
    expect(html).toContain('lucide-rotate-cw')
    expect(html).toContain('Command failed')
  })

  it('renders the full session id while preserving right-side overflow clipping', () => {
    const longSessionId = 'claude-session-id-that-should-render-in-full-without-shortening'
    const html = renderStatusBar({
      taskState: {
        ...runningTaskState(),
        claude_session_id: longSessionId
      }
    })

    expect(html).toContain(longSessionId)
    expect(html).not.toContain('claude-s...tening')
    expect(html).toContain('class="min-w-0 truncate"')
  })
})

describe('StatusBar event log queue event filtering', () => {
  // The event log only renders the last 10 events unless expanded, so feed a single event of
  // each type to assert presence/absence deterministically.
  const lang: Language = 'en'

  it('hides historical queue.reconciled events but still shows queue.blocked', () => {
    const html = renderStatusBar({
      events: [
        makeEvent(1, 'queue.reconciled', { outcome: 'idle', waiting_count: 0 }),
        makeEvent(2, 'queue.blocked', { reason: 'active_queued_task', blocked_task_id: 'a' }),
        makeEvent(3, 'queue.activated', { activation_source: 'automatic' })
      ]
    })

    // queue.reconciled must not surface in the UI.
    expect(html).not.toContain(eventTypeLabel('queue.reconciled', lang))
    // queue.blocked and queue.activated are meaningful and must still render.
    expect(html).toContain(eventTypeLabel('queue.blocked', lang))
    expect(html).toContain(eventTypeLabel('queue.activated', lang))
  })

  it('still shows other lifecycle events when queue.reconciled is present', () => {
    const html = renderStatusBar({
      events: [
        makeEvent(1, 'queue.reconciled', { outcome: 'blocked' }),
        makeEvent(2, 'actor.started', {}),
        makeEvent(3, 'task.done', {})
      ]
    })

    expect(html).not.toContain(eventTypeLabel('queue.reconciled', lang))
    expect(html).toContain(eventTypeLabel('actor.started', lang))
    expect(html).toContain(eventTypeLabel('task.done', lang))
  })

  it('renders the empty state when only hidden events remain', () => {
    const html = renderStatusBar({
      events: [makeEvent(1, 'queue.reconciled', { outcome: 'idle' })]
    })

    expect(html).not.toContain(eventTypeLabel('queue.reconciled', lang))
    // With only hidden events, the EventLog renders its empty-state message.
    expect(html).toContain('No events.')
  })
})
