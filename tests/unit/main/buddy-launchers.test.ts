import { describe, expect, it } from 'vitest'
import { buildLauncherCommand, commandKindFor } from '../../../src/main/buddy/launchers'

describe('launcher command builder', () => {
  it('builds Claude non-interactive stream-json command', () => {
    expect(buildLauncherCommand({
      actor: 'claude',
      command: 'claude --dangerously-skip-permissions',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello'
    })).toEqual({
      command: 'claude',
      args: [
        '--dangerously-skip-permissions',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--input-format',
        'text'
      ],
      kind: 'native_claude',
      stdinText: 'hello'
    })
  })

  it('builds Codex exec json command', () => {
    expect(buildLauncherCommand({
      actor: 'codex',
      command: 'codex',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello',
      outputFile: '/tmp/output.md',
      repoRoot: '/tmp/repo'
    })).toEqual({
      command: 'codex',
      args: [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
        '--skip-git-repo-check',
        '-C',
        '/tmp/repo',
        '-o',
        '/tmp/output.md',
        '-'
      ],
      kind: 'native_codex',
      stdinText: 'hello'
    })
  })

  it('builds Codex exec resume command after exec options', () => {
    expect(buildLauncherCommand({
      actor: 'codex',
      command: 'codex --profile native --full-auto',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello',
      outputFile: '/tmp/output.md',
      repoRoot: '/tmp/repo',
      sessionId: 'codex-thread'
    })).toEqual({
      command: 'codex',
      args: [
        '--profile',
        'native',
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
        '--skip-git-repo-check',
        '-C',
        '/tmp/repo',
        '-o',
        '/tmp/output.md',
        'resume',
        'codex-thread',
        '-'
      ],
      kind: 'native_codex',
      stdinText: 'hello'
    })
  })

  it('builds Cursor CLI stream-json command without partial text deltas', () => {
    expect(buildLauncherCommand({
      actor: 'cursor',
      command: 'cursor-agent --model gpt-5',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello from prompt',
      sessionId: 'cursor-chat'
    })).toEqual({
      command: 'cursor-agent',
      args: [
        '--model',
        'gpt-5',
        '--print',
        '--force',
        '--output-format',
        'stream-json',
        '--resume',
        'cursor-chat',
        'hello from prompt'
      ],
      kind: 'native_cursor'
    })
  })

  it('recognizes both Cursor CLI executable names', () => {
    expect(commandKindFor('cursor', 'cursor-agent')).toBe('native_cursor')
    expect(commandKindFor('cursor', 'agent')).toBe('native_cursor')
  })

  it('builds OpenCode json run command with prompt as a positional argument', () => {
    expect(buildLauncherCommand({
      actor: 'opencode',
      command: 'opencode',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello from prompt'
    })).toEqual({
      command: 'opencode',
      args: ['run', '--format', 'json', '--dangerously-skip-permissions', 'hello from prompt'],
      kind: 'native_opencode'
    })
  })

  it('builds OpenCode resume command with session before prompt', () => {
    expect(buildLauncherCommand({
      actor: 'opencode',
      command: 'opencode',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello from prompt',
      sessionId: 'opencode-session'
    })).toEqual({
      command: 'opencode',
      args: [
        'run',
        '--format',
        'json',
        '--dangerously-skip-permissions',
        '--session',
        'opencode-session',
        'hello from prompt'
      ],
      kind: 'native_opencode'
    })
  })

  it('builds Kimi Code stream-json command with -p prompt', () => {
    expect(buildLauncherCommand({
      actor: 'kimi',
      command: 'kimi',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello from prompt',
      sessionId: 'kimi-session'
    })).toEqual({
      command: 'kimi',
      args: [
        '-p',
        'hello from prompt',
        '--output-format',
        'stream-json',
        '-S',
        'kimi-session'
      ],
      kind: 'native_kimi'
    })
  })

  it('builds Kimi Code command without session when no sessionId', () => {
    expect(buildLauncherCommand({
      actor: 'kimi',
      command: 'kimi',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello from prompt'
    })).toEqual({
      command: 'kimi',
      args: [
        '-p',
        'hello from prompt',
        '--output-format',
        'stream-json'
      ],
      kind: 'native_kimi'
    })
  })

  it('builds custom launcher contract flags and environment', () => {
    expect(buildLauncherCommand({
      actor: 'claude',
      command: '/tmp/run-actor --flag',
      mode: 'resume',
      repoRoot: '/tmp/repo',
      taskDir: '/tmp/task',
      runId: 'run-1',
      promptFile: '/tmp/prompt.md',
      outputFile: '/tmp/output.md',
      eventFile: '/tmp/events.jsonl',
      sessionId: 'claude-session'
    })).toEqual({
      command: '/tmp/run-actor',
      args: [
        '--flag',
        '--actor',
        'claude',
        '--mode',
        'resume',
        '--repo-root',
        '/tmp/repo',
        '--task-dir',
        '/tmp/task',
        '--run-id',
        'run-1',
        '--prompt-file',
        '/tmp/prompt.md',
        '--output-file',
        '/tmp/output.md',
        '--event-file',
        '/tmp/events.jsonl',
        '--session-id',
        'claude-session'
      ],
      env: {
        BUDDY_ACTOR: 'claude',
        BUDDY_MODE: 'resume',
        BUDDY_REPO_ROOT: '/tmp/repo',
        BUDDY_TASK_DIR: '/tmp/task',
        BUDDY_RUN_ID: 'run-1',
        BUDDY_PROMPT_FILE: '/tmp/prompt.md',
        BUDDY_OUTPUT_FILE: '/tmp/output.md',
        BUDDY_EVENT_FILE: '/tmp/events.jsonl',
        BUDDY_SESSION_ID: 'claude-session'
      },
      kind: 'contract'
    })
  })

  it('does not include resume/session flags when no sessionId is provided (commit message generation)', () => {
    // Verify all five actors: no session ID means no resume flag
    const actors = [
      { actor: 'claude', command: 'claude' },
      { actor: 'codex', command: 'codex' },
      { actor: 'cursor', command: 'cursor-agent' },
      { actor: 'opencode', command: 'opencode' },
      { actor: 'kimi', command: 'kimi' }
    ]

    for (const { actor, command } of actors) {
      const cmd = buildLauncherCommand({
        actor,
        command,
        promptFile: '/tmp/prompt.md',
        promptText: 'test',
        repoRoot: '/tmp/repo',
        outputFile: '/tmp/output.md'
      })
      // No args should contain resume or session flags
      const argsStr = cmd.args.join(' ')
      expect(argsStr).not.toContain('--resume')
      expect(argsStr).not.toContain('--session')
      expect(argsStr).not.toContain('resume ')
      expect(argsStr).not.toContain(' -S ')
      // Claude should not have --resume when no sessionId
      if (actor === 'claude') {
        expect(argsStr).not.toContain('--resume')
      }
      // Codex should not have 'resume' when no sessionId
      if (actor === 'codex') {
        expect(argsStr).not.toContain('resume')
      }
      // OpenCode should not have --session when no sessionId
      if (actor === 'opencode') {
        expect(argsStr).not.toContain('--session')
      }
      // Kimi should not have -S when no sessionId
      if (actor === 'kimi') {
        expect(argsStr).not.toContain('-S')
      }
    }
  })
})
