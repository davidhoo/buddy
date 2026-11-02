import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, symlinkSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  extraDiscoveryBinDirs,
  findAppBundledCli,
  inspectLaunchTarget,
  npmPrefixBin,
  preferShellOrExplicitInstall,
  withCompatibleRuntimeEnv
} from '../../../src/main/buddy/agents/discovery'
import { runFile } from '../../../src/main/buddy/agents/service'
import { refreshShellPath } from '../../../src/main/buddy/shell-path'

describe('bounded agent discovery dirs', () => {
  it('reads npm prefix bin from .npmrc without spawning npm', async () => {
    const home = await mkdtemp(join(tmpdir(), 'buddy-npmrc-'))
    try {
      const prefix = join(home, 'custom-prefix')
      await mkdir(join(prefix, 'bin'), { recursive: true })
      await writeFile(join(home, '.npmrc'), `prefix=${prefix}\n`)
      expect(npmPrefixBin(home)).toBe(join(prefix, 'bin'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('enumerates nvm/fnm/mise node bins with a hard cap', async () => {
    const home = await mkdtemp(join(tmpdir(), 'buddy-node-mgr-'))
    try {
      for (const ver of ['v18.0.0', 'v20.1.0', 'v22.2.0']) {
        await mkdir(join(home, '.nvm/versions/node', ver, 'bin'), { recursive: true })
        await mkdir(join(home, '.local/share/fnm/node-versions', ver, 'installation/bin'), { recursive: true })
        await mkdir(join(home, '.local/share/mise/installs/node', ver, 'bin'), { recursive: true })
      }
      await mkdir(join(home, '.npm-global/bin'), { recursive: true })
      const dirs = extraDiscoveryBinDirs(home)
      expect(dirs).toEqual(expect.arrayContaining([
        join(home, '.npm-global/bin'),
        join(home, '.nvm/versions/node/v22.2.0/bin'),
        join(home, '.local/share/fnm/node-versions/v22.2.0/installation/bin'),
        join(home, '.local/share/mise/installs/node/v22.2.0/bin')
      ]))
      expect(dirs.filter(d => d.includes('/.nvm/')).length).toBeLessThanOrEqual(8)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips extra discovery when caller already supplies dirs', () => {
    expect(extraDiscoveryBinDirs('/tmp/unused', { dirs: ['/tmp/only'] })).toEqual([])
  })
})

describe('app-bundled CLI discovery', () => {
  it('finds only declared relative CLI paths inside a temp app bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-app-cli-'))
    try {
      const app = join(root, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources')
      await mkdir(app, { recursive: true })
      const cli = join(app, 'dsh')
      await writeFile(cli, '#!/bin/sh\necho 1.0.0\n')
      chmodSync(cli, 0o755)
      expect(findAppBundledCli({
        appName: 'DeepSeek Harness',
        relativePaths: ['Contents/Resources/dsh', 'Contents/MacOS/dsh'],
        appRoots: [join(root, 'Applications')]
      })).toBe(cli)
      expect(findAppBundledCli({
        appName: 'DeepSeek Harness',
        relativePaths: ['Contents/MacOS/dsh'],
        appRoots: [join(root, 'Applications')]
      })).toBeUndefined()
      expect(findAppBundledCli({
        appName: 'DeepSeek Harness',
        relativePaths: ['../escape', 'Contents/Resources/../../etc/passwd'],
        appRoots: [join(root, 'Applications')]
      })).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('D2 shim / runtime consistency', () => {
  it('inspects a known asdf-style shim without executing it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'buddy-asdf-shim-'))
    try {
      const shims = join(home, '.asdf/shims')
      await mkdir(shims, { recursive: true })
      const shim = join(shims, 'qwen')
      await writeFile(shim, '#!/usr/bin/env bash\n# asdf-plugin: qwen\nexec asdf exec "qwen" "$@"\n')
      chmodSync(shim, 0o755)
      const info = inspectLaunchTarget(shim)
      expect(info.broken).toBeUndefined()
      expect(info.shim).toBe(true)
      expect(info.sourceHint).toBe('asdf')
      expect(info.entryPath).toBe(shim)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('pins off-PATH Node so version probe and task env use the sibling runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-runtime-'))
    try {
      const wrongBin = join(root, 'wrong node bin')
      const rightBin = join(root, 'right node bin')
      await mkdir(wrongBin, { recursive: true })
      await mkdir(rightBin, { recursive: true })
      const systemNode = process.execPath
      // Wrong node first on PATH — must not win once runtime env is applied.
      await writeFile(join(wrongBin, 'node'), `#!/bin/sh\necho WRONG_NODE\nexit 1\n`)
      chmodSync(join(wrongBin, 'node'), 0o755)
      symlinkSync(systemNode, join(rightBin, 'node'))
      const cli = join(rightBin, 'demo-agent')
      await writeFile(cli, '#!/usr/bin/env node\nprocess.stdout.write(process.execPath)\n')
      chmodSync(cli, 0o755)

      const env = withCompatibleRuntimeEnv(cli, { PATH: `${wrongBin}:/usr/bin` })
      expect(env.PATH?.split(':')[0]).toBe(rightBin)
      const out = await runFile(cli, [], 5000, { PATH: `${wrongBin}:/usr/bin` })
      expect(out).toBe(systemNode)
      expect(out).not.toContain('WRONG')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('supports two Node installs and paths with spaces without auto-picking newer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-two-node-'))
    try {
      const older = join(root, 'Node 18', 'bin')
      const newer = join(root, 'Node 22', 'bin')
      await mkdir(older, { recursive: true })
      await mkdir(newer, { recursive: true })
      symlinkSync(process.execPath, join(older, 'node'))
      symlinkSync(process.execPath, join(newer, 'node'))
      for (const bin of [older, newer]) {
        const cli = join(bin, 'agent-cli')
        await writeFile(cli, '#!/usr/bin/env node\nconsole.log("ok")\n')
        chmodSync(cli, 0o755)
      }
      const installs = [
        { path: join(older, 'agent-cli'), realPath: join(older, 'agent-cli'), version: '1.0.0' },
        { path: join(newer, 'agent-cli'), realPath: join(newer, 'agent-cli'), version: '9.9.9' }
      ]
      expect(preferShellOrExplicitInstall(installs, { shellPath: join(older, 'agent-cli') })?.path)
        .toBe(join(older, 'agent-cli'))
      expect(preferShellOrExplicitInstall(installs)?.path).toBe(join(older, 'agent-cli'))

      const spaced = inspectLaunchTarget(join(newer, 'agent-cli'))
      // macOS may realpath /var/folders → /private/var/folders
      expect(spaced.runtime?.binDir?.endsWith('/Node 22/bin')).toBe(true)
      expect(spaced.broken).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks broken symlinks and does not treat unknown scripts as product identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buddy-broken-'))
    try {
      const missing = join(root, 'missing-target')
      const link = join(root, 'broken-agent')
      symlinkSync(missing, link)
      expect(inspectLaunchTarget(link).broken).toBe(true)

      const marker = join(root, 'was-executed')
      const unknown = join(root, 'mystery')
      await writeFile(unknown, `#!/bin/sh\ntouch '${marker}'\necho hi\n`)
      chmodSync(unknown, 0o755)
      const info = inspectLaunchTarget(unknown)
      expect(info.shim).toBeUndefined()
      expect(info.sourceHint).toBeUndefined()
      // Inspection is read-only — must not execute unknown wrappers.
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps wrapper subcommand entry as the launch path (wecode-style)', () => {
    // Discovery stores the wrapper binary; argv carries the subcommand — runtime
    // pinning must key off the wrapper path, not invent a different executable.
    const env = withCompatibleRuntimeEnv('/usr/bin/env', { PATH: '/tmp' })
    expect(env.PATH?.startsWith('/usr/bin:')).toBe(true)
  })
})

describe('refreshShellPath', () => {
  it('keeps the previous PATH when the login shell returns nothing usable', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/previous/bin:/usr/bin',
      SHELL: '/bin/sh',
      HOME: tmpdir()
    }
    const result = refreshShellPath({
      platform: 'darwin',
      env,
      home: tmpdir(),
      timeoutMs: 1
    })
    // extractShellEnv may succeed with a real shell; when it does not yield PATH we keep previous.
    if (!result.ok) {
      expect(result.path).toBe('/previous/bin:/usr/bin')
      expect(result.error).toMatch(/PATH|shell/i)
      expect(env.PATH).toBe('/previous/bin:/usr/bin')
    } else {
      expect(result.path.length).toBeGreaterThan(0)
    }
  })
})
