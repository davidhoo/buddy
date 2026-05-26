import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatArea } from '../../../src/renderer/components/ChatArea'
import type { TaskDetail } from '../../../src/shared/types'

function readyTask(round: number): TaskDetail {
  return {
    task_id: 'demo',
    workspace_key: '31bd2c697ab4',
    state: {
      status: 'READY',
      round,
      next_actor: 'claude',
      active_run: null,
      updated_at: '2026-05-26T07:06:50.471Z',
      repo_root: '/tmp/repo',
      pending_break: null
    },
    settings: {
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
    },
    task_text: 'Make the user message card wider.',
    context_text: '',
    transcript: [],
    events: [],
    latest_failure: null
  }
}

describe('ChatArea ready task controls', () => {
  it('does not render task text as a chat transcript entry', () => {
    const html = renderToStaticMarkup(
      <ChatArea
        task={readyTask(1)}
        onSendMessage={() => {}}
        onStartTask={() => {}}
        onInterrupt={() => {}}
        autoStartSeconds={0}
        draft=""
        onDraftChange={() => {}}
      />
    )

    expect(html).not.toContain('Make the user message card wider.')
  })

  it('shows the start control for a newly-created READY task at round 1', () => {
    const html = renderToStaticMarkup(
      <ChatArea
        task={readyTask(1)}
        onSendMessage={() => {}}
        onStartTask={() => {}}
        onInterrupt={() => {}}
        autoStartSeconds={0}
        draft=""
        onDraftChange={() => {}}
      />
    )

    expect(html).toContain('title="Start"')
  })

  it('shows the auto-start countdown for a newly-created READY task at round 1', () => {
    const html = renderToStaticMarkup(
      <ChatArea
        task={readyTask(1)}
        onSendMessage={() => {}}
        onStartTask={() => {}}
        onInterrupt={() => {}}
        autoStartSeconds={5}
        draft=""
        onDraftChange={() => {}}
      />
    )

    expect(html).toContain('Auto-starting in 5s')
  })
})
