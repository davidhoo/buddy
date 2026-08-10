import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import {
  buildLauncherCommand,
  commandKindFor,
  kindNeedsPty,
  parserActorForKind,
  runLauncher,
  runLauncherWithPty,
  type LauncherCommandKind
} from './launchers'
import { extractActorOutput } from './parsers'
import type { Launcher, TaskSettings, GlobalSettings } from '../../shared/types'
import { normalizeGlobalSettings, normalizeLauncher } from '../../shared/defaults'

const COMMIT_MESSAGE_TIMEOUT_MS = 120_000
const MAX_DIFF_BYTES = 200_000

const SUPPORTED_ACTORS = ['claude', 'codex', 'cursor', 'opencode', 'kimi'] as const
export type CommitMessageActor = typeof SUPPORTED_ACTORS[number]

export function isSupportedActor(actor: string): actor is CommitMessageActor {
  return (SUPPORTED_ACTORS as readonly string[]).includes(actor)
}

// ─── Diff collection ──────────────────────────────────────────────

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => errChunks.push(c))
    once(child, 'exit').then((exitArgs: unknown[]) => {
      const code = exitArgs[0] as number | null
      const stdout = Buffer.concat(chunks).toString('utf8')
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim()
        reject(new Error(stderr || `git ${args.join(' ')} exited with ${code}`))
      } else {
        resolve(stdout)
      }
    })
    child.on('error', reject)
  })
}

function buildNewFileDiff(filePath: string, content: string): string {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const body = lines.map(l => `+${l}`).join('\n')
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body
  ].join('\n')
}

export interface SelectedDiffResult {
  paths: string[]
  diff: string
  truncated: boolean
  totalBytes: number
}

/**
 * Collect actual diffs for the selected file paths (staged + unstaged vs HEAD).
 * Untracked files get a synthesized all-added diff.
 * Deleted files get the deletion diff.
 * Binary files are noted with type and change description.
 * Diffs are truncated at MAX_DIFF_BYTES with a clear marker.
 */
export async function gitDiffForSelectedFiles(cwd: string, paths: string[]): Promise<SelectedDiffResult> {
  if (!paths.length) return { paths: [], diff: '', truncated: false, totalBytes: 0 }

  const diffs: string[] = []
  let totalBytes = 0
  let truncated = false

  for (const filePath of paths) {
    if (totalBytes >= MAX_DIFF_BYTES) {
      truncated = true
      break
    }

    let diff = ''
    try {
      diff = await execGit(['diff', 'HEAD', '--no-renames', '--', filePath], cwd)
    } catch {
      const [staged, unstaged] = await Promise.all([
        execGit(['diff', '--cached', '--no-renames', '--', filePath], cwd).catch(() => ''),
        execGit(['diff', '--no-renames', '--', filePath], cwd).catch(() => '')
      ])
      diff = [staged, unstaged].filter(Boolean).join('\n')
    }

    if (diff) {
      const remaining = MAX_DIFF_BYTES - totalBytes
      if (diff.length > remaining) {
        diffs.push(diff.slice(0, remaining) + '\n... (diff truncated)')
        totalBytes = MAX_DIFF_BYTES
        truncated = true
        break
      }
      diffs.push(diff)
      totalBytes += diff.length
      continue
    }

    // Untracked or new file: synthesize an all-added diff from disk content
    try {
      const abs = join(cwd, filePath)
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        try {
          const delDiff = await execGit(['diff', '--no-renames', '--', filePath], cwd)
          if (delDiff) {
            const remaining = MAX_DIFF_BYTES - totalBytes
            if (delDiff.length > remaining) {
              diffs.push(delDiff.slice(0, remaining) + '\n... (diff truncated)')
              totalBytes = MAX_DIFF_BYTES
              truncated = true
              break
            }
            diffs.push(delDiff)
            totalBytes += delDiff.length
          }
        } catch { /* file fully deleted */ }
        continue
      }
      const buf = readFileSync(abs)
      if (buf.includes(0)) {
        diffs.push(`Binary file ${filePath} changed (binary content not shown)`)
        continue
      }
      let content = buf.toString('utf8')
      const remaining = MAX_DIFF_BYTES - totalBytes
      if (content.length > remaining) {
        content = content.slice(0, remaining)
        diffs.push(buildNewFileDiff(filePath, content) + '\n... (file content truncated)')
        totalBytes = MAX_DIFF_BYTES
        truncated = true
        break
      }
      diffs.push(buildNewFileDiff(filePath, content))
      totalBytes += content.length
    } catch { /* skip inaccessible files */ }
  }

  const diffStr = diffs.join('\n\n')
  return { paths, diff: diffStr, truncated, totalBytes: Buffer.byteLength(diffStr, 'utf8') }
}

