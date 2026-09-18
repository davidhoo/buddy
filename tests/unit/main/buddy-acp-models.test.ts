import { describe, expect, it, vi } from 'vitest'
import { applyAcpSessionModel, extractAcpSessionModels } from '../../../src/main/buddy/acp/models'

describe('extractAcpSessionModels', () => {
  it('reads the legacy session/new models field', () => {
    expect(extractAcpSessionModels({
      sessionId: 'sess_1',
      models: {
        currentModelId: 'sonnet-4.5',
        availableModels: [
          { modelId: 'opus-4.6', name: 'Opus 4.6' },
          { id: 'sonnet-4.5', name: 'Sonnet 4.5' }
        ]
      }
    })).toEqual({
      models: [
        { id: 'opus-4.6', name: 'Opus 4.6' },
        { id: 'sonnet-4.5', name: 'Sonnet 4.5' }
      ],
      currentModelId: 'sonnet-4.5',
      source: 'models'
    })
  })

  it('reads a config option whose category is model', () => {
    expect(extractAcpSessionModels({
      sessionId: 'sess_1',
      configOptions: [
        {
          configId: 'mode',
          category: 'mode',
          type: 'select',
          currentValue: 'code',
          options: [{ value: 'ask', name: 'Ask' }]
        },
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: { type: 'id', value: 'gpt-5.6' },
          options: [
            { value: 'gpt-5.6', name: 'GPT-5.6' },
            { value: 'gpt-5.5', name: 'GPT-5.5' }
          ]
        }
      ]
    })).toEqual({
      models: [
        { id: 'gpt-5.6', name: 'GPT-5.6' },
        { id: 'gpt-5.5', name: 'GPT-5.5' }
      ],
      currentModelId: 'gpt-5.6',
      modelConfigId: 'model',
      source: 'configOptions'
    })
  })

  it('returns an empty list when the session has no model selector', () => {
    expect(extractAcpSessionModels({ sessionId: 'sess_1' })).toEqual({
      models: [],
      source: 'none'
    })
  })
})

describe('applyAcpSessionModel', () => {
  it('uses session/set_model for the legacy models field', async () => {
    const client = {
      setSessionModel: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({})
    }

    await applyAcpSessionModel(client, 'sess_1', 'opus-4.6', {
      models: {
        currentModelId: 'sonnet-4.5',
        availableModels: [{ modelId: 'opus-4.6', name: 'Opus' }, { modelId: 'sonnet-4.5', name: 'Sonnet' }]
      }
    })

    expect(client.setSessionModel).toHaveBeenCalledWith('sess_1', 'opus-4.6')
    expect(client.setSessionConfigOption).not.toHaveBeenCalled()
  })

  it('uses session/set_config_option for a model config option', async () => {
    const client = {
      setSessionModel: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({})
    }

    await applyAcpSessionModel(client, 'sess_1', 'gpt-5.6', {
      configOptions: [{
        configId: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'gpt-5.5',
        options: [{ value: 'gpt-5.6', name: 'GPT-5.6' }]
      }]
    })

    expect(client.setSessionConfigOption).toHaveBeenCalledWith('sess_1', 'model', 'gpt-5.6')
    expect(client.setSessionModel).not.toHaveBeenCalled()
  })

  it('skips the round-trip when the advertised current model already matches', async () => {
    const client = {
      setSessionModel: vi.fn(),
      setSessionConfigOption: vi.fn()
    }

    await applyAcpSessionModel(client, 'sess_1', 'sonnet-4.5', {
      models: {
        currentModelId: 'sonnet-4.5',
        availableModels: [{ modelId: 'sonnet-4.5', name: 'Sonnet' }]
      }
    })

    expect(client.setSessionModel).not.toHaveBeenCalled()
    expect(client.setSessionConfigOption).not.toHaveBeenCalled()
  })
})
