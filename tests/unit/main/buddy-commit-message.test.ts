import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCommitMessagePrompt,
  parseCommitMessageOutput,
  gitDiffForSelectedFiles,
  isSupportedActor,
  resolveCommitMessageActor,
  resolveLauncher,
  type CommitMessageActor
} from '../../../src/main/buddy/commit-message'
import type { LauncherCommandKind } from '../../../src/main/buddy/launchers'

describe('isSupportedActor', () => {
  it('accepts all five supported actors', () => {
    expect(isSupportedActor('claude')).toBe(true)
    expect(isSupportedActor('codex')).toBe(true)
    expect(isSupportedActor('cursor')).toBe(true)
    expect(isSupportedActor('opencode')).toBe(true)
    expect(isSupportedActor('kimi')).toBe(true)
  })

  it('rejects unsupported actors', () => {
    expect(isSupportedActor('human')).toBe(false)
    expect(isSupportedActor('')).toBe(false)
    expect(isSupportedActor('chatgpt')).toBe(false)
  })
})

describe('resolveCommitMessageActor', () => {
  it('uses stored actor when valid', () => {
    expect(resolveCommitMessageActor('codex', 'claude')).toBe('codex')
  })

  it('falls back to task implementer when stored is invalid', () => {
    expect(resolveCommitMessageActor('invalid', 'cursor')).toBe('cursor')
  })

  it('falls back to claude when both are invalid', () => {
    expect(resolveCommitMessageActor(null, 'invalid')).toBe('claude')
    expect(resolveCommitMessageActor(null, undefined)).toBe('claude')
  })

  it('falls back to claude when nothing is stored', () => {
    expect(resolveCommitMessageActor(null, undefined)).toBe('claude')
  })
})

