import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = join(repoRoot, 'scripts/verify-release-signing.sh')
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('verify-release-signing.sh', () => {
  it('uses the artifact directory passed as the second argument', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'buddy-signing-artifacts-'))
    tempDirs.push(artifactDir)

    const result = spawnSync('bash', [script, '9.9.9', artifactDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CSC_NAME: 'Apple Development: Test User (TEAM)'
      }
    })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).toContain(join(artifactDir, 'mac-arm64/Buddy.app'))
    expect(output).not.toContain('release/mac-arm64/Buddy.app')
  })

  it('requires the exact Apple Development authority selected by CSC_NAME', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'buddy-signing-authority-'))
    const fakeBin = await mkdtemp(join(tmpdir(), 'buddy-signing-bin-'))
    tempDirs.push(artifactDir, fakeBin)
    await mkdir(join(artifactDir, 'mac-arm64/Buddy.app'), { recursive: true })
    await mkdir(join(artifactDir, 'mac/Buddy.app'), { recursive: true })

    const fakeCodesign = join(fakeBin, 'codesign')
    await writeFile(
      fakeCodesign,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "-dv" ]; then
  printf '%s\n' \
    'Identifier=com.buddy.app' \
    'Authority=Apple Development: Wrong User (WRONG)' \
    'TeamIdentifier=XLDSS978CT' >&2
fi
exit 0
`
    )
    await chmod(fakeCodesign, 0o755)

    const expectedAuthority = 'Apple Development: Test User (TEAM)'
    const result = spawnSync('bash', [script, '9.9.9', artifactDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CSC_NAME: expectedAuthority
      }
    })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).toContain(`Authority is not ${expectedAuthority}`)
  })

  it('can skip local build-output Apps when validating downloaded release assets', async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), 'buddy-signing-packaged-'))
    tempDirs.push(artifactDir)

    const result = spawnSync('bash', [script, '9.9.9', artifactDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CSC_NAME: 'Apple Development: Test User (TEAM)',
        VERIFY_BUILD_OUTPUTS: 'false'
      }
    })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).not.toBe(0)
    expect(output).not.toContain('mac-arm64/Buddy.app')
    expect(output).toContain('Buddy-9.9.9-arm64-mac.zip')
  })
})
