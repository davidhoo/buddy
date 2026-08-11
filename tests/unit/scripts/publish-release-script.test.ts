import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = join(repoRoot, 'scripts/publish-release.sh')
const tempDirs: string[] = []

interface Fixture {
  root: string
  binDir: string
  releaseDir: string
  eventLog: string
  verifier: string
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'buddy-release-publish-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const releaseDir = join(root, 'release')
  const eventLog = join(root, 'events.log')
  const verifier = join(root, 'verify-published-release.sh')
  await mkdir(binDir)
  await mkdir(releaseDir)

  for (const name of [
    'Buddy-9.9.9-arm64-mac.zip',
    'Buddy-9.9.9-mac.zip',
    'Buddy-9.9.9-arm64.dmg',
    'Buddy-9.9.9.dmg',
    'latest-mac.yml',
    'buddy-v9.9.9-source.tar.gz',
    'buddy-v9.9.9-source.zip'
  ]) {
    await writeFile(join(releaseDir, name), name === 'latest-mac.yml' ? 'verified-feed' : name)
  }

  const fakeGh = join(binDir, 'gh')
  await writeFile(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "$EVENT_LOG"
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  [ "\${GH_RELEASE_EXISTS:-1}" = "1" ]
  exit
fi
if [ "\${1:-}" = "api" ]; then
  printf '%s\n' "\${GH_LATEST_TAG:-v9.9.9}"
fi
`
  )
  await chmod(fakeGh, 0o755)

  const fakeCurl = join(binDir, 'curl')
  await writeFile(
    fakeCurl,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "$EVENT_LOG"
[ "\${CURL_FAIL:-0}" = "0" ] || exit 44
destination=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    destination="$2"
    break
  fi
  shift
done
if [ "\${FEED_MISMATCH:-0}" = "1" ]; then
  printf 'mismatched-feed' > "$destination"
else
  cp "$RELEASE_DIR/latest-mac.yml" "$destination"
fi
`
  )
  await chmod(fakeCurl, 0o755)

  await writeFile(
    verifier,
    `#!/usr/bin/env bash
printf 'verify %s\n' "$*" >> "$EVENT_LOG"
exit "\${VERIFY_EXIT_CODE:-0}"
`
  )
  await chmod(verifier, 0o755)

  return { root, binDir, releaseDir, eventLog, verifier }
}

function runScript(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [script, 'v9.9.9', 'owner/repo'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      EVENT_LOG: fixture.eventLog,
      RELEASE_DIR: fixture.releaseDir,
      VERIFY_PUBLISHED_RELEASE_SCRIPT: fixture.verifier,
      ...extraEnv
    }
  })
}

async function eventLines(fixture: Fixture): Promise<string[]> {
  return (await readFile(fixture.eventLog, 'utf8')).trim().split('\n')
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('publish-release.sh', () => {
  it('is the only publication path used by the official release script', async () => {
    const releaseScript = await readFile(join(repoRoot, 'scripts/release.sh'), 'utf8')

    expect(releaseScript).toContain('bash scripts/publish-release.sh "$VERSION" "$GITHUB_REPO"')
    expect(releaseScript).not.toContain('gh release upload')
    expect(releaseScript).not.toContain('gh release create')
  })

  it('creates a missing release as draft and publishes only after verification', async () => {
    const fixture = await makeFixture()

    const result = runScript(fixture, { GH_RELEASE_EXISTS: '0' })
    const events = await eventLines(fixture)

    expect(result.status).toBe(0)
    expect(events.some((line) => line.includes('release create v9.9.9') && line.includes('--draft'))).toBe(true)
    const verifyIndex = events.findIndex((line) => line.startsWith('verify '))
    const publishIndex = events.findIndex(
      (line) => line.includes('release edit v9.9.9') && line.includes('--draft=false --latest')
    )
    expect(verifyIndex).toBeGreaterThan(-1)
    expect(publishIndex).toBeGreaterThan(verifyIndex)
  })

  it('moves an existing release to draft before clobbering assets', async () => {
    const fixture = await makeFixture()

    const result = runScript(fixture)
    const events = await eventLines(fixture)

    expect(result.status).toBe(0)
    const draftIndex = events.findIndex(
      (line) => line.includes('release edit v9.9.9') && line.endsWith('--draft')
    )
    const uploadIndex = events.findIndex((line) => line.includes('release upload v9.9.9'))
    expect(draftIndex).toBeGreaterThan(-1)
    expect(uploadIndex).toBeGreaterThan(draftIndex)
  })

  it('uploads latest-mac.yml after every package and source archive', async () => {
    const fixture = await makeFixture()

    const result = runScript(fixture)
    const uploads = (await eventLines(fixture)).filter((line) => line.includes('release upload v9.9.9'))

    expect(result.status).toBe(0)
    expect(uploads).toHaveLength(7)
    expect(uploads.at(-1)).toContain('latest-mac.yml')
  })

  it('leaves the release draft when remote verification fails', async () => {
    const fixture = await makeFixture()

    const result = runScript(fixture, { VERIFY_EXIT_CODE: '23' })
    const events = await eventLines(fixture)

    expect(result.status).toBe(23)
    expect(events.some((line) => line.includes('--draft=false'))).toBe(false)
    expect(events.some((line) => line.endsWith('--draft'))).toBe(true)
  })

  it('returns a published release to draft when latest-feed validation fails', async () => {
    const fixture = await makeFixture()

    const result = runScript(fixture, { FEED_MISMATCH: '1' })
    const events = await eventLines(fixture)

    expect(result.status).not.toBe(0)
    const publishIndex = events.findIndex((line) => line.includes('--draft=false --latest'))
    const rollbackIndex = events.findLastIndex((line) => line.endsWith('--draft'))
    expect(publishIndex).toBeGreaterThan(-1)
    expect(rollbackIndex).toBeGreaterThan(publishIndex)
  })
})