// ─── Prompt builder ───────────────────────────────────────────────

function langInstruction(lang?: string): string {
  if (!lang || lang === 'en') return 'Write the commit message in English.'
  if (lang === 'zh-CN') return '使用简体中文撰写提交信息。'
  if (lang === 'zh-TW') return '使用繁體中文撰寫提交訊息。'
  return `Write the commit message in ${lang}.`
}

export function buildCommitMessagePrompt(input: {
  paths: string[]
  diff: string
  truncated: boolean
  lang?: string
}): string {
  const { paths, diff, truncated, lang } = input
  const pathsList = paths.map(p => `- ${p}`).join('\n')
  const truncationNote = truncated
    ? '\n\n注意: SELECTED_DIFF 已被截断。你可以通过工具读取 SELECTED_PATHS 中的文件来补充理解,但不得查看未列出的文件。'
    : ''

  return `你当前的任务是为一次 Git 提交生成提交信息。

## 变更范围

以下文件路径定义了本次提交的范围边界。提交信息只能总结这些文件的变化,不得描述未列出文件中的变化。

SELECTED_PATHS:
${pathsList}

## 实际 diff

以下是这些文件相对 HEAD 的实际 staged + unstaged diff:

SELECTED_DIFF:
${diff || '(无 diff 内容)'}
${truncationNote}

## 允许的操作

- 你可以调用工具读取代码文件、查看 Git 历史和理解项目上下文,用于理解名称、关系、行为和提交风格。
- 你可以读取 SELECTED_PATHS 中的文件以补充对变更的理解。

## 禁止的操作

- 不得修改、创建或删除任何文件。
- 不得执行 git add、git commit、git push、git reset 等写操作。
- 不得描述未选择文件中的变化。
- 不得在提交信息中添加 Co-Authored-By 等元数据。

## 输出格式要求

- 使用 Conventional Commits 格式。
- 标题格式为 type(scope): description,scope 可省略。
- 中文标题使用简洁的动作描述,不强制套用英文祈使语法。
- 第一行不超过 72 个字符。
- 非简单修改应包含正文。
- 正文可以包含项目符号(- 开头)、缩进续行和独立补充段落。
- 不添加 Co-Authored-By 等元数据。
- 最终只返回提交信息结果,不返回分析、思考过程、工具调用或解释。

${langInstruction(lang)}

## 输出协议

最终返回以下 JSON 格式(仅返回此 JSON,不附加其他内容):

{"type":"commit_message","message":"完整的提交信息"}

其中 message 是任意合法的多行字符串,可以包含:
- Conventional Commit 标题
- 标题后的空行
- - 开头的项目符号
- 项目符号的缩进续行
- 多个正文段落
- 最后的补充说明

JSON 中换行通过 \\n 表达。`
}

// ─── Output parsing ───────────────────────────────────────────────

const CONVENTIONAL_COMMIT_RE = /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([^)]*\))?!?:\s.+/

const INVALID_MARKERS = [
  '<think>',
  '<tool_call>',
  'SEARCH/REPLACE',
  '```',
  '<tool_use>',
  '<function_calls>',
  'I\'ll examine',
  'I will examine',
  'Let me analyze',
  'Based on the diff'
]

function hasInvalidMarkers(text: string): boolean {
  return INVALID_MARKERS.some(m => text.includes(m))
}

