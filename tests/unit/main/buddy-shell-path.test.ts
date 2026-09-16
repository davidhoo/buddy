import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyShellProxyEnv,
  discoverUserBinDirs,
  envScriptFor,
  extractShellEnv,
  loginShellArgs,
  mergeChildEnv,
  mergePathEntries,
  parseShellEnvOutput,
  PROXY_PAIRS,
  PROXY_VARS,
  resolveProxyPairs,
  resolveUserShell,
  shellKind
} from '../../../src/main/buddy/shell-path'

describe('shell-path proxy detection and environment merging', () => {
  let tempDir: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'buddy-shell-test-'))
  })

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      tempDir = undefined
    }
  })

  it('defines all expected proxy variable names and pairs', () => {
    expect(PROXY_VARS).toContain('http_proxy')
    expect(PROXY_VARS).toContain('https_proxy')
    expect(PROXY_VARS).toContain('all_proxy')
    expect(PROXY_VARS).toContain('no_proxy')
    expect(PROXY_VARS).toContain('HTTP_PROXY')
    expect(PROXY_VARS).toContain('HTTPS_PROXY')
    expect(PROXY_VARS).toContain('ALL_PROXY')
    expect(PROXY_VARS).toContain('NO_PROXY')

    expect(PROXY_PAIRS).toEqual([
      ['http_proxy', 'HTTP_PROXY'],
      ['https_proxy', 'HTTPS_PROXY'],
      ['all_proxy', 'ALL_PROXY'],
      ['no_proxy', 'NO_PROXY']
    ])
  })

  describe('real login shell extraction', () => {
    it('extracts custom PATH and proxy variables from a simulated .zshrc in login shell', async () => {
      if (process.platform !== 'darwin') return

      const zdotdir = join(tempDir!, 'zsh-home')
      await mkdir(zdotdir, { recursive: true })
      const customPath = '/custom/isolated/test/bin'
      const customHttpProxy = 'http://127.0.0.1:9876'
      const customNoProxy = 'localhost,127.0.0.1,.local'

      const zshrc = [
        `export PATH="${customPath}:$PATH"`,
        `export http_proxy="${customHttpProxy}"`,
        `export NO_PROXY="${customNoProxy}"`,
        `# Unset others`,
        `unset https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy`
      ].join('\n')
      await writeFile(join(zdotdir, '.zshrc'), zshrc)

      // Controlled parent environment WITHOUT these custom variables
      const isolatedEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: zdotdir,
        ZDOTDIR: zdotdir,
        USER: process.env.USER ?? 'testuser'
      }

      const extracted = extractShellEnv('/bin/zsh', { env: isolatedEnv, timeoutMs: 5000 })
      expect(extracted.path).toBeDefined()
      expect(extracted.path).toContain(customPath)
      expect(extracted.proxyEnv.http_proxy).toBe(customHttpProxy)
      expect(extracted.proxyEnv.NO_PROXY).toBe(customNoProxy)
      expect(extracted.proxyEnv.https_proxy).toBeUndefined()
    })

    it('extracts custom PATH from bash login rc, not zsh', async () => {
      if (!existsSync('/bin/bash')) return

      const bashHome = join(tempDir!, 'bash-home')
      await mkdir(bashHome, { recursive: true })
      const customPath = '/custom/bash/login/bin'
      await writeFile(join(bashHome, '.bash_profile'), [
        `export PATH="${customPath}:$PATH"`,
        'export http_proxy="http://127.0.0.1:9555"',
        'unset https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY'
      ].join('\n'))

      const extracted = extractShellEnv('/bin/bash', {
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: bashHome,
          USER: process.env.USER ?? 'testuser'
        },
        timeoutMs: 5000
      })
      expect(extracted.path).toContain(customPath)
      expect(extracted.proxyEnv.http_proxy).toBe('http://127.0.0.1:9555')
    })
  })

  describe('user shell resolution', () => {
    it('prefers $SHELL, then the account login shell, then the OS default', () => {
      expect(resolveUserShell({ SHELL: '/opt/homebrew/bin/fish' })).toBe('/opt/homebrew/bin/fish')
      expect(resolveUserShell({ SHELL: '  /bin/bash  ' })).toBe('/bin/bash')
      expect(resolveUserShell({}, { loginShell: '/usr/local/bin/fish' })).toBe('/usr/local/bin/fish')
      expect(resolveUserShell({}, { loginShell: '' })).toBe(process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
    })

    it('classifies shells and uses POSIX vs fish vs csh scripts', () => {
      expect(shellKind('/bin/zsh')).toBe('posix')
      expect(shellKind('/bin/bash')).toBe('posix')
      expect(shellKind('/opt/homebrew/bin/fish')).toBe('fish')
      expect(shellKind('/bin/tcsh')).toBe('csh')
      expect(envScriptFor('posix')).toContain('${PATH+x}')
      expect(envScriptFor('fish')).toContain('string join : $PATH')
      expect(envScriptFor('csh')).toContain('$?PATH')
      expect(loginShellArgs('posix', 'true')).toEqual(['-il', '-c', 'true'])
      expect(loginShellArgs('fish', 'true')).toEqual(['-il', '-c', 'true'])
      expect(loginShellArgs('csh', 'true')).toEqual(['-l', '-c', 'true'])
    })
  })

  describe('PATH handling', () => {
    it('preserves paths containing spaces and merges extras without duplicate entries', () => {
      const spacePath = '/Users/test user/Special Tools/bin'
      const basePath = `/usr/bin:/bin:${spacePath}:/opt/homebrew/bin`
      const extras = ['/opt/homebrew/bin', '/usr/local/bin', spacePath]

      const merged = mergePathEntries(basePath, extras)
      const parts = merged.split(':')

      expect(parts).toContain(spacePath)
      expect(parts).toContain('/opt/homebrew/bin')
      expect(parts).toContain('/usr/local/bin')
      expect(parts).toContain('/usr/bin')

      // No duplicate entries
      const spaceCount = parts.filter((p) => p === spacePath).length
      expect(spaceCount).toBe(1)
      const homebrewCount = parts.filter((p) => p === '/opt/homebrew/bin').length
      expect(homebrewCount).toBe(1)
    })

    it('prefers login-shell PATH over discovered fallbacks when merging that way', () => {
      const shellPath = '/Users/me/.wecode-cli/bin:/usr/bin:/bin'
      const fallbacks = ['/opt/homebrew/bin', '/Users/me/.wecode-cli/bin', '/Users/me/.local/bin']
      const merged = mergePathEntries(fallbacks.join(':'), shellPath.split(':'))
      expect(merged.split(':')).toEqual([
        '/Users/me/.wecode-cli/bin',
        '/usr/bin',
        '/bin',
        '/opt/homebrew/bin',
        '/Users/me/.local/bin'
      ])
    })

    it('preserves original PATH when shell extraction fails', () => {
      const originalPath = '/original/unique/path:/usr/bin'
      const merged = mergePathEntries(originalPath, ['/opt/homebrew/bin'])
      expect(merged).toContain('/original/unique/path')
      expect(merged).toContain('/opt/homebrew/bin')
    })
  })

  describe('output parsing', () => {
    it('filters shell startup noise, non-whitelisted keys, and preserves valid empty and special characters', () => {
      const rawOutput = [
        'Last login: Tue Sep 15 10:00:00 2026 on ttys001',
        'Welcome to custom zsh banner!',
        '__BUDDY_ENV__:PATH=/usr/local/bin:/usr/bin with spaces',
        '__BUDDY_ENV__:http_proxy=http://user:p%40ss_word@127.0.0.1:7893/?query=1&flag=true',
        '__BUDDY_ENV__:https_proxy=',
        '__BUDDY_ENV__:NO_PROXY=localhost,127.0.0.1',
        '__BUDDY_ENV__:MALICIOUS_VAR=should_be_ignored',
        '__BUDDY_ENV__:OTHER_ENV=ignored',
        'some other trailing noise'
      ].join('\n')

      const { path, proxyEnv } = parseShellEnvOutput(rawOutput)
      expect(path).toBe('/usr/local/bin:/usr/bin with spaces')
      expect(proxyEnv.http_proxy).toBe('http://user:p%40ss_word@127.0.0.1:7893/?query=1&flag=true')
      expect(proxyEnv.https_proxy).toBe('') // explicit empty preserved!
      expect(proxyEnv.NO_PROXY).toBe('localhost,127.0.0.1')
      expect(proxyEnv.all_proxy).toBeUndefined() // unset variable absent
      expect((proxyEnv as Record<string, string>).MALICIOUS_VAR).toBeUndefined()
      expect((proxyEnv as Record<string, string>).OTHER_ENV).toBeUndefined()
    })

    it('recovers PATH when OSC/CSI decorations share the marker line', () => {
      const osc = '\u001b]1337;RemoteHost=david@host\u0007\u001b]1337;CurrentDir=/tmp\u0007'
      const csi = '\u001b[32m'
      const rawOutput = [
        `${osc}${csi}__BUDDY_ENV__:PATH=/Users/me/.wecode-cli/bin:/usr/bin`,
        `${osc}__BUDDY_ENV__:http_proxy=http://127.0.0.1:7893`
      ].join('\n')

      const { path, proxyEnv } = parseShellEnvOutput(rawOutput)
      expect(path).toBe('/Users/me/.wecode-cli/bin:/usr/bin')
      expect(proxyEnv.http_proxy).toBe('http://127.0.0.1:7893')
    })
  })

  describe('generic user bin discovery', () => {
    it('picks existing ~/bin and $HOME/.<name>/bin without hardcoding tool names', async () => {
      const home = join(tempDir!, 'home')
      const wecodeBin = join(home, '.wecode-cli', 'bin')
      const kimiBin = join(home, '.kimi-code', 'bin')
      const userBin = join(home, 'bin')
      const noBinDir = join(home, '.ssh')
      const strayFile = join(home, '.zshrc')
      await mkdir(wecodeBin, { recursive: true })
      await mkdir(kimiBin, { recursive: true })
      await mkdir(userBin, { recursive: true })
      await mkdir(noBinDir, { recursive: true })
      await writeFile(strayFile, '')

      const systemBin = join(tempDir!, 'opt-bin')
      await mkdir(systemBin, { recursive: true })

      const discovered = discoverUserBinDirs(home, [systemBin, join(tempDir!, 'missing-bin')])
      expect(discovered).toEqual(expect.arrayContaining([wecodeBin, kimiBin, userBin, systemBin]))
      expect(discovered).not.toContain(noBinDir)
      expect(discovered.some((dir) => dir.includes('missing-bin'))).toBe(false)
    })
  })

  describe('proxy source priority and pair resolution', () => {
    it('mirrors to uppercase when only lowercase is provided', () => {
      const resolved = resolveProxyPairs([{ http_proxy: 'http://127.0.0.1:7893' }])
      expect(resolved.http_proxy).toBe('http://127.0.0.1:7893')
      expect(resolved.HTTP_PROXY).toBe('http://127.0.0.1:7893')
    })

    it('mirrors to lowercase when only uppercase is provided', () => {
      const resolved = resolveProxyPairs([{ HTTPS_PROXY: 'http://127.0.0.1:8443' }])
      expect(resolved.https_proxy).toBe('http://127.0.0.1:8443')
      expect(resolved.HTTPS_PROXY).toBe('http://127.0.0.1:8443')
    })

    it('prioritizes Buddy existing environment over login shell', () => {
      const buddyEnv = {
        http_proxy: 'http://buddy-env:1111'
      }
      const shellEnv = {
        http_proxy: 'http://shell-env:2222',
        HTTP_PROXY: 'http://shell-env:2222',
        https_proxy: 'http://shell-env:3333'
      }

      const resolved = resolveProxyPairs([buddyEnv, shellEnv])
      // http_proxy was defined in buddyEnv, so shellEnv's values for that pair are ignored
      expect(resolved.http_proxy).toBe('http://buddy-env:1111')
      expect(resolved.HTTP_PROXY).toBe('http://buddy-env:1111')
      // https_proxy was not in buddyEnv, so shellEnv is used
      expect(resolved.https_proxy).toBe('http://shell-env:3333')
      expect(resolved.HTTPS_PROXY).toBe('http://shell-env:3333')
    })

    it('treats explicit empty string as intentional clear and does not fall back', () => {
      const highSource = {
        http_proxy: ''
      }
      const lowSource = {
        http_proxy: 'http://low-proxy:7893',
        HTTP_PROXY: 'http://low-proxy:7893'
      }

      const resolved = resolveProxyPairs([highSource, lowSource])
      expect(resolved.http_proxy).toBe('')
      expect(resolved.HTTP_PROXY).toBe('')
    })

    it('preserves conflicting dual values when explicitly provided in the same source', () => {
      const singleSource = {
        http_proxy: 'http://lower-val:1111',
        HTTP_PROXY: 'http://upper-val:2222'
      }

      const resolved = resolveProxyPairs([singleSource])
      expect(resolved.http_proxy).toBe('http://lower-val:1111')
      expect(resolved.HTTP_PROXY).toBe('http://upper-val:2222')
    })

    it('applyShellProxyEnv applies resolved shell proxy to target object', () => {
      const target: Record<string, string | undefined> = {
        existing_var: 'val'
      }
      applyShellProxyEnv(target, {
        http_proxy: 'http://127.0.0.1:7893'
      })
      expect(target.existing_var).toBe('val')
      expect(target.http_proxy).toBe('http://127.0.0.1:7893')
      expect(target.HTTP_PROXY).toBe('http://127.0.0.1:7893')
    })
  })

  describe('child launcher environment merging (mergeChildEnv)', () => {
    it('ensures launcher explicit override overrides both cases in child env, preventing global leak', () => {
      const baseEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/bin',
        http_proxy: 'http://global-proxy:7893',
        HTTP_PROXY: 'http://global-proxy:7893',
        https_proxy: 'http://global-proxy:7893',
        HTTPS_PROXY: 'http://global-proxy:7893',
        OTHER_VAR: 'keep-me'
      }

      const launcherEnv = {
        http_proxy: 'http://launcher-custom:8080'
      }

      const childEnv = mergeChildEnv(baseEnv, launcherEnv)

      // Both http_proxy and HTTP_PROXY reflect the launcher's custom setting
      expect(childEnv.http_proxy).toBe('http://launcher-custom:8080')
      expect(childEnv.HTTP_PROXY).toBe('http://launcher-custom:8080')

      // https_proxy falls back to baseEnv
      expect(childEnv.https_proxy).toBe('http://global-proxy:7893')
      expect(childEnv.HTTPS_PROXY).toBe('http://global-proxy:7893')

      // Non-proxy env preserved
      expect(childEnv.OTHER_VAR).toBe('keep-me')
    })

    it('supports explicitly clearing proxy in launcherEnv', () => {
      const baseEnv: NodeJS.ProcessEnv = {
        http_proxy: 'http://global:7893',
        HTTP_PROXY: 'http://global:7893'
      }

      const launcherEnv = {
        http_proxy: ''
      }

      const childEnv = mergeChildEnv(baseEnv, launcherEnv)
      expect(childEnv.http_proxy).toBe('')
      expect(childEnv.HTTP_PROXY).toBe('')
    })
  })
})
