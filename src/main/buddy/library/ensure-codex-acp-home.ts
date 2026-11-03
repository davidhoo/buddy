/**
 * Config-page bootstrap for Codex ACP home.
 * Creates directory + missing bootstrap files + skills/rules symlinks.
 * Does NOT import sessions or touch SQLite.
 */
import { copyFile, lstat, mkdir, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buddyAcpCodexHome, codexHome } from './targets'

const bootstrapFiles = ['config.toml', 'AGENTS.md', 'AGENTS.override.md']

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch {
    return true
  }
}

export async function ensureCodexAcpHome(
  dataRoot: string,
  actor: string,
  sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex')
): Promise<{ home: string; mcpPath: string; skillsDir: string; notes: string[] }> {
  const home = buddyAcpCodexHome(dataRoot, actor)
  const notes: string[] = []
  await mkdir(home, { recursive: true, mode: 0o700 })
  for (const name of bootstrapFiles) {
    const dest = join(home, name)
    if (!(await missing(dest))) continue
    try {
      await copyFile(join(sourceHome, name), dest)
      notes.push(`copied ${name}`)
    } catch {
      if (name === 'config.toml') {
        await mkdir(home, { recursive: true })
        const { writeFile } = await import('node:fs/promises')
        await writeFile(dest, '# Created by Buddy library ensureCodexAcpHome\n', 'utf8')
        notes.push('created empty config.toml')
      }
    }
  }
  for (const name of ['skills', 'rules'] as const) {
    const dest = join(home, name)
    if (!(await missing(dest))) continue
    try {
      await symlink(join(sourceHome, name), dest)
      notes.push(`linked ${name} → native`)
    } catch (error) {
      notes.push(`could not link ${name}: ${(error as Error).message}`)
    }
  }
  notes.push('session import skipped; SQLite untouched')
  return {
    home,
    mcpPath: join(home, 'config.toml'),
    skillsDir: join(home, 'skills'),
    notes
  }
}

export { codexHome }
