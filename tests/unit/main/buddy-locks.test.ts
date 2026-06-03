import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRunLock, removeRunLock } from '../../../src/main/buddy/locks'

describe('run locks', () => {
  it('creates and removes run lock files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-locks-'))
    const lockPath = await createRunLock(root, {
      workspace_key: 'abc123def456',
      task_id: 'demo',
      run_id: 'run_1',
      pid: 123
    })

    await expect(readFile(lockPath, 'utf8')).resolves.toContain('"app":"buddy"')

    await removeRunLock(lockPath)
    await expect(access(lockPath)).rejects.toThrow()
  })
})
