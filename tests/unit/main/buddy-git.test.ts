import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getGitFileStatuses,
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

      const committed = execSync('git log -1 --pretty=%B', { cwd: dir }).toString()
      // Git adds a trailing newline
      expect(committed.trim()).toBe(message.trim())
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
