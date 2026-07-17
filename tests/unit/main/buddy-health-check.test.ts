import { describe, expect, it } from 'vitest'
import { needsHealthCheck } from '../../../src/main/buddy/runner'
import type { TaskState, TaskSettings } from '../../../src/shared/types'

function baseState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    status: 'READY',
    round: 0,
    next_actor: 'claude',
    ...overrides
  } as TaskState
}

function baseSettings(overrides: Partial<TaskSettings> = {}): TaskSettings {
  return {
    protocol_version: '1',
    flow_policy: 'alternating',
    role_mode: 'claude_implements',
    launchers: {},
    ...overrides
  } as TaskSettings
}

describe('needsHealthCheck', () => {
  it('requires a health check on a fresh task with no sessions', () => {
    expect(needsHealthCheck(baseState(), baseSettings())).toBe(true)
  })

  it('does not re-run a health check after a successful one (no failed_actor)', () => {
    const state = baseState({
      health_check: { actors: { claude: 'passed', codex: 'passed' } }
    })
    expect(needsHealthCheck(state, baseSettings())).toBe(false)
  })

  it('allows re-running the health check after a failed one (with failed_actor)', () => {
    const state = baseState({
      status: 'FAILED',
      health_check: {
        actors: { claude: 'passed', codex: 'failed' },
        failed_actor: 'codex',
        failed_reason: 'CLI not found'
      }
    })
    expect(needsHealthCheck(state, baseSettings())).toBe(true)
  })

  it('retries a partial health-check failure even when one actor has a session', () => {
    const state = baseState({
      claude_session_id: 'passed-session',
      health_check: {
        actors: { claude: 'passed', codex: 'failed' },
        failed_actor: 'codex',
        failed_reason: 'not authenticated'
      }
    })
    expect(needsHealthCheck(state, baseSettings())).toBe(true)
  })

  it('does not trigger a health check once the task has progressed past round 0', () => {
    const state = baseState({ round: 1 })
    expect(needsHealthCheck(state, baseSettings())).toBe(false)
  })

  it('skips the health check when a seed session is already configured', () => {
    const state = baseState({ claude_session_id: 'seed-123' })
    expect(needsHealthCheck(state, baseSettings())).toBe(false)
  })

  it('uses profile-keyed Cursor sessions when deciding whether to ping', () => {
    const settings = baseSettings({
      implementer_actor: 'cursor-agent',
      reviewer_actor: 'cursor-agent-2',
      seed_agent_sessions: { 'cursor-agent': 'cursor-seed' }
    })
    expect(needsHealthCheck(baseState({ next_actor: 'cursor-agent' }), settings)).toBe(false)
  })
})