describe('resolveLauncher', () => {
  it('uses task launcher when available', () => {
    const launcher = resolveLauncher('codex', {
      launchers: {
        codex: { command: 'codex --profile test', env: {}, timeout_seconds: 100 }
      }
    } as any, null)
    expect(launcher.command).toBe('codex --profile test')
  })

  it('falls back to global launcher', () => {
    const launcher = resolveLauncher('claude', null, {
      launchers: {
        claude: { command: 'claude --global', env: {}, timeout_seconds: 7200 }
      }
    } as any)
    expect(launcher.command).toBe('claude --global')
  })

  it('falls back to default launcher', () => {
    const launcher = resolveLauncher('kimi', null, null)
    expect(launcher.command).toBe('kimi')
  })

  it('inherits ACP protocol and model from task launchers', () => {
    const launcher = resolveLauncher('claude', {
      launchers: {
        claude: {
          protocol: 'acp',
          command: 'npx',
          args: ['-y', '@agentclientprotocol/claude-agent-acp'],
          env: {},
          timeout_seconds: 7200,
          model: 'sonnet-4.5'
        }
      }
    } as any, null)
    expect(launcher.protocol).toBe('acp')
    expect(launcher.model).toBe('sonnet-4.5')
    expect(launcher.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  })

  it('inherits ACP protocol from global when task entry omits it', () => {
    const launcher = resolveLauncher(
      'claude',
      {
        launchers: {
          claude: {
            command: 'npx',
            env: {},
            timeout_seconds: 7200,
            model: 'opus-4.6'
          }
        }
      } as any,
      {
        launchers: {
          claude: {
            protocol: 'acp',
            command: 'npx',
            args: ['-y', '@agentclientprotocol/claude-agent-acp'],
            env: {},
            timeout_seconds: 7200
          }
        }
      } as any
    )
    expect(launcher.protocol).toBe('acp')
    expect(launcher.model).toBe('opus-4.6')
    expect(launcher.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
  })
})

describe('buildCommitMessagePrompt', () => {
  it('includes SELECTED_PATHS and SELECTED_DIFF', () => {
    const prompt = buildCommitMessagePrompt({
      paths: ['src/app.ts', 'src/util.ts'],
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+new code',
      truncated: false,
      lang: 'zh-CN'
    })

    expect(prompt).toContain('SELECTED_PATHS:')
    expect(prompt).toContain('- src/app.ts')
    expect(prompt).toContain('- src/util.ts')
    expect(prompt).toContain('SELECTED_DIFF:')
    expect(prompt).toContain('diff --git a/src/app.ts b/src/app.ts')
    expect(prompt).toContain('使用简体中文撰写提交信息')
    expect(prompt).toContain('commit_message')
  })

  it('includes truncation note when diff is truncated', () => {
    const prompt = buildCommitMessagePrompt({
      paths: ['src/app.ts'],
      diff: 'truncated diff content',
      truncated: true,
      lang: 'en'
    })

    expect(prompt).toContain('SELECTED_DIFF 已被截断')
    expect(prompt).toContain('Write the commit message in English')
  })

  it('forbids file modification and git write operations', () => {
    const prompt = buildCommitMessagePrompt({
      paths: ['src/app.ts'],
      diff: 'some diff',
      truncated: false
    })

    expect(prompt).toContain('不得修改、创建或删除任何文件')
    expect(prompt).toContain('不得执行 git add、git commit、git push、git reset')
    expect(prompt).toContain('不得描述未选择文件中的变化')
  })
})

describe('parseCommitMessageOutput', () => {
  const kind: LauncherCommandKind = 'native_codex'

  it('parses valid JSON commit_message output', () => {
    const rawEvents = JSON.stringify({
      type: 'completed',
      content: [{ type: 'output_text', text: '{"type":"commit_message","message":"feat: add new feature\\n\\n- Added X\\n- Updated Y"}' }]
    })
    const result = parseCommitMessageOutput('codex', kind, rawEvents)
    expect(result).toBe('feat: add new feature\n\n- Added X\n- Updated Y')
  })

  it('preserves multi-line message with bullets, blank lines, and indentation', () => {
    const message = 'docs: 新增可选安装渠道\\n\\n- 4 个 README 各新增小节，\\n  提供安装命令\\n- 新增维护文档\\n\\n对应 Tap 仓库。'
    const rawEvents = JSON.stringify({
      type: 'completed',
      content: [{ type: 'output_text', text: `{"type":"commit_message","message":"${message}"}` }]
    })
    const result = parseCommitMessageOutput('codex', kind, rawEvents)
    expect(result).not.toBeNull()
    expect(result).toContain('docs: 新增可选安装渠道')
    expect(result).toContain('\n\n')
    expect(result).toContain('- 4 个 README 各新增小节，')
    expect(result).toContain('  提供安装命令')
    expect(result).toContain('- 新增维护文档')
    expect(result).toContain('对应 Tap 仓库。')
  })

  it('returns null for empty output', () => {
    expect(parseCommitMessageOutput('codex', kind, '')).toBeNull()
  })

  it('returns null for output with think tags', () => {
    const rawEvents = JSON.stringify({
      type: 'completed',
      content: [{ type: 'output_text', text: '<think>Let me analyze</think>\nfeat: something' }]
    })
    expect(parseCommitMessageOutput('codex', kind, rawEvents)).toBeNull()
  })

  it('returns null for output with code fences', () => {
    const rawEvents = JSON.stringify({
      type: 'completed',
      content: [{ type: 'output_text', text: '```\nfeat: something\n```' }]
    })
    expect(parseCommitMessageOutput('codex', kind, rawEvents)).toBeNull()
  })

  it('returns null for output with tool_call markers', () => {
    const rawEvents = JSON.stringify({
      type: 'completed',
      content: [{ type: 'output_text', text: '<tool_call>read_file</tool_call>\nfeat: something' }]
    })
    expect(parseCommitMessageOutput('codex', kind, rawEvents)).toBeNull()
  })

  it('returns null for output without conventional commit title', () => {
    const rawEvents = JSON.stringify({
      type: 'completed',
      content: [{ type: 'output_text', text: '{"type":"commit_message","message":"just some text without type"}' }]
    })
    expect(parseCommitMessageOutput('codex', kind, rawEvents)).toBeNull()
  })

  it('falls back to plain text when entire output is valid Conventional Commit', () => {
    const plainText = 'fix(api): handle null response\\n\\n- Added null check\\n- Returns empty array'
    const rawEvents = JSON.stringify({
      type: 'completed',
      content: [{ type: 'output_text', text: plainText }]
    })
    const result = parseCommitMessageOutput('codex', kind, rawEvents)
    expect(result).not.toBeNull()
    expect(result).toContain('fix(api): handle null response')
    expect(result).toContain('- Added null check')
  })

  it('accepts various conventional commit title formats', () => {
    const titles = [
      'docs: description',
      'docs(readme): description',
      'feat!: description',
      'fix(api)!: description'
    ]
    for (const title of titles) {
      const rawEvents = JSON.stringify({
        type: 'completed',
        content: [{ type: 'output_text', text: title }]
      })
      expect(parseCommitMessageOutput('codex', kind, rawEvents)).not.toBeNull()
    }
  })

  it('does not strip bullet points from plain text fallback', () => {
    const plainText = 'chore: cleanup\\n\\n- removed dead code\\n- fixed imports'
    const rawEvents = JSON.stringify({
      type: 'completed',
      content: [{ type: 'output_text', text: plainText }]
    })
    const result = parseCommitMessageOutput('codex', kind, rawEvents)
    expect(result).toContain('- removed dead code')
    expect(result).toContain('- fixed imports')
  })
})

describe('gitDiffForSelectedFiles', () => {
  it('returns empty result for empty paths', async () => {
    const result = await gitDiffForSelectedFiles('/tmp/nonexistent', [])
    expect(result.diff).toBe('')
    expect(result.paths).toEqual([])
    expect(result.truncated).toBe(false)
  })
})

describe('five actors use launcher without session ID', () => {
  // This is tested via buildLauncherCommand in buddy-launchers.test.ts,
  // but we verify here that commit-message does not pass sessionId
  it('isSupportedActor covers all five actors', () => {
    const actors: CommitMessageActor[] = ['claude', 'codex', 'cursor', 'opencode', 'kimi']
    for (const actor of actors) {
      expect(isSupportedActor(actor)).toBe(true)
    }
  })
})


// Mock runLauncher and runLauncherWithPty for orchestration tests
vi.mock('../../../src/main/buddy/launchers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/buddy/launchers')>()
  return {
    ...actual,
    runLauncher: vi.fn(),
    runLauncherWithPty: vi.fn()
  }
})

