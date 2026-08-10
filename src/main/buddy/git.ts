import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { once } from 'node:events'
import { gitDiffForSelectedFiles } from './commit-message'
import type { GitDiffStats, GitFileStatus, GitFileStatusCode, GitRemote, GitStatusResult } from '../../shared/types'

export type { GitDiffStats, GitFileStatus, GitFileStatusCode, GitRemote, GitStatusResult }

function removeStaleIndexLock(cwd: string, maxAgeMs = 10_000): void {
  const lockPath = join(cwd, '.git', 'index.lock')
  try {
    if (!existsSync(lockPath)) return
    const age = Date.now() - statSync(lockPath).mtimeMs
    if (age > maxAgeMs) {
      unlinkSync(lockPath)
    }
  } catch {
    // Lock file might have been removed between check and delete
  }
}

function execGit(args: string[], cwd: string, retries = 1): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => errChunks.push(c))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    once(child, 'exit').then((exitArgs: unknown[]) => {
      if (settled) return
      settled = true
      const code = exitArgs[0] as number | null
      const stdout = Buffer.concat(chunks).toString('utf8').trim()
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim()
        const errMsg = stderr || `git ${args.join(' ')} exited with ${code}`
        if (retries > 0 && errMsg.includes('index.lock')) {
          removeStaleIndexLock(cwd)
          setTimeout(() => {
            execGit(args, cwd, retries - 1).then(resolve).catch(reject)
          }, 500)
        } else {
          reject(new Error(errMsg))
        }
      } else {
        resolve(stdout)
      }
    }).catch((err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

function parseDiffStat(output: string): GitDiffStats | null {
  if (!output) return null
  const files: GitFileStatus[] = []
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  for (const line of output.split('\n')) {
    const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (m) {
      filesChanged++
      const ins = parseInt(m[1], 10)
      const del = parseInt(m[2], 10)
      insertions += ins
      deletions += del
      files.push({ path: m[3].trim(), status: 'M', insertions: ins, deletions: del })
    }
  }
  if (filesChanged === 0) return null
  return { filesChanged, insertions, deletions, summary: output, files }
}

export async function getGitBranch(cwd: string): Promise<string> {
  try {
    return await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  } catch {
    return ''
  }
}

export async function getGitDiffStats(cwd: string): Promise<GitDiffStats | null> {
  try {
    const output = await execGit(['diff', '--numstat', '--no-renames'], cwd)
    return parseDiffStat(output)
  } catch {
    return null
  }
}

export async function getGitStagedStats(cwd: string): Promise<GitDiffStats | null> {
  try {
    const output = await execGit(['diff', '--cached', '--numstat', '--no-renames'], cwd)
    return parseDiffStat(output)
  } catch {
    return null
  }
}

export async function getGitRemotes(cwd: string): Promise<GitRemote[]> {
  try {
    const output = await execGit(['remote', '-v'], cwd)
    const remotes: GitRemote[] = []
    const seen = new Set<string>()
    for (const line of output.split('\n')) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/)
      if (match && !seen.has(match[1])) {
        seen.add(match[1])
        remotes.push({ name: match[1], url: match[2] })
      }
    }
    return remotes
  } catch {
    return []
  }
}