/**
 * Parse the actor's final output to extract the commit message.
 * 1. Use existing Actor parser to extract final assistant/result output.
 * 2. Try JSON with type=commit_message and message field.
 * 3. Fallback: accept plain text only if the entire output is a valid Conventional Commit.
 * 4. Validate: reject outputs with think tags, tool calls, code fences, etc.
 */
export function parseCommitMessageOutput(actor: string, kind: LauncherCommandKind, rawEvents: string): string | null {
  const parserActor = parserActorForKind(actor, kind)
  const finalText = extractActorOutput(parserActor, rawEvents).trim()

  if (!finalText) return null

  // Try JSON parse first
  const jsonMatch = finalText.match(/\{[\s\S]*"type"\s*:\s*"commit_message"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed && parsed.type === 'commit_message' && typeof parsed.message === 'string') {
        const message = parsed.message.trim()
        if (message && CONVENTIONAL_COMMIT_RE.test(message.split('\n')[0])) {
          if (hasInvalidMarkers(message)) return null
          return normalizeNewlines(message)
        }
      }
    } catch { /* fall through to plain text */ }
  }

  // Fallback: accept plain text only if it looks like a valid Conventional Commit
  const firstLine = finalText.split('\n')[0]?.trim() ?? ''
  if (
    !hasInvalidMarkers(finalText) &&
    CONVENTIONAL_COMMIT_RE.test(firstLine) &&
    !finalText.startsWith('{')
  ) {
    return normalizeNewlines(finalText)
  }

  return null
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

// ─── Generation orchestration ─────────────────────────────────────

export interface GenerateCommitMessageInput {
  repoRoot: string
  actor: string
  lang?: string
  paths: string[]
  launcher: Launcher
  signal?: AbortSignal
}

export interface GenerateCommitMessageResult {
  message: string
  log: CommitMessageLog
}

export interface CommitMessageLog {
  actor: string
  launcherKind: LauncherCommandKind
  fileCount: number
  diffBytes: number
  diffTruncated: boolean
  startTime: string
  endTime: string
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  valid: boolean
}

let activeController: AbortController | null = null

/** Cancel the active commit message generation, if any. */
export function cancelGenerateCommitMessage(): void {
  activeController?.abort()
  activeController = null
}

