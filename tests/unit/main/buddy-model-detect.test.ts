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
})
