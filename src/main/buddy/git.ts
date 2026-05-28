import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { GitDiffStats, GitFileStatus, GitFileStatusCode, GitRemote, GitStatusResult } from '../../shared/types'

export type { GitDiffStats, GitFileStatus, GitFileStatusCode, GitRemote, GitStatusResult }

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => errChunks.push(c))
    once(child, 'exit').then((args: unknown[]) => {
      const code = args[0] as number | null
      const stdout = Buffer.concat(chunks).toString('utf8').trim()
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8').trim()
        reject(new Error(stderr || `git ${args.join(' ')} exited with ${code}`))
      } else {
        resolve(stdout)
      }
    }).catch(reject)
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
  await execGit(['add', '-A'], cwd)
}

export async function gitCommitAndPush(
  cwd: string,
  message: string,
  remote: string,
  push: boolean = true
): Promise<{ commitHash: string }> {
  await execGit(['commit', '-m', message], cwd)
  const commitHash = await execGit(['rev-parse', '--short', 'HEAD'], cwd)
  if (push) {
    await execGit(['push', remote], cwd)
  }
  return { commitHash }
}

export async function gitDiffForCommitMessage(cwd: string): Promise<string> {
  try {
    const [unstaged, staged, statusShort] = await Promise.all([
      execGit(['diff', '--stat'], cwd).catch(() => ''),
      execGit(['diff', '--cached', '--stat'], cwd).catch(() => ''),
      execGit(['status', '--short'], cwd).catch(() => '')
    ])
    return [
      '## git status --short',
      statusShort || '(clean)',
      '',
      '## unstaged diff stat',
      unstaged || '(none)',
      '',
      '## staged diff stat',
      staged || '(none)'
    ].join('\n')
  } catch {
    return ''
  }
}

export async function generateCommitMessage(cwd: string, actorCommand?: string, lang?: string): Promise<string> {
  const diffSummary = await gitDiffForCommitMessage(cwd)
  if (!diffSummary.trim()) return ''

  const command = actorCommand?.trim() || 'claude'
  const langInstruction = lang && lang !== 'en'
    ? `Write the commit message in ${lang === 'zh-CN' ? 'Simplified Chinese' : lang === 'zh-TW' ? 'Traditional Chinese' : 'English'}.`
    : ''
  const prompt = `Generate a git commit message for the following changes. Rules:
- Use the conventional commits format: type(scope): description
- First line is a concise summary (imperative mood, under 72 chars)
- If the changes are non-trivial, add a blank line then a bullet-point body explaining what and why
- Be specific: mention file names, function names, or key concepts that changed
- Do not add Co-Authored-By or other metadata
${langInstruction}

${diffSummary}`

  return new Promise((resolve) => {
    const child = spawn(command, ['-p', '--output-format', 'text', '--input-format', 'text'], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stdin.end(prompt)

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      resolve('')
    }, 30000)

    once(child, 'exit').then(() => {
      clearTimeout(timeout)
      const text = Buffer.concat(chunks).toString('utf8').trim()
      resolve(text || '')
    }).catch(() => {
      clearTimeout(timeout)
      resolve('')
    })
  })
}
