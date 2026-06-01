import { describe, expect, it } from 'vitest'
import { exitErrorMessage } from '../../../src/main/buddy/runner'

describe('exitErrorMessage', () => {
  it('reports signal kill when exitCode is null and signal is present', () => {
    expect(exitErrorMessage(null, 'SIGTERM')).toBe('Actor was killed by signal SIGTERM (possible timeout)')
  })

  it('reports unexpected exit when exitCode is null and signal is null', () => {
    expect(exitErrorMessage(null, null)).toBe('Actor exited unexpectedly (no exit code)')
  })

  it('reports exit code when exitCode is a number', () => {
    expect(exitErrorMessage(1, null)).toBe('Actor exited with code 1')
  })

  it('reports exit code even when signal is also present (should not happen, but defensive)', () => {
    expect(exitErrorMessage(0, null)).toBe('Actor exited with code 0')
  })

  it('reports SIGKILL signal', () => {
    expect(exitErrorMessage(null, 'SIGKILL')).toBe('Actor was killed by signal SIGKILL (possible timeout)')
  })
})
