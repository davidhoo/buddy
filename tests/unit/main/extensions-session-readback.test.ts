import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, lstat, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeGlobalSettings } from '../../../src/shared/defaults'
import { ExtensionService } from '../../../src/main/buddy/extensions/service'
import { readLibrary } from '../../../src/main/buddy/extensions/library-store'

const codexBin = '/opt/homebrew/bin/codex'
const skillName = 'buddy-session-readback'
const marker = 'buddy-session-body-7f3a'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!existsSync(codexBin))('isolated codex session readback', () => {
  it('puts a library-assigned skill into the model-visible session prompt', async () => {
    const setup = await assignedSkill()
    const prompt = await runCodex(codexBin, ['debug', 'prompt-input', '--', 'Reply with the marker only'], setup.env, setup.work, 15_000)
    expect(prompt.timedOut, 'prompt-input timed out').toBe(false)
    expect(prompt.code).toBe(0)
    expect(prompt.stdout.includes(skillName), 'skill name missing from session prompt').toBe(true)
    expect(prompt.stdout.includes('isolated session catalog check'), 'skill description missing from session prompt').toBe(true)
    expect(prompt.stdout.includes(marker), 'skill body was inlined into the session prompt').toBe(false)
    expect(prompt.stdout.includes(join(homedir(), '.codex')), 'session prompt referenced the desktop Codex home').toBe(false)
    expect((await lstat(setup.link)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(setup.link, 'SKILL.md'), 'utf8')).toContain(marker)
    expect((await readLibrary(setup.dataRoot)).items).toHaveLength(1)
  })
})

async function assignedSkill(): Promise<{ env: NodeJS.ProcessEnv; work: string; link: string; dataRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'buddy-session-'))
  roots.push(root)
  const home = join(root, 'home')
  const codexHome = join(root, 'codex')
  const dataRoot = join(root, 'data')
  const work = join(root, 'work')
  const skillDir = join(codexHome, 'skills', skillName)
  await mkdir(skillDir, { recursive: true })
  await mkdir(work, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: isolated session catalog check\n---\n\nMARKER ${marker}\n`)
  const service = new ExtensionService({
    dataRoot,
    homeDir: home,
    processEnv: {},
    readGlobalSettings: async () => normalizeGlobalSettings({
      launchers: {
        codex: { command: codexBin, timeout_seconds: 30, env: { HOME: home, CODEX_HOME: codexHome } }
      }
    })
  })
  const found = (await service.discover({ kind: 'skill', cwd: work })).found.find((item) => item.name === skillName && item.actor === 'codex')
  expect(found?.id).toBeTruthy()
  const imported = await service.apply({ action: 'import', kind: 'skill', instanceId: found!.id, cwd: work })
  expect(imported.results[0]?.code).toBe('imported')
  const link = join(codexHome, 'skills', skillName)
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  return {
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    work,
    link,
    dataRoot
  }
}

function runCodex(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const finish = (code: number | null) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      }
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('close', finish)
    child.on('error', () => finish(null))
  })
}