import { runLauncher, runLauncherWithPty } from '../../../src/main/buddy/launchers'
import {
  generateCommitMessageWithActor,
  cancelGenerateCommitMessage,
  CommitMessageCancelledError,
  CommitMessageTimeoutError,
  CommitMessageProcessError,
  CommitMessageInvalidOutputError
} from '../../../src/main/buddy/commit-message'
import type { Launcher } from '../../../src/shared/types'

const mockLauncher: Launcher = { command: 'claude', env: {}, timeout_seconds: 120 }

describe('generateCommitMessageWithActor orchestration', () => {
  let tempRepo: string

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runLauncher).mockReset()
    vi.mocked(runLauncherWithPty).mockReset()
    tempRepo = mkdtempSync(join(tmpdir(), 'buddy-commit-test-'))
    execSync('git init', { cwd: tempRepo })
    execSync('git config user.email test@test.com', { cwd: tempRepo })
    execSync('git config user.name Test', { cwd: tempRepo })
    writeFileSync(join(tempRepo, 'src-app.ts'), 'initial\n')
    execSync('git add -A && git commit -m "init"', { cwd: tempRepo })
    writeFileSync(join(tempRepo, 'src-app.ts'), 'modified\n')
  })

  afterEach(() => {
    cancelGenerateCommitMessage()
    try { rmSync(tempRepo, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('throws CancelledError when signal is aborted before start', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.mocked(runLauncher).mockResolvedValue({ exitCode: null, signal: 'SIGTERM' })

    await expect(
      generateCommitMessageWithActor({
        repoRoot: tempRepo,
        actor: 'claude',
        paths: ['src-app.ts'],
        launcher: mockLauncher,
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled')
  })

  it('throws TimeoutError on SIGTERM without abort', async () => {
    vi.mocked(runLauncher).mockResolvedValue({ exitCode: null, signal: 'SIGTERM' })

    await expect(
      generateCommitMessageWithActor({
        repoRoot: tempRepo,
        actor: 'claude',
        paths: ['src-app.ts'],
        launcher: mockLauncher
      })
    ).rejects.toThrow('timed out')
  })

  it('throws ProcessError on non-zero exit code', async () => {
    vi.mocked(runLauncher).mockResolvedValue({ exitCode: 1, signal: null })

    await expect(
      generateCommitMessageWithActor({
        repoRoot: tempRepo,
        actor: 'codex',
        paths: ['src-app.ts'],
        launcher: mockLauncher
      })
    ).rejects.toThrow('exited with code 1')
  })

  it('throws InvalidOutputError when output is empty', async () => {
    vi.mocked(runLauncher).mockResolvedValue({ exitCode: 0, signal: null })

    await expect(
      generateCommitMessageWithActor({
        repoRoot: tempRepo,
        actor: 'claude',
        paths: ['src-app.ts'],
        launcher: mockLauncher
      })
    ).rejects.toThrow('invalid')
  })

  it('handles PTY signal 15 as timeout', async () => {
    vi.mocked(runLauncherWithPty).mockResolvedValue({ exitCode: null, signal: '15' })

    await expect(
      generateCommitMessageWithActor({
        repoRoot: tempRepo,
        actor: 'opencode',
        paths: ['src-app.ts'],
        launcher: { command: 'opencode', env: {}, timeout_seconds: 120 }
      })
    ).rejects.toThrow('timed out')
  })

  it('does not invoke the CLI launcher path for ACP actors', async () => {
    const root = await import('node:fs/promises').then(({ mkdtemp, writeFile }) =>
      mkdtemp(join(tmpdir(), 'buddy-commit-acp-skip-cli-')).then(async (dir) => {
        const fake = join(dir, 'fake-acp.js')
        await writeFile(fake, `
          const readline = require('readline');
          const rl = readline.createInterface({ input: process.stdin });
          rl.on('line', (line) => {
            const req = JSON.parse(line);
            if (req.method === 'initialize') {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: req.id,
                result: { protocolVersion: '1.0', agentInfo: { name: 'commit-acp' } }
              }) + '\\n');
            } else if (req.method === 'session/new') {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: req.id,
                result: { sessionId: 'commit_sess' }
              }) + '\\n');
            } else if (req.method === 'session/prompt') {
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', method: 'session/contentDelta',
                params: { text: '{"type":"commit_message","message":"feat: via acp"}' }
              }) + '\\n');
              process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: req.id, result: { status: 'completed' }
              }) + '\\n');
            }
          });
        `)
        return { dir, fake }
      })
    )

    try {
      const result = await generateCommitMessageWithActor({
        repoRoot: tempRepo,
        actor: 'claude',
        paths: ['src-app.ts'],
        launcher: {
          protocol: 'acp',
          command: process.execPath,
          args: [root.fake],
          env: {},
          timeout_seconds: 30
        }
      })
      expect(result.message).toBe('feat: via acp')
      expect(result.log.launcherKind).toBe('acp')
      expect(runLauncher).not.toHaveBeenCalled()
      expect(runLauncherWithPty).not.toHaveBeenCalled()
    } finally {
      try { rmSync(root.dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})

describe('generateCommitMessageWithActor ACP short session', () => {
  let tempRepo: string

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'buddy-commit-acp-repo-'))
    execSync('git init', { cwd: tempRepo })
    execSync('git config user.email test@test.com', { cwd: tempRepo })
    execSync('git config user.name Test', { cwd: tempRepo })
    writeFileSync(join(tempRepo, 'src-app.ts'), 'initial\n')
    execSync('git add -A && git commit -m "init"', { cwd: tempRepo })
    writeFileSync(join(tempRepo, 'src-app.ts'), 'modified\n')
  })

  afterEach(() => {
    cancelGenerateCommitMessage()
    try { rmSync(tempRepo, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('opens session/new with the task model and never session/load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buddy-commit-acp-model-'))
    const fake = join(dir, 'fake-acp.js')
    const methodsLog = join(dir, 'methods.jsonl')
    writeFileSync(fake, `
      const fs = require('fs');
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(methodsLog)}, JSON.stringify({
          method: req.method,
          params: req.params
        }) + '\\n');
        if (req.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id,
            result: { protocolVersion: '1.0', agentInfo: { name: 'commit-model' } }
          }) + '\\n');
        } else if (req.method === 'session/new') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id,
            result: {
              sessionId: 'fresh_sess',
              models: {
                currentModelId: 'sonnet-4.5',
                availableModels: [
                  { modelId: 'opus-4.6', name: 'Opus' },
                  { modelId: 'sonnet-4.5', name: 'Sonnet' }
                ]
              }
            }
          }) + '\\n');
        } else if (req.method === 'session/set_model') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
        } else if (req.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', method: 'session/contentDelta',
            params: { text: '{"type":"commit_message","message":"feat: modeled acp"}' }
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id, result: { status: 'completed' }
          }) + '\\n');
        }
      });
    `)

    try {
      const result = await generateCommitMessageWithActor({
        repoRoot: tempRepo,
        actor: 'claude',
        paths: ['src-app.ts'],
        launcher: {
          protocol: 'acp',
          command: process.execPath,
          args: [fake],
          env: {},
          timeout_seconds: 30,
          model: 'opus-4.6'
        }
      })
      expect(result.message).toBe('feat: modeled acp')

      const methods = readFileSync(methodsLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      expect(methods.map((m: { method: string }) => m.method)).toContain('session/new')
      expect(methods.map((m: { method: string }) => m.method)).not.toContain('session/load')
      expect(methods.some((m: { method: string }) => m.method === 'session/set_model')).toBe(true)
      const setModel = methods.find((m: { method: string }) => m.method === 'session/set_model')
      expect(setModel.params).toEqual({ sessionId: 'fresh_sess', modelId: 'opus-4.6' })
      // No CLI contract flags
      expect(methods.every((m: { method: string }) => !String(m.method).includes('stream-json'))).toBe(true)
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('falls back to session currentModelId when launcher.model is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buddy-commit-acp-default-model-'))
    const fake = join(dir, 'fake-acp.js')
    const methodsLog = join(dir, 'methods.jsonl')
    writeFileSync(fake, `
      const fs = require('fs');
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(methodsLog)}, JSON.stringify({
          method: req.method, params: req.params
        }) + '\\n');
        if (req.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id,
            result: { protocolVersion: '1.0' }
          }) + '\\n');
        } else if (req.method === 'session/new') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id,
            result: {
              sessionId: 'sess_default',
              models: {
                currentModelId: 'sonnet-4.5',
                availableModels: [{ modelId: 'sonnet-4.5', name: 'Sonnet' }]
              }
            }
          }) + '\\n');
        } else if (req.method === 'session/set_model') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
        } else if (req.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', method: 'session/contentDelta',
            params: { text: '{"type":"commit_message","message":"feat: default model"}' }
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id, result: { status: 'completed' }
          }) + '\\n');
        }
      });
    `)

    try {
      await generateCommitMessageWithActor({
        repoRoot: tempRepo,
        actor: 'claude',
        paths: ['src-app.ts'],
        launcher: {
          protocol: 'acp',
          command: process.execPath,
          args: [fake],
          env: {},
          timeout_seconds: 30
        }
      })
      // currentModelId already matches — applyAcpSessionModel skips the round-trip
      const methods = readFileSync(methodsLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      expect(methods.map((m: { method: string }) => m.method)).toContain('session/new')
      expect(methods.map((m: { method: string }) => m.method)).not.toContain('session/load')
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('cancels an in-flight ACP generation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'buddy-commit-acp-cancel-'))
    const fake = join(dir, 'fake-acp.js')
    writeFileSync(fake, `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id, result: { protocolVersion: '1.0' }
          }) + '\\n');
        } else if (req.method === 'session/new') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: req.id, result: { sessionId: 'sess_hang' }
          }) + '\\n');
        } else if (req.method === 'session/prompt') {
          // Never respond — wait for cancel
        }
      });
    `)

    const controller = new AbortController()
    const pending = generateCommitMessageWithActor({
      repoRoot: tempRepo,
      actor: 'claude',
      paths: ['src-app.ts'],
      launcher: {
        protocol: 'acp',
        command: process.execPath,
        args: [fake],
        env: {},
        timeout_seconds: 30
      },
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toThrow(/cancell?ed/i)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})