export async function generateCommitMessageWithActor(
  input: GenerateCommitMessageInput
): Promise<GenerateCommitMessageResult> {
  const startTime = new Date()
  const startMs = Date.now()

  cancelGenerateCommitMessage()

  const controller = new AbortController()
  activeController = controller
  const signal = controller.signal
  if (input.signal) {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const { repoRoot, actor, lang, paths, launcher } = input
  const diffResult = await gitDiffForSelectedFiles(repoRoot, paths)
  const promptText = buildCommitMessagePrompt({
    paths: diffResult.paths,
    diff: diffResult.diff,
    truncated: diffResult.truncated,
    lang
  })

  const tempDir = await mkdtemp(join(tmpdir(), 'buddy-commit-'))
  const runId = `commit_${Date.now()}`
  const eventFile = join(tempDir, `${runId}-events.jsonl`)
  const outputFile = join(tempDir, `${runId}-output.md`)
  const promptFile = join(tempDir, `${runId}-prompt.md`)
  await writeFile(promptFile, promptText)

  const kind = commandKindFor(actor, launcher.command)
  const launcherCommand = buildLauncherCommand({
    actor,
    command: launcher.command,
    mode: 'start',
    promptFile,
    promptText,
    eventFile,
    outputFile,
    repoRoot,
  })

  const outputLines: string[] = []
  const stderrLines: string[] = []
  let timedOut = false
  let cancelled = false
  let exitCode: number | null = null
  let exitSignal: string | null = null

  try {
    const needsPty = kindNeedsPty(launcherCommand.kind)
    if (needsPty) {
      const result = await runLauncherWithPty({
        command: launcherCommand.command,
        args: launcherCommand.args,
        cwd: repoRoot,
        env: { ...launcher.env, ...(launcherCommand.env ?? {}) },
        timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
        onData: (data) => {
          for (const line of data.split(/\r?\n/).filter(Boolean)) outputLines.push(line)
        },
        signal
      })
      exitCode = result.exitCode
      exitSignal = result.signal
    } else {
      const result = await runLauncher({
        command: launcherCommand.command,
        args: launcherCommand.args,
        cwd: repoRoot,
        env: { ...launcher.env, ...(launcherCommand.env ?? {}) },
        stdinText: launcherCommand.stdinText,
        timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
        onStdout: (line) => outputLines.push(line),
        onStderr: (line) => stderrLines.push(line),
        signal
      })
      exitCode = result.exitCode
      exitSignal = result.signal
    }
  } catch (err) {
    if (signal.aborted) {
      cancelled = true
    } else {
      throw err
    }
  }

  const endTime = new Date()
  const durationMs = Date.now() - startMs

  // 显式检查 signal.aborted — runLauncher/runLauncherWithPty abort 后
  // 正常 resolve（不 throw），所以必须在这里判
  if (signal.aborted) {
    cancelled = true
  } else if (
    (exitSignal === 'SIGTERM' || exitSignal === '15') &&
    exitCode === null
  ) {
    // 非 abort 的 SIGTERM 且无 exit code = 超时 kill
    timedOut = true
  }

  const stdoutText = outputLines.join('\n')
  let message = ''
  let valid = false
  if (!cancelled && !timedOut && exitCode === 0) {
    message = parseCommitMessageOutput(actor, launcherCommand.kind, stdoutText) ?? ''
    valid = !!message
  }

  const log: CommitMessageLog = {
    actor,
    launcherKind: launcherCommand.kind,
    fileCount: paths.length,
    diffBytes: diffResult.totalBytes,
    diffTruncated: diffResult.truncated,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    durationMs,
    exitCode,
    timedOut,
    cancelled,
    valid
  }

  // 第七节：日志只记录元信息，不记录 diff/提交信息/思考过程/密钥
  console.error('[commit-message]', JSON.stringify(log))

  try { await rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  if (activeController === controller) activeController = null

  if (cancelled) throw new CommitMessageCancelledError(log)
  if (timedOut) throw new CommitMessageTimeoutError(log)
  if (exitCode !== null && exitCode !== 0) {
    throw new CommitMessageProcessError(log, exitCode, stderrLines.join('\n').trim())
  }
  if (!valid || !message) throw new CommitMessageInvalidOutputError(log)

  return { message, log }
}

// ─── Error classes ────────────────────────────────────────────────

export class CommitMessageCancelledError extends Error {
  constructor(public log: CommitMessageLog) {
    super('Commit message generation was cancelled')
    this.name = 'CommitMessageCancelledError'
  }
}

export class CommitMessageTimeoutError extends Error {
  constructor(public log: CommitMessageLog) {
    super('Commit message generation timed out')
    this.name = 'CommitMessageTimeoutError'
  }
}

export class CommitMessageProcessError extends Error {
  constructor(public log: CommitMessageLog, public exitCode: number, public stderr: string) {
    super(`Actor exited with code ${exitCode}`)
    this.name = 'CommitMessageProcessError'
  }
}

export class CommitMessageInvalidOutputError extends Error {
  constructor(public log: CommitMessageLog) {
    super('Commit message output was invalid')
    this.name = 'CommitMessageInvalidOutputError'
  }
}

// ─── Actor resolution ─────────────────────────────────────────────

export function resolveCommitMessageActor(
  storedActor: string | null,
  taskImplementer?: string
): CommitMessageActor {
  if (storedActor && isSupportedActor(storedActor)) return storedActor
  if (taskImplementer && isSupportedActor(taskImplementer)) return taskImplementer
  return 'claude'
}

export function resolveLauncher(
  actor: string,
  taskSettings?: TaskSettings | null,
  globalSettings?: GlobalSettings | null
): Launcher {
  const taskLauncher = taskSettings?.launchers?.[actor]
  if (taskLauncher?.command) return normalizeLauncher(actor, taskLauncher)
  const globalLauncher = normalizeGlobalSettings(globalSettings).launchers?.[actor]
  if (globalLauncher?.command) return globalLauncher
  return normalizeLauncher(actor)
}
