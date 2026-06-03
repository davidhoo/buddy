import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function createRunLock(dataRoot: string, input: {
  workspace_key: string
  task_id: string
  run_id: string
  pid: number
}): Promise<string> {
  const dir = join(dataRoot, 'runtime', 'tasks')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${input.workspace_key}__${input.task_id}.lock`)
  await writeFile(path, JSON.stringify({
    ...input,
    app: 'buddy',
    started_at: new Date().toISOString()
  }))
  return path
}

export async function removeRunLock(path: string): Promise<void> {
  await rm(path, { force: true })
}
