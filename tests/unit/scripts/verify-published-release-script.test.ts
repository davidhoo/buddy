import { spawnSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = join(repoRoot, 'scripts/verify-published-release.sh')
const tempDirs: string[] = []

interface Fixture {
  root: string
  binDir: string
  remoteDir: string
  ghLog: string
  verifyLog: string
  verifier: string
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'buddy-published-verify-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const remoteDir = join(root, 'remote')
  const ghLog = join(root, 'gh.log')
  const verifyLog = join(root, 'verify.log')
  const verifier = join(root, 'verify-release-signing.sh')
  await mkdir(binDir)
  await mkdir(remoteDir)

  for (const name of [
    'Buddy-9.9.9-arm64-mac.zip',
    'Buddy-9.9.9-mac.zip',
    'Buddy-9.9.9-arm64.dmg',
    'Buddy-9.9.9.dmg',
    'latest-mac.yml'
  ]) {
    await writeFile(join(remoteDir, name), name)
  }

  const fakeGh = join(binDir, 'gh')
  await writeFile(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
if [ "\${GH_DOWNLOAD_FAIL:-0}" = "1" ]; then
  exit 42
fi
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "download" ]; then
  destination=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--dir" ]; then
      destination="$2"
      break
    fi
    shift
  done
  cp "$GH_REMOTE_DIR"/* "$destination/"
fi
`
  )
  await chmod(fakeGh, 0o755)

  await writeFile(
    verifier,
    `#!/usr/bin/env bash
printf '%s\n' "$*" > "$VERIFY_LOG"
exit "\${VERIFY_EXIT_CODE:-0}"
`
  )
  await chmod(verifier, 0o755)

  return { root, binDir, remoteDir, ghLog, verifyLog, verifier }
}

function runScript(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [script, 'v9.9.9', 'owner/repo'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      GH_LOG: fixture.ghLog,
      GH_REMOTE_DIR: fixture.remoteDir,
      VERIFY_LOG: fixture.verifyLog,
      VERIFY_RELEASE_SIGNING_SCRIPT: fixture.verifier,
      ...extraEnv
    }
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('verify-published-release.sh', () => {
  it('downloads all five tagged assets and passes their directory to the verifier', async () => {
    const fixture = await makeFixture()

    const result = runScript(fixture)

    expect(result.status).toBe(0)
    const ghLog = await readFile(fixture.ghLog, 'utf8')
    expect(ghLog).toContain('release download v9.9.9')
    expect(ghLog).toContain('--repo owner/repo')
    for (const name of [
      'Buddy-9.9.9-arm64-mac.zip',
      'Buddy-9.9.9-mac.zip',
      'Buddy-9.9.9-arm64.dmg',
      'Buddy-9.9.9.dmg',
      'latest-mac.yml'
    ]) {
      expect(ghLog).toContain(name)
    }

    const verifyArgs = (await readFile(fixture.verifyLog, 'utf8')).trim().split(' ')
    expect(verifyArgs[0]).toBe('9.9.9')
    expect(verifyArgs.slice(1).join(' ')).toContain('buddy-release-verify.')
  })

  it('fails before verification when GitHub download fails', async () => {
    const fixture = await makeFixture()

    const result = runScript(fixture, { GH_DOWNLOAD_FAIL: '1' })

    expect(result.status).toBe(42)
    await expect(access(fixture.verifyLog)).rejects.toThrow()
  })

  it('fails when downloaded artifact verification fails', async () => {
    const fixture = await makeFixture()

    const result = runScript(fixture, { VERIFY_EXIT_CODE: '23' })

    expect(result.status).toBe(23)
  })
})
