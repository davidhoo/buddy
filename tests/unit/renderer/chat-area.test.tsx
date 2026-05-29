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
      flow_policy: 'claude_then_codex',
      role_mode: 'claude_implements',
      implementer_actor: 'claude',
      reviewer_actor: 'codex',
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

function runningTask(): TaskDetail {
  const task = readyTask(1)
  return {
    ...task,
    state: {
      ...task.state,
      status: 'RUNNING_CLAUDE',
      active_run: {
        actor: 'claude',
        started_at: '2026-05-26T07:06:50.471Z'
      }
    }
  }
}

describe('ChatArea ready task controls', () => {
  it('shows the task brief before the running status for a new running task', () => {
    const html = renderToStaticMarkup(
      <ChatArea
        task={runningTask()}
        onSendMessage={() => {}}
        onStartTask={() => {}}
        onInterrupt={() => {}}
        draft=""
        onDraftChange={() => {}}
        attachments={[]}
        onAttachmentsChange={() => {}}
      />
    )

    expect(html).toContain('Make the user message card wider.')
    expect(html.indexOf('Make the user message card wider.')).toBeLessThan(html.indexOf('running-status'))
  })

  it('keeps the task brief visible at the top once a transcript exists', () => {
    const base = readyTask(2)
    const taskWithTranscript: TaskDetail = {
      ...base,
      transcript: [
        {
          role: 'human',
          content: 'first round message',
          ts: '2026-05-26T07:06:50.471Z',
          meta: {}
        }
      ]
    }
    const html = renderToStaticMarkup(
      <ChatArea
        task={taskWithTranscript}
        onSendMessage={() => {}}
        onStartTask={() => {}}
        onInterrupt={() => {}}
        draft=""
        onDraftChange={() => {}}
        attachments={[]}
        onAttachmentsChange={() => {}}
      />
    )

    expect(html).toContain('Make the user message card wider.')
    expect(html).toContain('task-brief-card')
    expect(html.indexOf('Make the user message card wider.')).toBeLessThan(html.indexOf('first round message'))
    const transcriptContainerIdx = html.indexOf('overflow-y-auto px-6 py-4')
    expect(transcriptContainerIdx).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('task-brief-card')).toBeGreaterThan(transcriptContainerIdx)
  })

  it('shows the start control for a newly-created READY task at round 1', () => {
    const html = renderToStaticMarkup(
      <ChatArea
        task={readyTask(1)}
        onSendMessage={() => {}}
        onStartTask={() => {}}
        onInterrupt={() => {}}
        draft=""
        onDraftChange={() => {}}
        attachments={[]}
        onAttachmentsChange={() => {}}
      />
    )

    expect(html).toContain('title="Start"')
  })
})
