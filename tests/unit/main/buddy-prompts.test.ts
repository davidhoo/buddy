import { describe, expect, it } from 'vitest'
import { buildActorPrompt } from '../../../src/main/buddy/prompts'

describe('buildActorPrompt', () => {
  it('includes task, context, actor, round, and repo root', () => {
    const prompt = buildActorPrompt({
      actor: 'claude',
      round: 1,
      repoRoot: '/tmp/repo',
      taskText: 'Build feature',
      contextText: 'Use tests',
      transcript: []
    })

    expect(prompt).toContain('claude')
    expect(prompt).toContain('/tmp/repo')
    expect(prompt).toContain('Build feature')
    expect(prompt).toContain('Use tests')
  })

  it('matches buddy-python prompt sections and runtime settings', () => {
    const prompt = buildActorPrompt({
      actor: 'claude',
      round: 4,
      repoRoot: '/tmp/repo',
      taskText: '# Demo',
      contextText: 'Use tests',
      transcript: [],
      settings: {
        role_mode: 'claude_implements',
        flow_policy: 'claude_then_codex',
        launchers: {}
      },
      globalSettings: {
        max_rounds: 10
      },
      state: {
        round: 4,
        rounds_in_window: 3,
        context_hash: 'old',
        context_sent: { claude: false, codex: false }
      }
    } as any)

    expect(prompt).toContain('# buddy actor turn')
    expect(prompt).toContain('## Buddy Message Protocol')
    expect(prompt).toContain('## Background context')
    expect(prompt).toContain('## Runtime settings')
    expect(prompt).toContain('Automatic rounds used in this window: 3/10')
    expect(prompt).toContain('Automatic rounds remaining in this window: 7')
    expect(prompt).toContain('Next actor after this turn: codex')
    expect(prompt).toContain('Continue the implementation work')
  })

  it('uses reviewer instructions when actor is not the configured implementer', () => {
    const prompt = buildActorPrompt({
      actor: 'claude',
      round: 1,
      repoRoot: '/tmp/repo',
      taskText: 'Build feature',
      contextText: '',
      transcript: [],
      settings: {
        role_mode: 'codex_implements',
        flow_policy: 'claude_then_codex',
        launchers: {}
      },
      state: { round: 0, rounds_in_window: 0 }
    } as any)

    expect(prompt).toContain('Review the current task state')
    expect(prompt).not.toContain('Continue the implementation work')
  })

  it('asks the second actor to confirm or reject pending break', () => {
    const prompt = buildActorPrompt({
      actor: 'codex',
      round: 2,
      repoRoot: '/tmp/repo',
      taskText: 'Build feature',
      contextText: '',
      transcript: [],
      settings: {
        role_mode: 'claude_implements',
        flow_policy: 'claude_then_codex',
        launchers: {}
      },
      state: {
        round: 1,
        rounds_in_window: 1,
        pending_break: { actor: 'claude', round: 1 }
      }
    } as any)

    expect(prompt).toContain('## Break confirmation required')
    expect(prompt).toContain('Claude Code has signaled `type=break`')
    expect(prompt).toContain('Confirm with `type=break` or continue with `type=chat`')
  })

  it('selects recent transcript while preserving missing actor and human rows', () => {
    const transcript = [
      { seq: 1, role: 'claude', content: 'claude earlier', ts: '' },
      { seq: 2, role: 'human', content: 'human earlier', ts: '' },
      ...Array.from({ length: 8 }, (_value, index) => ({
        seq: index + 3,
        role: 'codex' as const,
        content: `codex ${index + 3}`,
        ts: ''
      }))
    ]

    const prompt = buildActorPrompt({
      actor: 'codex',
      round: 10,
      repoRoot: '/tmp/repo',
      taskText: 'Build feature',
      contextText: '',
      transcript,
      settings: {
        role_mode: 'claude_implements',
        flow_policy: 'claude_then_codex',
        launchers: {}
      },
      state: { round: 9, rounds_in_window: 9 }
    } as any)

    expect(prompt).toContain('## Recent transcript')
    expect(prompt).toContain('claude earlier')
    expect(prompt).toContain('human earlier')
    expect(prompt).toContain('codex 10')
    expect(prompt).not.toContain('codex 3')
  })

  it('places the detected human language rule as the last instruction line', () => {
    const prompt = buildActorPrompt({
      actor: 'codex',
      round: 1,
      repoRoot: '/tmp/repo',
      taskText: 'Build feature',
      contextText: '',
      transcript: [],
      userMessage: '请修复这个问题',
      settings: {
        role_mode: 'claude_implements',
        flow_policy: 'claude_then_codex',
        launchers: {}
      },
      state: { round: 0, rounds_in_window: 0 }
    } as any)

    const lastLine = prompt.trim().split('\n').at(-1)
    expect(lastLine).toContain('中文')
    expect(lastLine).toContain('自然语言')
  })
})

describe('custom_prompt', () => {
  const baseSettings = {
    role_mode: 'claude_implements',
    flow_policy: 'claude_then_codex',
    launchers: {}
  }

  const build = (globalSettings?: Record<string, unknown>) =>
    buildActorPrompt({
      actor: 'claude',
      round: 1,
      repoRoot: '/tmp/repo',
      taskText: 'Build feature',
      contextText: '',
      transcript: [],
      settings: baseSettings,
      state: { round: 0, rounds_in_window: 0 },
      globalSettings
    } as any)

  it('does not add a custom instructions section when unset', () => {
    const prompt = build()
    expect(prompt).not.toContain('## Custom instructions')
  })

  it('appends the custom prompt as the final section after the system prompt', () => {
    const prompt = build({ custom_prompt: 'Always run pnpm test before reporting done.' })

    expect(prompt).toContain('## Custom instructions')
    expect(prompt).toContain('Always run pnpm test before reporting done.')

    // Custom instructions come after the built-in implementer instruction.
    const instructionIdx = prompt.indexOf('Continue the implementation work')
    const customIdx = prompt.indexOf('Always run pnpm test before reporting done.')
    expect(customIdx).toBeGreaterThan(instructionIdx)

    // And it is the last section of the assembled prompt.
    const lastLine = prompt.trim().split('\n').at(-1)
    expect(lastLine).toBe('Always run pnpm test before reporting done.')
  })

  it('treats whitespace-only custom_prompt as unset', () => {
    const prompt = build({ custom_prompt: '   ' })
    expect(prompt).not.toContain('## Custom instructions')
  })
})
