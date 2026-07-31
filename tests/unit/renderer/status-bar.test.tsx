import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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
    onSkipCountdown: () => {},
    onPauseCountdown: () => {},
    onInterrupt: () => {},
    onRetry: () => {},
    onResume: () => {},
    onResize: () => {},
    ...overrides
  }

  return renderToStaticMarkup(<StatusBar {...props} />)
}

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