export async function getGitUntrackedCount(cwd: string): Promise<number> {
  try {
    const output = await execGit(['ls-files', '--others', '--exclude-standard'], cwd)
    if (!output.trim()) return 0
    return output.split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function normalizeStatusCode(xy: string): GitFileStatusCode {
  const x = xy[0]
  const y = xy[1]
  if (x === '?' || y === '?') return '?'
  if (x === 'A' || y === 'A') return 'A'
  if (x === 'D' || y === 'D') return 'D'
  if (x === 'R' || y === 'R') return 'R'
  if (x === 'C' || y === 'C') return 'C'
  return 'M'
}

export async function getGitFileStatuses(cwd: string): Promise<GitFileStatus[]> {
  try {
    const output = await execGit(['status', '--porcelain', '--no-renames'], cwd)
    if (!output.trim()) return []
    const result: GitFileStatus[] = []
    for (const line of output.split('\n')) {
      if (!line.trim()) continue
      const m = line.match(/^([MADRCU? ]{1,2})\s+(.+)$/)
      if (!m) continue
      const xy = m[1]
      const filePath = m[2].trim()
      if (!filePath) continue
      result.push({ path: filePath, status: normalizeStatusCode(xy), insertions: 0, deletions: 0 })
    }
    return result
  } catch {
    return []
  }
}

function mergeFileStatuses(fileStatuses: GitFileStatus[], diffFiles: GitFileStatus[] | undefined, stagedFiles: GitFileStatus[] | undefined): GitFileStatus[] {
  const insertionsByPath = new Map<string, { insertions: number; deletions: number }>()
  for (const f of [...(diffFiles ?? []), ...(stagedFiles ?? [])]) {
    const existing = insertionsByPath.get(f.path)
    if (existing) {
      existing.insertions += f.insertions
      existing.deletions += f.deletions
    } else {
      insertionsByPath.set(f.path, { insertions: f.insertions, deletions: f.deletions })
    }
  }
  return fileStatuses.map(f => {
    const stats = insertionsByPath.get(f.path)
    if (stats) return { ...f, insertions: stats.insertions, deletions: stats.deletions }
    return f
  })
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  const [branch, diff, staged, untracked, remotes, files] = await Promise.all([
    getGitBranch(cwd),
    getGitDiffStats(cwd),
    getGitStagedStats(cwd),
    getGitUntrackedCount(cwd),
    getGitRemotes(cwd),
    getGitFileStatuses(cwd)
  ])
  const mergedFiles = mergeFileStatuses(files, diff?.files, staged?.files)
  return { branch, diff, staged, untracked, remotes, files: mergedFiles }
}

export async function gitStageAll(cwd: string): Promise<void> {
  removeStaleIndexLock(cwd)
  await execGit(['add', '-A'], cwd)
}

/**
 * 只暂存指定文件:先清空暂存区,再精确暂存所选路径,
 * 保证接下来的 commit 恰好包含且仅包含这些文件。
 */
export async function gitStageFiles(cwd: string, paths: string[]): Promise<void> {
  if (!paths.length) throw new Error('No files selected to stage')
  removeStaleIndexLock(cwd)
  // 无 HEAD 的新仓库上 reset 会失败,此时本来也没有可清空的暂存内容,忽略
  await execGit(['reset', '-q'], cwd).catch(() => '')
  await execGit(['add', '-A', '--', ...paths], cwd)
}

const MAX_DIFF_BYTES = 200_000

function buildNewFileDiff(filePath: string, content: string): string {
  const lines = content.split('\n')
  // A trailing newline produces an empty final segment; drop it
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

/**
 * Unified diff for a single file (staged + unstaged vs HEAD).
 * Falls back to an all-added pseudo diff for untracked files or repos without commits.
 */
export async function gitFileDiff(cwd: string, filePath: string): Promise<string> {
  let diff = ''
  try {
    diff = await execGit(['diff', 'HEAD', '--no-renames', '--', filePath], cwd)
  } catch {
    // HEAD may not exist yet (no commits); try staged + unstaged separately
    const [staged, unstaged] = await Promise.all([
      execGit(['diff', '--cached', '--no-renames', '--', filePath], cwd).catch(() => ''),
      execGit(['diff', '--no-renames', '--', filePath], cwd).catch(() => '')
    ])
    diff = [staged, unstaged].filter(Boolean).join('\n')
  }
  if (diff) {
    return diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n… (diff truncated)` : diff
  }
  // Untracked file: synthesize an all-added diff from disk content
  try {
    const abs = join(cwd, filePath)
    if (!existsSync(abs) || !statSync(abs).isFile()) return ''
    const buf = readFileSync(abs)
    if (buf.includes(0)) return '(binary file)'
    let content = buf.toString('utf8')
    if (content.length > MAX_DIFF_BYTES) content = `${content.slice(0, MAX_DIFF_BYTES)}\n… (file truncated)`
    return buildNewFileDiff(filePath, content)
  } catch {
    return ''
  }
}

export async function gitCommitAndPush(
  cwd: string,
  message: string,
  remote: string,
  push: boolean = true
): Promise<{ commitHash: string }> {
  removeStaleIndexLock(cwd)
  await execGit(['commit', '-m', message], cwd)
  const commitHash = await execGit(['rev-parse', '--short', 'HEAD'], cwd)
  if (push) {
    await execGit(['push', remote], cwd)
  }
  return { commitHash }
}

/** List local branch names (short form). Returns [] on error. */
export async function gitBranches(cwd: string): Promise<string[]> {
  try {
    const output = await execGit(['branch', '--format=%(refname:short)'], cwd)
    if (!output) return []
    return output.split('\n').map(b => b.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** Switch to a local branch. Throws with git's stderr on failure (e.g. dirty tree). */
export async function gitCheckout(cwd: string, branch: string): Promise<void> {
  assertValidBranchName(branch)
  await execGit(['checkout', branch], cwd)
}

/** Create a new branch from HEAD and switch to it. Throws with git's stderr on failure. */
export async function gitCreateBranch(cwd: string, branch: string): Promise<void> {
  assertValidBranchName(branch)
  await execGit(['checkout', '-b', branch], cwd)
}

function assertValidBranchName(branch: string): void {
  if (!/^[^\s~^:?*[\]\\]+$/.test(branch) || branch.startsWith('-')) {
    throw new Error(`Invalid branch name: ${branch}`)
  }
}

export async function gitDiffForCommitMessage(cwd: string, paths?: string[]): Promise<string> {
  if (paths && paths.length === 0) return ''
  let selectedPaths: string[]
  if (paths && paths.length > 0) {
    selectedPaths = paths
  } else {
    const statuses = await getGitFileStatuses(cwd)
    selectedPaths = statuses.map(f => f.path)
  }
  const result = await gitDiffForSelectedFiles(cwd, selectedPaths)
  return result.diff
}
