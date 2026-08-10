// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

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

  it('writes the full session ID to clipboard on click', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'full-session-id-abc' })
    })

    const copyBtn = screen.getByTitle('Copy session ID')
    fireEvent.click(copyBtn)

    expect(writeText).toHaveBeenCalledWith('full-session-id-abc')
  })

  it('switches to check icon only for the clicked actor after successful copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    renderStatusBarInteractive({
      taskState: makeTaskState({
        claude_session_id: 'claude-sess',
        codex_thread_id: 'codex-sess'
      })
    })

    const buttons = screen.getAllByTitle('Copy session ID')
    // Click the first copy button (Claude/implementer)
    fireEvent.click(buttons[0])

    await waitFor(() => {
      expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()
    })

    // The other actor's button should still show copy icon
    const remainingCopyBtn = screen.getByTitle('Copy session ID')
    expect(remainingCopyBtn.querySelector('.lucide-copy')).toBeInTheDocument()
  })

  it('keeps copy icon when clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })

    renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-fail' })
    })

    const copyBtn = screen.getByTitle('Copy session ID')
    fireEvent.click(copyBtn)

    // Wait for the rejected promise to settle
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('sess-fail')
    })

    // Should still show copy icon, not check
    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('keeps implementer and reviewer copy states independent', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    renderStatusBarInteractive({
      taskState: makeTaskState({
        claude_session_id: 'claude-sess',
        codex_thread_id: 'codex-sess'
      })
    })

    const buttons = screen.getAllByTitle('Copy session ID')
    // Click codex (reviewer) button - it's the second one
    fireEvent.click(buttons[1])

    await waitFor(() => {
      expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()
    })

    // Claude (implementer) button should still show copy icon
    const remainingCopyBtn = screen.getByTitle('Copy session ID')
    expect(remainingCopyBtn).toBeInTheDocument()
    expect(screen.getAllByTitle('Session ID copied')).toHaveLength(1)
  })

  it('restores copy icon when session ID changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    const { rerender } = renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-original' })
    })

    const copyBtn = screen.getByTitle('Copy session ID')
    fireEvent.click(copyBtn)

    await waitFor(() => {
      expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()
    })

    // Rerender with a different session ID
    rerender(
      <StatusBar
        isOpen={true}
        width={280}
        taskState={makeTaskState({ claude_session_id: 'sess-new' })}
        taskSettings={taskSettings}
        events={[]}
        latestFailure={null}
        onInterrupt={() => {}}
        onRetry={() => {}}
        onRetryHealthCheck={() => {}}
        isRetryingHealthCheck={false}
        onResume={() => {}}
        onResize={() => {}}
      />
    )

    // Should reset back to copy icon
    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('restores copy icon when task ID changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    const { rerender } = renderStatusBarInteractive({
      taskState: makeTaskState({ task_id: 'task-1', claude_session_id: 'sess-a' })
    })

    const copyBtn = screen.getByTitle('Copy session ID')
    fireEvent.click(copyBtn)

    await waitFor(() => {
      expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()
    })

    // Rerender with a different task ID but same session
    rerender(
      <StatusBar
        isOpen={true}
        width={280}
        taskState={makeTaskState({ task_id: 'task-2', claude_session_id: 'sess-a' })}
        taskSettings={taskSettings}
        events={[]}
        latestFailure={null}
        onInterrupt={() => {}}
        onRetry={() => {}}
        onRetryHealthCheck={() => {}}
        isRetryingHealthCheck={false}
        onResume={() => {}}
        onResize={() => {}}
      />
    )

    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('restores copy icon when status bar is reopened', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    const { rerender } = renderStatusBarInteractive({
      taskState: makeTaskState({ claude_session_id: 'sess-reopen' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))

    await waitFor(() => {
      expect(screen.getByTitle('Session ID copied')).toBeInTheDocument()
    })

    // Close and reopen the status bar
    rerender(
      <StatusBar
        isOpen={false}
        width={280}
        taskState={makeTaskState({ claude_session_id: 'sess-reopen' })}
        taskSettings={taskSettings}
        events={[]}
        latestFailure={null}
        onInterrupt={() => {}}
        onRetry={() => {}}
        onRetryHealthCheck={() => {}}
        isRetryingHealthCheck={false}
        onResume={() => {}}
        onResize={() => {}}
      />
    )

    // Reopen
    rerender(
      <StatusBar
        isOpen={true}
        width={280}
        taskState={makeTaskState({ claude_session_id: 'sess-reopen' })}
        taskSettings={taskSettings}
        events={[]}
        latestFailure={null}
        onInterrupt={() => {}}
        onRetry={() => {}}
        onRetryHealthCheck={() => {}}
        isRetryingHealthCheck={false}
        onResume={() => {}}
        onResize={() => {}}
      />
    )

    expect(screen.getByTitle('Copy session ID')).toBeInTheDocument()
    expect(screen.queryByTitle('Session ID copied')).not.toBeInTheDocument()
  })

  it('does not mark copied when task changes but session ID is the same (race condition)', async () => {
    let resolveCopy: () => void = () => {}
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve }))
    Object.assign(navigator, { clipboard: { writeText } })

    const { rerender } = renderStatusBarInteractive({
      taskState: makeTaskState({ task_id: 'task-1', claude_session_id: 'same-sess' })
    })

    fireEvent.click(screen.getByTitle('Copy session ID'))

    // Switch to a different task with the same session ID before Promise resolves
    rerender(
      <StatusBar
        isOpen={true}
        width={280}
        taskState={makeTaskState({ task_id: 'task-2', claude_session_id: 'same-sess' })}
        taskSettings={taskSettings}
        events={[]}
        latestFailure={null}
        onInterrupt={() => {}}
        onRetry={() => {}}
        onRetryHealthCheck={() => {}}
        isRetryingHealthCheck={false}
        onResume={() => {}}
        onResize={() => {}}
      />
    )

    // Now resolve the stale Promise from task-1
    resolveCopy()

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('same-sess')
    })

    // task-2 must NOT show check icon despite same session string
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
