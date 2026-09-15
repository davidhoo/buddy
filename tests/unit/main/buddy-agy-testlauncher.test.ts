import { describe, expect, it } from 'vitest'
import { BuddyCoreService } from '../../../src/main/buddy/service'
import { buildLauncherCommand, commandKindFor } from '../../../src/main/buddy/launchers'

describe('agy settings testLauncher regression', () => {
  it('commandKindFor(agy) never falls to contract for default command', () => {
    expect(commandKindFor('agy', 'agy')).toBe('native_agy')
    expect(commandKindFor('agy', '')).toBe('native_agy')
    const cmd = buildLauncherCommand({
      actor: 'agy',
      command: 'agy',
      promptFile: '/tmp/p.md',
      promptText: 'hi',
      timeoutSeconds: 120
    })
    expect(cmd.args).not.toContain('--actor')
    expect(cmd.args).toContain('--print-timeout=120s')
  })

  it('testLauncher ping path does not pass --actor to agy and succeeds with fake CLI', async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'buddy-agy-fake-'))
    const fakeScript = join(root, 'fake-agy.sh')
    const scriptContent = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      '  exit 0',
      'fi',
      'for arg in "$@"; do',
      '  if [ "$arg" = "--actor" ]; then',
      '    echo "flags provided but not defined: -actor" >&2',
      '    exit 1',
      '  fi',
      'done',
      'printf \'{"event":"result","result":{"status":"SUCCESS","response":"Hello from Buddy ping test"}}\\n\'',
      'exit 0\n'
    ].join('\n')
    await writeFile(fakeScript, scriptContent)
    await chmod(fakeScript, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const result = await service.testLauncher('agy', fakeScript)
      expect(result.success).toBe(true)
      expect(result.responsePreview).toBe('Hello from Buddy ping test')
      expect(result.error).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('formats signal termination properly instead of code null', async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'buddy-agy-signal-'))
    const fakeScript = join(root, 'fake-agy.sh')
    await writeFile(fakeScript, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nkill -TERM $$\n')
    await chmod(fakeScript, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const result = await service.testLauncher('agy', fakeScript)
      expect(result.success).toBe(false)
      expect(result.error).toContain('SIGTERM')
      expect(result.error).not.toContain('code null')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('formats non-zero exit with stderr properly without code null', async () => {
    const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'buddy-agy-nonzero-'))
    const fakeScript = join(root, 'fake-agy.sh')
    await writeFile(
      fakeScript,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\necho "Authentication error: credentials expired" >&2\nexit 1\n'
    )
    await chmod(fakeScript, 0o755)

    try {
      const service = new BuddyCoreService({ dataRoot: join(root, 'data') })
      const result = await service.testLauncher('agy', fakeScript)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Authentication error: credentials expired')
      expect(result.error).not.toContain('code null')
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
