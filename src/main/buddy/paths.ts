import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

export interface BuddyPaths {
  dataRoot: string
  globalSettings: string
  workspacesDir: string
  runtimeTasksDir: string
}

export function createBuddyPaths(dataRoot: string): BuddyPaths {
  return {
    dataRoot,
    globalSettings: join(dataRoot, 'global', 'settings.json'),
    workspacesDir: join(dataRoot, 'workspaces'),
    runtimeTasksDir: join(dataRoot, 'runtime', 'tasks')
  }
}

export function workspaceKeyForRepo(repoRoot: string): string {
  const root = resolve(repoRoot)
  const slug =
    (basename(root) || 'root')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 40) || 'workspace'
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 12)
  return `${slug}-${digest}`
}

export function workspaceDir(paths: BuddyPaths, workspaceKey: string): string {
  return join(paths.workspacesDir, workspaceKey)
}

export function taskDir(paths: BuddyPaths, workspaceKey: string, taskId: string): string {
  return join(workspaceDir(paths, workspaceKey), 'tasks', taskId)
}
