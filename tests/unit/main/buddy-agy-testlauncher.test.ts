import { describe, expect, it } from 'vitest'
import { BuddyCoreService } from '../../../src/main/buddy/service'
import { buildLauncherCommand, commandKindFor } from '../../../src/main/buddy/launchers'

describe('agy settings testLauncher regression', () => {
  it('commandKindFor(agy) never falls to contract for default command', () => {
    expect(commandKindFor('agy', 'agy')).toBe('native_agy')
    expect(commandKindFor('agy', '')).toBe('native_agy')
    const cmd = buildLauncherCommand({
      actor: 'agy',
      command: 'agy',
      promptFile: '/tmp/p.md',
      promptText: 'hi',
      timeoutSeconds: 120
    })
    expect(cmd.args).not.toContain('--actor')
    expect(cmd.args).toContain('--print-timeout=120s')
  })

  it('testLauncher ping path does not pass --actor to agy', async () => {
    const service = new BuddyCoreService({ dataRoot: '/tmp/buddy-agy-testlauncher-root' })
    const result = await service.testLauncher('agy', 'agy')
    // Surface the real error for debugging if this fails in CI without agy
    if (!result.success) {
      // If agy is missing entirely, tool_check fails — that is environment, not --actor
      expect(result.error ?? '', JSON.stringify(result)).not.toMatch(/flags provided but not defined/i)
      expect(result.error ?? '').not.toMatch(/-actor/)
    } else {
      expect(result.success).toBe(true)
    }
  }, 180_000)
})
