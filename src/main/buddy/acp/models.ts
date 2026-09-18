import { tmpdir } from 'node:os'
import type { AcpModelInfo, AcpModelList } from '../../../shared/types'
import { AcpClient } from './client'
import { AcpStdioTransport } from './transport'
import type { AcpNewSessionResult } from './types'

export interface ExtractedAcpModels extends AcpModelList {
  modelConfigId?: string
  source: 'models' | 'configOptions' | 'none'
}

const MODEL_CATEGORY = 'model'

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function configValueId(value: unknown): string | undefined {
  const direct = textValue(value)
  if (direct) return direct
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return textValue(record.value) ?? textValue(record.id)
}

function optionId(option: unknown): string | undefined {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return undefined
  const record = option as Record<string, unknown>
  return textValue(record.value) ?? textValue(record.modelId) ?? textValue(record.id)
}

function optionName(option: unknown, fallback: string): string {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return fallback
  const record = option as Record<string, unknown>
  return textValue(record.name) ?? textValue(record.title) ?? fallback
}

function isModelConfigOption(option: Record<string, unknown>): boolean {
  const category = textValue(option.category)?.toLowerCase()
  if (category === MODEL_CATEGORY) return true
  const id = textValue(option.configId) ?? textValue(option.id)
  if (id?.toLowerCase() === MODEL_CATEGORY) return true
  const name = textValue(option.name)?.toLowerCase()
  return option.type === 'select' && name === MODEL_CATEGORY
}

function uniqueModels(models: AcpModelInfo[]): AcpModelInfo[] {
  const seen = new Set<string>()
  const result: AcpModelInfo[] = []
  for (const model of models) {
    if (!model.id || seen.has(model.id)) continue
    seen.add(model.id)
    result.push(model)
  }
  return result
}

export function extractAcpSessionModels(session: unknown): ExtractedAcpModels {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { models: [], source: 'none' }
  }
  const record = session as Record<string, unknown>

  const legacy = record.models
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    const modelsRecord = legacy as Record<string, unknown>
    const available = Array.isArray(modelsRecord.availableModels) ? modelsRecord.availableModels : []
    const models = uniqueModels(
      available.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const info = item as Record<string, unknown>
        const id = textValue(info.modelId) ?? textValue(info.id) ?? textValue(info.value)
        if (!id) return []
        return [{ id, name: textValue(info.name) ?? id }]
      })
    )
    if (models.length > 0) {
      return {
        models,
        currentModelId: textValue(modelsRecord.currentModelId),
        source: 'models'
      }
    }
  }

  const configOptions = Array.isArray(record.configOptions) ? record.configOptions : []
  for (const raw of configOptions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const option = raw as Record<string, unknown>
    if (!isModelConfigOption(option)) continue
    const choices = Array.isArray(option.options) ? option.options : []
    const models = uniqueModels(
      choices.flatMap((item) => {
        const id = optionId(item)
        if (!id) return []
        return [{ id, name: optionName(item, id) }]
      })
    )
    if (models.length === 0) continue
    return {
      models,
      currentModelId: configValueId(option.currentValue),
      modelConfigId: textValue(option.configId) ?? textValue(option.id) ?? MODEL_CATEGORY,
      source: 'configOptions'
    }
  }

  return { models: [], source: 'none' }
}

export async function applyAcpSessionModel(
  client: Pick<AcpClient, 'setSessionModel' | 'setSessionConfigOption'>,
  sessionId: string,
  modelId: string,
  session: unknown
): Promise<void> {
  const trimmed = modelId.trim()
  if (!trimmed) return

  const extracted = extractAcpSessionModels(session)
  if (extracted.currentModelId === trimmed) return

  if (extracted.source === 'configOptions' && extracted.modelConfigId) {
    await setConfigOption(client, sessionId, extracted.modelConfigId, trimmed)
    return
  }

  if (extracted.source === 'models') {
    await client.setSessionModel(sessionId, trimmed)
    return
  }

  try {
    await client.setSessionModel(sessionId, trimmed)
    return
  } catch {
    // Fall through to the stable config-option API used by newer ACP agents.
  }
  await setConfigOption(client, sessionId, extracted.modelConfigId ?? MODEL_CATEGORY, trimmed)
}

async function setConfigOption(
  client: Pick<AcpClient, 'setSessionConfigOption'>,
  sessionId: string,
  configId: string,
  modelId: string
): Promise<void> {
  try {
    await client.setSessionConfigOption(sessionId, configId, modelId)
  } catch {
    await client.setSessionConfigOption(sessionId, configId, { type: 'id', value: modelId })
  }
}

export interface ProbeAcpModelsOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000

export async function probeAcpModels(options: ProbeAcpModelsOptions): Promise<AcpModelList> {
  const cwd = options.cwd?.trim() || tmpdir()
  const transport = new AcpStdioTransport({
    command: options.command,
    args: options.args,
    cwd,
    env: options.env
  })
  let client: AcpClient | undefined
  try {
    transport.start()
    client = new AcpClient(transport, { timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS })
    await client.initialize()
    const created = await client.newSession({ cwd }) as AcpNewSessionResult
    const extracted = extractAcpSessionModels(created)
    await client.close().catch(() => {})
    return {
      models: extracted.models,
      currentModelId: extracted.currentModelId
    }
  } catch (error) {
    await client?.close().catch(() => {})
    await transport.close().catch(() => {})
    throw error
  }
}
