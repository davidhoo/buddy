import { describe, expect, it } from 'vitest'
import { buildLauncherCommand, commandKindFor, runLauncher } from '../../../src/main/buddy/launchers'

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

  it('builds a configurable Cursor Agent stream-json command', () => {
    expect(buildLauncherCommand({
      actor: 'cursor-agent-2',
      command: 'agent --model stale --force',
      backend: 'cursor',
      model: 'composer-2.5',
      cursor: {
        mode: 'agent',
        force: true,
        trust: true,
        approve_mcps: true,
        sandbox: 'enabled',
        stream_partial_output: true,
        extra_args: ['--plugin-dir', '/tmp/plugin']
      },
      promptFile: '/tmp/prompt.md',
      promptText: 'hello from cursor',
      repoRoot: '/tmp/repo',
      sessionId: 'cursor-session'
    })).toEqual({
      command: 'agent',
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
        '--workspace',
        '/tmp/repo',
        '--model',
        'composer-2.5',
        '--force',
        '--trust',
        '--approve-mcps',
        '--sandbox',
        'enabled',
        '--resume',
        'cursor-session',
        '--plugin-dir',
        '/tmp/plugin',
        'hello from cursor'
      ],
      kind: 'native_cursor'
    })
  })

  it('detects both Cursor Agent executable names', () => {
    expect(commandKindFor('cursor-agent-2', 'agent')).toBe('native_cursor')
    expect(commandKindFor('profile-b', '/usr/local/bin/cursor-agent')).toBe('native_cursor')
    // Bare `agent` only maps to cursor for cursor actors; for a non-cursor,
    // non-built-in actor it falls through to contract.
    expect(commandKindFor('some-actor', 'agent')).toBe('contract')
  })

  it('preserves contract semantics for unrecognized auto commands', () => {
    expect(commandKindFor('claude', '/opt/buddy-contract')).toBe('contract')
    expect(commandKindFor('claude', '/opt/buddy-contract', 'auto')).toBe('contract')
  })

  it('uses an explicit native backend for wrapper commands', () => {
    expect(commandKindFor('claude', 'claude-wrapper', 'claude')).toBe('native_claude')
    expect(commandKindFor('kimi', 'vendor-wrapper', 'opencode')).toBe('native_opencode')
    expect(commandKindFor('claude', 'claude', 'contract')).toBe('contract')
  })

  it('builds native Claude flags for an explicitly configured wrapper', () => {
    const command = buildLauncherCommand({
      actor: 'claude',
      command: 'claude-wrapper --dangerously-skip-permissions',
      backend: 'claude',
      promptFile: '/tmp/prompt.md',
      promptText: 'hello'
    })
    expect(command).toEqual({
      command: 'claude-wrapper',
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
    expect(command.args).not.toContain('--actor')
  })

  it('buffers JSONL records split across stdout chunks', async () => {
    const lines: string[] = []
    const script = [
      "const value = JSON.stringify({ type: 'result', result: 'x'.repeat(120000) })",
      'process.stdout.write(value.slice(0, 60000))',
      "setTimeout(() => process.stdout.write(value.slice(60000) + '\\n'), 5)"
    ].join(';')

    const result = await runLauncher({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      timeoutMs: 5000,
      onStdout: (line) => lines.push(line),
      onStderr: () => {}
    })

    expect(result.exitCode).toBe(0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).result).toHaveLength(120000)
  })

  it('pipes oversized Cursor prompts while keeping an explicit instruction', () => {
    const promptText = 'x'.repeat(30_000)
    const command = buildLauncherCommand({
      actor: 'cursor-agent',
      command: 'agent',
      backend: 'cursor',
      promptFile: '/tmp/prompt.md',
      promptText
    })

    expect(command.args.at(-1)).toBe('Follow the complete Buddy turn instructions provided on stdin.')
    expect(command.stdinText).toBe(promptText)
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
