import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempHome = join(tmpdir(), `buddy-test-model-detect-${process.pid}`)

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => tempHome
  }
})

describe('model-detect', () => {
  beforeEach(async () => {
    await mkdir(tempHome, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true })
  })

  it('reads model from opencode JSON config', async () => {
    const configDir = join(tempHome, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({
      model: 'wecode/ali-deepseek-v4-pro',
      provider: {}
    }))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('opencode')
    expect(model).toBe('wecode/ali-deepseek-v4-pro')
  })

  it('reads model from codex TOML config (quoted value)', async () => {
    const configDir = join(tempHome, '.codex')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.toml'), [
      'model_provider = "cpa"',
      'model = "gpt-5.5"',
      'disable_response_storage = true',
      '',
      '[model_providers.cpa]',
      'name = "wecode openai"'
    ].join('\n'))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('codex', 'codex -p --output-format stream-json')
    expect(model).toBe('gpt-5.5')
  })

  it('reads model from wecode config when command is `wecode codex`', async () => {
    // Set up ~/.codex/config.toml with stale model
    const codexDir = join(tempHome, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5.5"\n')

    // Set up ~/.wecode-cli/config.json with real model
    const wecodeDir = join(tempHome, '.wecode-cli')
    await mkdir(wecodeDir, { recursive: true })
    await writeFile(join(wecodeDir, 'config.json'), JSON.stringify({
      codex: { model: 'thudm-glm-5.2', forceModel: false },
      claude: { forceModel: true }
    }))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('codex', 'wecode codex --output-format stream-json')
    expect(model).toBe('thudm-glm-5.2')
  })

  it('falls back to codex config.toml when wecode config has no codex.model', async () => {
    const codexDir = join(tempHome, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5.5"\n')

    const wecodeDir = join(tempHome, '.wecode-cli')
    await mkdir(wecodeDir, { recursive: true })
    await writeFile(join(wecodeDir, 'config.json'), JSON.stringify({
      codex: { forceModel: false }
    }))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('codex', 'wecode codex')
    // wecode config exists but has no codex.model → undefined (not fallback to config.toml)
    expect(model).toBeUndefined()
  })

  it('returns undefined for wecode codex when wecode config does not exist', async () => {
    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('codex', 'wecode codex')
    expect(model).toBeUndefined()
  })

  it('uses codex config.toml when command is plain codex (no wecode)', async () => {
    const codexDir = join(tempHome, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5.5"\n')

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('codex', 'codex --output-format stream-json')
    expect(model).toBe('gpt-5.5')
  })

  it('uses codex config.toml when command is undefined', async () => {
    const codexDir = join(tempHome, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5.5"\n')

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('codex')
    expect(model).toBe('gpt-5.5')
  })
  it('reads default_model from kimi TOML config', async () => {
    const configDir = join(tempHome, '.kimi')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.toml'), [
      'default_model = "kimi-latest"',
      'default_thinking = false',
      'default_yolo = false'
    ].join('\n'))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('kimi')
    expect(model).toBe('kimi-latest')
  })

  it('prefers ~/.kimi-code/config.toml over legacy ~/.kimi for kimi', async () => {
    const codeDir = join(tempHome, '.kimi-code')
    await mkdir(codeDir, { recursive: true })
    await writeFile(join(codeDir, 'config.toml'), 'default_model = "kimi-code/k3"\n')
    const legacyDir = join(tempHome, '.kimi')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'config.toml'), 'default_model = "kimi-latest"\n')

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('kimi')
    expect(model).toBe('kimi-code/k3')
  })

  it('reads opencode model from -m command argument', async () => {
    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    expect(await detectModelFromConfig('opencode', 'opencode -m agnes/agnes-2.0-flash')).toBe('agnes/agnes-2.0-flash')
    expect(await detectModelFromConfig('opencode', 'opencode --model provider/kimi-k2.6')).toBe('provider/kimi-k2.6')
    expect(await detectModelFromConfig('opencode', 'opencode --model=provider/kimi-k2.6')).toBe('provider/kimi-k2.6')
  })

  it('detects model from -m override regardless of actor name (kimi via opencode launcher)', async () => {
    // actor is "kimi" but the launcher actually runs opencode with -m;
    // the runner invokes opencode with this model, so detection must match.
    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    expect(await detectModelFromConfig('kimi', 'opencode -m provider/kimi-k2.6')).toBe('provider/kimi-k2.6')
    // Without -m, a kimi actor on the opencode CLI reads opencode's config.
    const configDir = join(tempHome, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify({ model: 'wecode/ali-deepseek-v4-pro' }))
    expect(await detectModelFromConfig('kimi', 'opencode')).toBe('wecode/ali-deepseek-v4-pro')
  })

  it('detects model from codex -m command override', async () => {
    // Stale config.toml must NOT win over an explicit -m on the command line.
    const codexDir = join(tempHome, '.codex')
    await mkdir(codexDir, { recursive: true })
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt-5.5"\n')

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    expect(await detectModelFromConfig('codex', 'codex -m gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(await detectModelFromConfig('codex', 'codex --model gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(await detectModelFromConfig('codex', 'codex --model=gpt-5.6-luna')).toBe('gpt-5.6-luna')
  })

  it('returns undefined for unknown actor', async () => {
    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('unknown_actor')
    expect(model).toBeUndefined()
  })

  it('returns undefined when config file does not exist', async () => {
    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('opencode')
    expect(model).toBeUndefined()
  })

  it('returns undefined when model field is empty string', async () => {
    const configDir = join(tempHome, '.kimi')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.toml'), [
      'default_model = ""',
      'default_thinking = false'
    ].join('\n'))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('kimi')
    expect(model).toBeUndefined()
  })

  it('returns undefined for claude (no config fallback needed)', async () => {
    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    const model = await detectModelFromConfig('claude')
    expect(model).toBeUndefined()
  })

  it('reads the selected Claude model from ~/.claude/settings.json', async () => {
    const claudeDir = join(tempHome, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'sonnet[1m]'
    }))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    expect(await detectModelFromConfig('claude', 'claude')).toBe('sonnet[1m]')
  })

  it('prefers an explicit Claude --model launcher override', async () => {
    const claudeDir = join(tempHome, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'sonnet[1m]'
    }))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    expect(await detectModelFromConfig('claude', 'claude --model opus')).toBe('opus')
  })

  it('prefers Claude env.ANTHROPIC_MODEL over the model tier alias', async () => {
    // Real-world wecode/proxy setup: model field is a tier alias while
    // env.ANTHROPIC_MODEL is the actual model the SDK invokes.
    const claudeDir = join(tempHome, '.claude')
    await mkdir(claudeDir, { recursive: true })
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'sonnet[1m]',
      env: { ANTHROPIC_MODEL: 'weibo-glm-5.2' }
    }))

    const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
    expect(await detectModelFromConfig('claude', 'claude')).toBe('weibo-glm-5.2')
  })

  describe('WeCode Claude detection', () => {
    async function writeWecodeConfig(model: string) {
      const wecodeDir = join(tempHome, '.wecode-cli')
      await mkdir(wecodeDir, { recursive: true })
      await writeFile(join(wecodeDir, 'config.json'), JSON.stringify({
        env: { ANTHROPIC_MODEL: model }
      }))
    }

    async function writeClaudeConfig(model: string) {
      const claudeDir = join(tempHome, '.claude')
      await mkdir(claudeDir, { recursive: true })
      await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({
        model,
        env: { ANTHROPIC_MODEL: model }
      }))
    }

    it('1. reads model from wecode config when command is bare `wecode`', async () => {
      await writeWecodeConfig('weibo-glm-5.2[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'wecode')).toBe('weibo-glm-5.2[1m]')
    })

    it('2. ignores --dangerously-skip-permissions when detecting wecode', async () => {
      await writeWecodeConfig('weibo-glm-5.2[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'wecode --dangerously-skip-permissions')).toBe('weibo-glm-5.2[1m]')
    })

    it('3. wecode config wins over stale claude config', async () => {
      await writeClaudeConfig('stale-claude-model')
      await writeWecodeConfig('weibo-glm-5.2[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      const model = await detectModelFromConfig('claude', 'wecode')
      expect(model).toBe('weibo-glm-5.2[1m]')
      expect(model).not.toBe('stale-claude-model')
    })

    it('4. returns undefined when wecode config is missing (no fallback to claude)', async () => {
      // Stale claude config exists, but no wecode config — must NOT fall back.
      await writeClaudeConfig('stale-claude-model')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'wecode')).toBeUndefined()
    })

    it('5. detects wecode via absolute path', async () => {
      await writeWecodeConfig('weibo-glm-5.2[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', '/usr/local/bin/wecode')).toBe('weibo-glm-5.2[1m]')
    })

    it('5b. detects wecode via a quoted path with spaces', async () => {
      await writeWecodeConfig('weibo-glm-5.2[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', '"/path with spaces/wecode" --dangerously-skip-permissions')).toBe('weibo-glm-5.2[1m]')
    })

    it('6. command-line --model override wins over wecode config', async () => {
      await writeWecodeConfig('weibo-glm-5.2[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'wecode --model explicit-model')).toBe('explicit-model')
    })

    it('6b. command-line -m override wins over wecode config', async () => {
      await writeWecodeConfig('weibo-glm-5.2[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'wecode -m explicit-model')).toBe('explicit-model')
    })

    it('7. plain claude still reads ~/.claude/settings.json', async () => {
      await writeClaudeConfig('sonnet[1m]')
      // No wecode config — plain claude must keep working.
      await writeWecodeConfig('weibo-glm-5.2[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'claude')).toBe('sonnet[1m]')
    })

    it('7b. plain claude with absolute path still reads ~/.claude/settings.json', async () => {
      await writeClaudeConfig('sonnet[1m]')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', '/usr/local/bin/claude')).toBe('sonnet[1m]')
    })

    it('8. wecode codex does not enter the claude branch', async () => {
      // Set up both configs to prove the codex branch is taken, not claude's.
      await writeWecodeConfig('weibo-glm-5.2[1m]')
      const wecodeDir = join(tempHome, '.wecode-cli')
      await writeFile(join(wecodeDir, 'config.json'), JSON.stringify({
        env: { ANTHROPIC_MODEL: 'weibo-glm-5.2[1m]' },
        codex: { model: 'thudm-glm-5.2', forceModel: false }
      }))

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('codex', 'wecode codex')).toBe('thudm-glm-5.2')
    })

    it('returns undefined when wecode config has no env.ANTHROPIC_MODEL', async () => {
      const wecodeDir = join(tempHome, '.wecode-cli')
      await mkdir(wecodeDir, { recursive: true })
      await writeFile(join(wecodeDir, 'config.json'), JSON.stringify({ codex: { model: 'x' } }))

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'wecode')).toBeUndefined()
    })

    it('returns undefined when wecode config is malformed JSON', async () => {
      const wecodeDir = join(tempHome, '.wecode-cli')
      await mkdir(wecodeDir, { recursive: true })
      await writeFile(join(wecodeDir, 'config.json'), '{ not valid json')

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'wecode')).toBeUndefined()
    })

    it('returns undefined when ANTHROPIC_MODEL is empty string', async () => {
      const wecodeDir = join(tempHome, '.wecode-cli')
      await mkdir(wecodeDir, { recursive: true })
      await writeFile(join(wecodeDir, 'config.json'), JSON.stringify({
        env: { ANTHROPIC_MODEL: '' }
      }))

      const { detectModelFromConfig } = await import('../../../src/main/buddy/model-detect')
      expect(await detectModelFromConfig('claude', 'wecode')).toBeUndefined()
    })
  })
})
