import { describe, expect, it } from 'vitest'
import { buildLauncherCommand } from '../../../src/main/buddy/launchers'

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
})
