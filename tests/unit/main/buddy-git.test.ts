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
  gitFileDiff,
  getGitPushAvailability,
  gitPush
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

/** Clone a bare remote into a fresh working clone (for advancing origin). */
function cloneRepo(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-git-clone-'))
  execSync(`git clone ${src} ${dir}`)
  execSync('git config user.email test@test.com', { cwd: dir })
  execSync('git config user.name Test', { cwd: dir })
  return dir
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

describe('getGitPushAvailability', () => {
  it('reports ahead when local is 1 commit ahead of origin/main', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })

      writeFileSync(join(dir, 'file.txt'), 'changed\n')
      execSync('git add -A && git commit -m ahead', { cwd: dir })

      const avail = await getGitPushAvailability(dir, 'origin')
      expect(avail.state).toBe('ahead')
      expect(avail.ahead).toBe(1)
      expect(avail.behind).toBe(0)
      expect(avail.remote).toBe('origin')
      expect(avail.branch).toBe('main')
      expect(avail.upstreamCreatedOnPush).toBe(false)
      expect(avail.pendingCommits).toEqual([
        { hash: expect.stringMatching(/^[0-9a-f]{7}$/), subject: 'ahead' }
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('lists pending commits oldest-first with 7-char hashes when local is 2 commits ahead', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })

      writeFileSync(join(dir, 'file.txt'), 'a\n')
      execSync('git add -A && git commit -m "first local"', { cwd: dir })
      writeFileSync(join(dir, 'file.txt'), 'b\n')
      execSync('git add -A && git commit -m "second local"', { cwd: dir })

      const avail = await getGitPushAvailability(dir, 'origin')
      expect(avail.state).toBe('ahead')
      expect(avail.ahead).toBe(2)
      expect(avail.pendingCommits).toEqual([
        { hash: expect.stringMatching(/^[0-9a-f]{7}$/), subject: 'first local' },
        { hash: expect.stringMatching(/^[0-9a-f]{7}$/), subject: 'second local' }
      ])
      // 顺序与 git log --reverse 一致: 最旧在前
      const expected = execSync('git log --reverse --format=%h origin/main..HEAD', { cwd: dir })
        .toString().trim().split('\n')
      expect(avail.pendingCommits.map(c => c.hash)).toEqual(expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('parses pending commit subjects containing spaces, tabs and pipes without truncation', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })

      // 标题里同时含空格、制表符和竖线, 证明不靠这些字符拆分字段
      const subject = 'fix: spaces | pipe\ttab char'
      execSync('git commit -m "second" --allow-empty', { cwd: dir })
      execSync(`git commit -m "${subject}" --allow-empty`, { cwd: dir })

      const avail = await getGitPushAvailability(dir, 'origin')
      expect(avail.state).toBe('ahead')
      expect(avail.ahead).toBe(2)
      expect(avail.pendingCommits[1].subject).toBe(subject)
      expect(avail.pendingCommits[0].subject).toBe('second')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('reports behind after the remote advances, then diverged when both sides move', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })

      // clone after base exists so the clone shares history with origin/main
      const other = cloneRepo(bare)
      try {
        // advance origin/main from the other clone
        writeFileSync(join(other, 'file.txt'), 'remote-change\n')
        execSync('git add -A && git commit -m remote', { cwd: other })
        execSync('git push origin main', { cwd: other })
      } finally {
        rmSync(other, { recursive: true, force: true })
      }

      // dir has not moved: behind by 1
      const behind = await getGitPushAvailability(dir, 'origin')
      expect(behind.state).toBe('behind')
      expect(behind.ahead).toBe(0)
      expect(behind.behind).toBe(1)
      expect(behind.pendingCommits).toEqual([])

      // now dir also adds a local commit → diverged
      writeFileSync(join(dir, 'other.txt'), 'local\n')
      execSync('git add -A && git commit -m local', { cwd: dir })
      const diverged = await getGitPushAvailability(dir, 'origin')
      expect(diverged.state).toBe('diverged')
      expect(diverged.ahead).toBe(1)
      expect(diverged.behind).toBe(1)
      // 分叉时 (ahead>0 && behind>0) 不列出待推送提交: 直接推送会丢弃远端提交, 不应诱导用户核对
      expect(diverged.pendingCommits).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('reports new_branch for a feature branch with no upstream and no remote branch', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      checkoutNewBranch(dir, 'feature')

      const avail = await getGitPushAvailability(dir, 'origin')
      expect(avail.state).toBe('new_branch')
      expect(avail.branch).toBe('feature')
      expect(avail.ahead).toBe(1)
      expect(avail.behind).toBe(0)
      expect(avail.upstreamCreatedOnPush).toBe(true)
      // 远端尚无目标分支: 不以 HEAD 全历史冒充待推送提交
      expect(avail.pendingCommits).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('compares against backup/main (not origin) and keeps the origin upstream intact', async () => {
    const dir = createTestRepo()
    const originBare = addBareRemote(dir, 'origin')
    const backupBare = addBareRemote(dir, 'backup')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })
      // also push base to backup so backup/main exists, then advance local
      execSync('git push backup HEAD:refs/heads/main', { cwd: dir })
      writeFileSync(join(dir, 'file.txt'), 'changed\n')
      execSync('git add -A && git commit -m local', { cwd: dir })

      const avail = await getGitPushAvailability(dir, 'backup')
      expect(avail.state).toBe('ahead')
      expect(avail.branch).toBe('main')
      expect(avail.ahead).toBe(1)
      expect(avail.behind).toBe(0)
      // 提交列表相对 backup/main 计算
      expect(avail.pendingCommits).toEqual([
        { hash: expect.stringMatching(/^[0-9a-f]{7}$/), subject: 'local' }
      ])

      // origin upstream untouched
      const upstream = execSync('git rev-parse --abbrev-ref main@{upstream}', { cwd: dir }).toString().trim()
      expect(upstream).toBe('origin/main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(originBare, { recursive: true, force: true })
      rmSync(backupBare, { recursive: true, force: true })
    }
  })

  it('reports up_to_date when local and remote match', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })

      const avail = await getGitPushAvailability(dir, 'origin')
      expect(avail.state).toBe('up_to_date')
      expect(avail.ahead).toBe(0)
      expect(avail.behind).toBe(0)
      expect(avail.pendingCommits).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('returns unavailable on detached HEAD', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })
      execSync('git checkout --detach', { cwd: dir })

      const avail = await getGitPushAvailability(dir, 'origin')
      expect(avail.state).toBe('unavailable')
      expect(avail.branch).toBe('')
      expect(avail.pendingCommits).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('rejects when fetch itself fails (does not masquerade as pushable)', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git remote add origin /nonexistent/path/to/remote.git', { cwd: dir })

      await expect(getGitPushAvailability(dir, 'origin')).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('gitPush', () => {
  it('pushes existing HEAD without creating a new commit', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })
      writeFileSync(join(dir, 'file.txt'), 'changed\n')
      execSync('git add -A && git commit -m local', { cwd: dir })

      const headBefore = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()
      const result = await gitPush(dir, 'origin')
      expect(result.pushStatus).toBe('pushed')
      expect(result.remote).toBe('origin')
      expect(result.upstreamCreated).toBe(false)
      expect(result.pushError).toBeNull()

      const headAfter = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()
      expect(headAfter).toBe(headBefore)
      // no new commit appeared
      const lastMsg = execSync('git log -1 --pretty=%B', { cwd: dir }).toString().trim()
      expect(lastMsg).toBe('local')
      // working tree still clean
      const status = execSync('git status --porcelain', { cwd: dir }).toString().trim()
      expect(status).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('creates upstream on first push of a new branch', async () => {
    const dir = createTestRepo()
    const bare = addBareRemote(dir, 'origin')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      checkoutNewBranch(dir, 'feature')

      const result = await gitPush(dir, 'origin')
      expect(result.pushStatus).toBe('pushed')
      expect(result.upstreamCreated).toBe(true)

      const upstream = execSync('git rev-parse --abbrev-ref feature@{upstream}', { cwd: dir }).toString().trim()
      expect(upstream).toBe('origin/feature')
      const remoteBranches = execFileSync('git', ['--git-dir=' + bare, 'branch', '--format=%(refname:short)']).toString().trim()
      expect(remoteBranches).toBe('feature')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('pushes to an alternate remote without rewriting the original upstream', async () => {
    const dir = createTestRepo()
    const originBare = addBareRemote(dir, 'origin')
    const backupBare = addBareRemote(dir, 'backup')
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git push -u origin HEAD:refs/heads/main', { cwd: dir })
      writeFileSync(join(dir, 'file.txt'), 'changed\n')
      execSync('git add -A && git commit -m local', { cwd: dir })

      const result = await gitPush(dir, 'backup')
      expect(result.pushStatus).toBe('pushed')
      expect(result.remote).toBe('backup')
      expect(result.upstreamCreated).toBe(false)

      const backupBranches = execFileSync('git', ['--git-dir=' + backupBare, 'branch', '--format=%(refname:short)']).toString().trim()
      expect(backupBranches).toBe('main')
      const upstream = execSync('git rev-parse --abbrev-ref main@{upstream}', { cwd: dir }).toString().trim()
      expect(upstream).toBe('origin/main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(originBare, { recursive: true, force: true })
      rmSync(backupBare, { recursive: true, force: true })
    }
  })

  it('returns failed with raw git error and does not touch the local commit', async () => {
    const dir = createTestRepo()
    try {
      writeFileSync(join(dir, 'file.txt'), 'base\n')
      execSync('git add -A && git commit -m base', { cwd: dir })
      execSync('git remote add origin /nonexistent/path/to/remote.git', { cwd: dir })

      const headBefore = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()
      const result = await gitPush(dir, 'origin')
      expect(result.pushStatus).toBe('failed')
      expect(result.remote).toBe('origin')
      expect(result.upstreamCreated).toBe(false)
      expect(result.pushError).toBeTruthy()
      expect(result.pushError).not.toContain('Commit failed')

      const headAfter = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()
      expect(headAfter).toBe(headBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
