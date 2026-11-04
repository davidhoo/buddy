import { describe, expect, it } from 'vitest'
import { resolveCommitAgentLaunch, type LocalAgent } from '../../../src/shared/agents'

const cli = { command: '/current/gemini', env: {}, timeout_seconds: 20, model: 'current' }
const agent: LocalAgent = {
  id: 'gemini', name: 'Gemini', installationId: 'one', path: cli.command, realPath: cli.command,
  enabled: true, runnable: true, source: 'npm', selectedProtocol: 'cli', cli
}

describe('commit agent launch configuration', () => {
  it('uses discovered executables instead of a stale task launcher', () => {
    expect(resolveCommitAgentLaunch(agent, {}, { launchers: {
      gemini: { ...cli, command: '/removed/gemini', model: 'old' }
    } })).toEqual({ ...cli, protocol: 'cli' })
  })
  it('inherits a task model only for the same execution configuration', () => {
    expect(resolveCommitAgentLaunch(agent, {}, { launchers: {
      gemini: { ...cli, model: 'task-model' }
    } })?.model).toBe('task-model')
    expect(resolveCommitAgentLaunch(agent, {}, { launchers: {
      gemini: { ...cli, protocol: 'acp', model: 'task-model' }
    } })?.model).toBe('current')
  })
  it('rejects disabled, missing and unverified selected entries', () => {
    expect(resolveCommitAgentLaunch({ ...agent, enabled: false }, {})).toBeUndefined()
    expect(resolveCommitAgentLaunch({ ...agent, runnable: false }, {})).toBeUndefined()
    expect(resolveCommitAgentLaunch({ ...agent, selectedProtocol: 'acp', acp: cli }, {})).toBeUndefined()
    expect(resolveCommitAgentLaunch({ ...agent, selectedProtocol: 'acp', acp: cli, acpStatus: 'verified' }, {})?.protocol).toBe('acp')
  })
})
