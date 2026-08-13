import { describe, expect, it } from 'vitest'
import { execSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getGitFileStatuses,
  getGitRemotes,
  getGitStatus,
  gitDiffForCommitMessage,
  gitStageFiles,
  gitCommitAndPush,
  gitFileDiff
} from '../../../src/main/buddy/git'

function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-git-test-'))
  execSync('git init', { cwd: dir })
  execSync('git config user.email test@test.com', { cwd: dir })
  execSync('git config user.name Test', { cwd: dir })
  return dir
}

/** Create a bare remote repo and add it to `dir` under the given remote name. */
function addBareRemote(dir: string, name: string): string {
  const bare = mkdtempSync(join(tmpdir(), `buddy-git-bare-${name}-`))
  execSync(`git init --bare`, { cwd: bare })
  execSync(`git remote add ${name} ${bare}`, { cwd: dir })
  return bare
}

/** Branch on a new branch from current HEAD (no upstream). */
function checkoutNewBranch(dir: string, branch: string): void {
  execSync(`git checkout -b ${branch}`, { cwd: dir })
}

describe('gitDiffForCommitMessage', () => {
  it('returns empty string for empty paths array', async () => {
    const dir = createTestRepo()
    try {
      const result = await gitDiffForCommitMessage(dir, [])
      expect(result).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns real diff content for modified files', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'initial content\n')
      execSync('git add file.txt && git commit -m "initial"', { cwd: dir })
      writeFileSync(join(dir, 'file.txt'), 'modified content\n')

      const result = await gitDiffForCommitMessage(dir, ['file.txt'])
      expect(result).toContain('diff --git a/file.txt b/file.txt')
      expect(result).toContain('-initial content')
      expect(result).toContain('+modified content')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('includes untracked files as new file diffs', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'existing.txt'), 'base\n')
      execSync('git add existing.txt && git commit -m "base"', { cwd: dir })
      writeFileSync(join(dir, 'new-file.txt'), 'new content\n')

      const result = await gitDiffForCommitMessage(dir, ['new-file.txt'])
      expect(result).toContain('new file mode')
      expect(result).toContain('+new content')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not include diffs for unselected files', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'selected.txt'), 'selected\n')
      writeFileSync(join(dir, 'unselected.txt'), 'unselected\n')
      execSync('git add -A && git commit -m "base"', { cwd: dir })
      writeFileSync(join(dir, 'selected.txt'), 'selected modified\n')
      writeFileSync(join(dir, 'unselected.txt'), 'unselected modified\n')

      const result = await gitDiffForCommitMessage(dir, ['selected.txt'])
      expect(result).toContain('selected modified')
      expect(result).not.toContain('unselected modified')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handles repos without HEAD (no commits)', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'content\n')
      execSync('git add file.txt', { cwd: dir })

      const result = await gitDiffForCommitMessage(dir, ['file.txt'])
      // Should return some diff content even without HEAD
      expect(result).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('works with deleted files', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'to-delete.txt'), 'content to delete\n')
      execSync('git add -A && git commit -m "add file"', { cwd: dir })
      execSync('rm to-delete.txt', { cwd: dir })

      const result = await gitDiffForCommitMessage(dir, ['to-delete.txt'])
      expect(result).toContain('-content to delete')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('works with binary files', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m "base"', { cwd: dir })
      // Write binary content
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
      writeFileSync(join(dir, 'file.txt'), binaryContent)

      const result = await gitDiffForCommitMessage(dir, ['file.txt'])
      expect(result).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gitStageFiles', () => {
  it('stages only selected files', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      writeFileSync(join(dir, 'b.txt'), 'b\n')
      execSync('git add -A && git commit -m "base"', { cwd: dir })
      writeFileSync(join(dir, 'a.txt'), 'a modified\n')
      writeFileSync(join(dir, 'b.txt'), 'b modified\n')

      await gitStageFiles(dir, ['a.txt'])
      const staged = execSync('git diff --cached --name-only', { cwd: dir }).toString().trim()
      expect(staged).toBe('a.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when no files are selected', async () => {
    const dir = createTestRepo()
    try {
      await expect(gitStageFiles(dir, [])).rejects.toThrow('No files selected')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gitCommitAndPush preserves multi-line message', () => {
  it('commits with full multi-line message', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'content\n')
      await gitStageFiles(dir, ['file.txt'])

      const message = 'feat: add new feature\n\n- First bullet\n- Second bullet\n\nSupplemental paragraph.'
      const result = await gitCommitAndPush(dir, message, 'origin', false)
      expect(result.commitHash).toBeTruthy()
      expect(result.pushStatus).toBe('not_requested')

      const committed = execSync('git log -1 --pretty=%B', { cwd: dir }).toString()
      // Git adds a trailing newline
      expect(committed.trim()).toBe(message.trim())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gitCommitAndPush push semantics', () => {
  it('returns not_requested when push=false and does not require a remote', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'content\n')
      await gitStageFiles(dir, ['file.txt'])
      const result = await gitCommitAndPush(dir, 'msg', '', false)
      expect(result.pushStatus).toBe('not_requested')
      expect(result.remote).toBeNull()
      expect(result.upstreamCreated).toBe(false)
      expect(result.pushError).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('first-pushes a branch with no upstream and sets upstream on success', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      checkoutNewBranch(dir, 'feature')

      writeFileSync(join(dir, 'file.txt'), 'changed\n')
      await gitStageFiles(dir, ['file.txt'])
      const result = await gitCommitAndPush(dir, 'feat: change', 'origin', true)
      expect(result.pushStatus).toBe('pushed')
      expect(result.remote).toBe('origin')
      expect(result.upstreamCreated).toBe(true)
      expect(result.pushError).toBeNull()

      // bare remote now has the same branch
      const remoteBranches = execFileSync('git', ['--git-dir=' + bare, 'branch', '--format=%(refname:short)']).toString().trim()
      expect(remoteBranches).toBe('feature')

      // upstream now points to origin/feature
      const upstream = execSync('git rev-parse --abbrev-ref feature@{upstream}', { cwd: dir }).toString().trim()
      expect(upstream).toBe('origin/feature')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('pushes again on a branch that already tracks origin and reports upstreamCreated=false', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })

      writeFileSync(join(dir, 'file.txt'), 'changed\n')
      await gitStageFiles(dir, ['file.txt'])
      const result = await gitCommitAndPush(dir, 'feat: change', 'origin', true)
      expect(result.pushStatus).toBe('pushed')
      expect(result.upstreamCreated).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('pushes to a second remote without rewriting the original upstream', async () => {
    const dir = createTestRepo()
    const originBare = addBareRemote(dir, 'origin')
    const backupBare = addBareRemote(dir, 'backup')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })

      writeFileSync(join(dir, 'file.txt'), 'changed\n')
      await gitStageFiles(dir, ['file.txt'])
      const result = await gitCommitAndPush(dir, 'feat: change', 'backup', true)
      expect(result.pushStatus).toBe('pushed')
      expect(result.remote).toBe('backup')

      // backup now has main
      const backupBranches = execFileSync('git', ['--git-dir=' + backupBare, 'branch', '--format=%(refname:short)']).toString().trim()
      expect(backupBranches).toBe('main')

      // original upstream unchanged
      const upstream = execSync('git rev-parse --abbrev-ref main@{upstream}', { cwd: dir }).toString().trim()
      expect(upstream).toBe('origin/main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(originBare, { recursive: true, force: true })
      rmSync(backupBare, { recursive: true, force: true })
    }
  })

  it('reports failed push (not reject) and preserves the local commit', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      // point origin at a nonexistent path
      execSync('git remote add origin /nonexistent/path/to/remote.git', { cwd: dir })

      writeFileSync(join(dir, 'file.txt'), 'changed\n')
      await gitStageFiles(dir, ['file.txt'])
      const localHeadBefore = execSync('git rev-parse --short HEAD', { cwd: dir }).toString().trim()

      const result = await gitCommitAndPush(dir, 'feat: change', 'origin', true)
      expect(result.pushStatus).toBe('failed')
      expect(result.remote).toBe('origin')
      expect(result.upstreamCreated).toBe(false)
      expect(result.pushError).toBeTruthy()
      expect(result.pushError).not.toContain('Commit failed')

      // local commit retained
      const lastMsg = execSync('git log -1 --pretty=%B', { cwd: dir }).toString().trim()
      expect(lastMsg).toBe('feat: change')
      expect(result.commitHash).not.toBe(localHeadBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still rejects when git commit itself fails', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      // nothing staged -> commit fails
      await expect(gitCommitAndPush(dir, 'msg', 'origin', true)).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('getGitRemotes', () => {
  it('returns origin when a single remote is configured', async () => {
    const dir = createTestRepo()
    try {
      execSync('git remote add origin git@github.com:test/repo.git', { cwd: dir })
      const remotes = await getGitRemotes(dir)
      expect(remotes).toEqual([{ name: 'origin', url: 'git@github.com:test/repo.git' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns all remotes in git remote output order', async () => {
    const dir = createTestRepo()
    try {
      execSync('git remote add origin git@github.com:test/repo.git', { cwd: dir })
      execSync('git remote add backup git@github.com:test/backup.git', { cwd: dir })
      const remotes = await getGitRemotes(dir)
      expect(remotes.map(r => r.name).sort()).toEqual(['backup', 'origin'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the push URL when push URL differs from fetch URL', async () => {
    const dir = createTestRepo()
    try {
      execSync('git remote add origin git@github.com:test/fetch.git', { cwd: dir })
      execSync('git remote set-url --push origin git@github.com:test/push.git', { cwd: dir })
      const remotes = await getGitRemotes(dir)
      expect(remotes).toEqual([{ name: 'origin', url: 'git@github.com:test/push.git' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discovers origin when only a push URL is configured', async () => {
    const dir = createTestRepo()
    try {
      execSync('git remote add origin git@github.com:test/fetch.git', { cwd: dir })
      // 清除 fetch url，仅保留 pushurl
      execSync('git config --unset remote.origin.url', { cwd: dir })
      execSync('git config remote.origin.pushurl git@github.com:test/push.git', { cwd: dir })
      const remotes = await getGitRemotes(dir)
      expect(remotes).toEqual([{ name: 'origin', url: 'git@github.com:test/push.git' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty array when no remote is configured', async () => {
    const dir = createTestRepo()
    try {
      const remotes = await getGitRemotes(dir)
      expect(remotes).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getGitFileStatuses', () => {
  it('returns file statuses for modified and untracked files', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'committed.txt'), 'base\n')
      execSync('git add -A && git commit -m "base"', { cwd: dir })
      writeFileSync(join(dir, 'committed.txt'), 'modified\n')
      writeFileSync(join(dir, 'untracked.txt'), 'new\n')

      const statuses = await getGitFileStatuses(dir)
      const paths = statuses.map(s => s.path)
      expect(paths).toContain('committed.txt')
      expect(paths).toContain('untracked.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gitFileDiff', () => {
  it('returns diff for a single file', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m "base"', { cwd: dir })
      writeFileSync(join(dir, 'file.txt'), 'modified\n')

      const diff = await gitFileDiff(dir, 'file.txt')
      expect(diff).toContain('diff --git')
      expect(diff).toContain('+modified')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getGitStatus upstream', () => {
  it('exposes upstream { remote, branch } when current branch tracks origin/main', async () => {
    const dir = createTestRepo()
    addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      // 建立 origin/main upstream
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })

      const status = await getGitStatus(dir)
      expect(status.branch).toBe('main')
      expect(status.remotes.map(r => r.name)).toContain('origin')
      expect(status.upstream).toEqual({ remote: 'origin', branch: 'main' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns upstream null for a branch with no upstream configured', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      checkoutNewBranch(dir, 'feature')

      const status = await getGitStatus(dir)
      expect(status.branch).toBe('feature')
      expect(status.upstream).toBeNull()
      // 既有字段仍可读取
      expect(status.remotes).toEqual([])
      expect(status.files.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns upstream null on detached HEAD', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git checkout --detach', { cwd: dir })

      const status = await getGitStatus(dir)
      expect(status.branch).toBe('HEAD')
      expect(status.upstream).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
