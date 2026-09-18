import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  findWecodePath,
  ensureWecodeCodexWrapper,
  prepareAcpEnvironment
} from '../../../src/main/buddy/acp'
import { KNOWN_ACP_PRESETS } from '../../../src/shared/defaults'

describe('WeCode ACP integration', () => {
  let source: string
  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), 'buddy-codex-source-'))
    vi.stubEnv('CODEX_HOME', source)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(source, { recursive: true, force: true })
  })
  it('registers wecode-claude-acp and wecode-codex-acp in KNOWN_ACP_PRESETS', () => {
    const claudePreset = KNOWN_ACP_PRESETS.find((p) => p.id === 'wecode-claude-acp')
    expect(claudePreset).toBeDefined()
    expect(claudePreset?.actor).toBe('wecode_claude')
    expect(claudePreset?.command).toBe('npx')
    expect(claudePreset?.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])

    const codexPreset = KNOWN_ACP_PRESETS.find((p) => p.id === 'wecode-codex-acp')
    expect(codexPreset).toBeDefined()
    expect(codexPreset?.actor).toBe('wecode_codex')
    expect(codexPreset?.command).toBe('npx')
    expect(codexPreset?.args).toEqual(['-y', '@agentclientprotocol/codex-acp'])

    const opencodePreset = KNOWN_ACP_PRESETS.find((p) => p.id === 'opencode-acp')
    expect(opencodePreset).toBeDefined()
    expect(opencodePreset?.actor).toBe('opencode')
    expect(opencodePreset?.command).toBe('opencode')
    expect(opencodePreset?.args).toEqual(['acp'])

    const wecodeOpencodePreset = KNOWN_ACP_PRESETS.find((p) => p.id === 'wecode-opencode-acp')
    expect(wecodeOpencodePreset).toBeDefined()
    expect(wecodeOpencodePreset?.actor).toBe('wecode_opencode')
    expect(wecodeOpencodePreset?.command).toBe('wecode')
    expect(wecodeOpencodePreset?.args).toEqual(['opencode', 'acp'])
  })

  it('correctly resolves defaultAcpArgs without duplicating command tokens', async () => {
    const { defaultAcpArgs } = await import('../../../src/main/buddy/acp')
    // When command is 'wecode opencode', it shouldn't duplicate 'opencode'
    expect(defaultAcpArgs('wecode opencode', 'wecode_opencode')).toEqual(['acp'])
    // When command is bare 'wecode'
    expect(defaultAcpArgs('wecode', 'wecode_opencode')).toEqual(['opencode', 'acp'])
    // When command is bare 'opencode'
    expect(defaultAcpArgs('opencode', 'opencode')).toEqual(['acp'])
    // When command is cursor-agent
    expect(defaultAcpArgs('cursor-agent', 'cursor')).toEqual(['acp'])
    // When command already has 'acp'
    expect(defaultAcpArgs('cursor-agent acp', 'cursor')).toEqual([])
  })

  it('finds or falls back to a valid wecode path', () => {
    const p = findWecodePath()
    expect(typeof p).toBe('string')
    expect(p.length).toBeGreaterThan(0)
  })

  it('generates an executable wecode-codex wrapper', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'buddy-acp-wrapper-test-'))
    try {
      const wrapperPath = await ensureWecodeCodexWrapper(testDir)
      expect(wrapperPath).toBe(join(testDir, 'bin', 'wecode-codex'))

      const content = await readFile(wrapperPath, 'utf8')
      expect(content).toContain('#!/bin/bash')
      expect(content).toContain('exec "$WECODE_BIN" codex "$@"')

      const stats = await stat(wrapperPath)
      // Check executable bits (mode & 0o111 != 0)
      expect(stats.mode & 0o111).not.toBe(0)
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('prepares ACP environment for wecode_claude', async () => {
    const env = await prepareAcpEnvironment('wecode_claude', { CUSTOM_VAR: '123' })
    expect(env.CUSTOM_VAR).toBe('123')
    expect(env.CLAUDE_CODE_EXECUTABLE).toBeDefined()
    expect(env.CLAUDE_CODE_EXECUTABLE.length).toBeGreaterThan(0)

    // Preserves existing CLAUDE_CODE_EXECUTABLE
    const customEnv = await prepareAcpEnvironment('wecode_claude', {
      CLAUDE_CODE_EXECUTABLE: '/custom/path/wecode'
    })
    expect(customEnv.CLAUDE_CODE_EXECUTABLE).toBe('/custom/path/wecode')
  })

  it('prepares ACP environment for wecode_codex', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'buddy-acp-env-test-'))
    try {
      const env = await prepareAcpEnvironment('wecode_codex', { CUSTOM_VAR: 'abc' }, testDir)
      expect(env.CUSTOM_VAR).toBe('abc')
      expect(env.BUDDY_CODEX_EXECUTABLE).toBe(join(testDir, 'bin', 'wecode-codex'))
      expect(env.CODEX_PATH).toBe(join(testDir, 'bin', 'buddy-codex-acp'))

      // Preserves existing CODEX_PATH
      const customEnv = await prepareAcpEnvironment(
        'wecode_codex',
        { CODEX_PATH: '/my/custom/wrapper' },
        testDir
      )
      expect(customEnv.BUDDY_CODEX_EXECUTABLE).toBe('/my/custom/wrapper')
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('does not inject wecode environment variables for standard actors', async () => {
    const claudeEnv = await prepareAcpEnvironment('claude', { FOO: 'bar' })
    expect(claudeEnv.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
    expect(claudeEnv.CODEX_PATH).toBeUndefined()

    const codexEnv = await prepareAcpEnvironment('codex', { FOO: 'bar' }, source)
    expect(codexEnv.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
    expect(codexEnv.CODEX_PATH).toBe(join(source, 'bin', 'buddy-codex-acp'))
    expect(codexEnv.BUDDY_CODEX_EXECUTABLE).toBe(process.env.CODEX_PATH || 'codex')
  })
})
