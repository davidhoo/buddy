import type { AcpModelInfo } from '../../../shared/types'
import { stripTerminalDecorations } from '../shell-path'
import { kimiProviderModelListSchema } from '../schemas'

/** Cursor models prints ID - label rows, with optional current/default markers. */
export function parseCursorModels(output: string): AcpModelInfo[] {
  const models = new Map<string, AcpModelInfo>()
  for (const line of stripTerminalDecorations(output).split(/\r?\n/)) {
    const match = /^\s*([\w][\w./:+-]*)\s+-\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const [, id, label] = match
    const name = label.replace(/\s+\((?:current|default)(?:,\s*(?:current|default))*\)$/, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    if (name && !models.has(id)) models.set(id, { id, name })
  }
  return [...models.values()]
}

/** agy models prints a progress line followed by tab-separated ID / label rows. */
export function parseAgyModels(output: string): AcpModelInfo[] {
  const models = new Map<string, AcpModelInfo>()
  for (const line of stripTerminalDecorations(output).split(/\r?\n/)) {
    const [rawId, ...labels] = line.split('\t')
    const id = rawId.trim()
    const name = labels.join(' ').trim()
    if (!name || !/^[a-zA-Z0-9][\w./:+-]*$/.test(id) || /^(id|model_id)$/i.test(id)) continue
    if (!models.has(id)) models.set(id, { id, name })
  }
  return [...models.values()]
}

/** Only expose native model aliases; provider data may contain credentials. */
export function parseKimiModels(output: string): AcpModelInfo[] {
  let data: unknown
  try { data = JSON.parse(output) } catch { throw new Error('Kimi model list returned invalid JSON') }
  const result = kimiProviderModelListSchema.safeParse(data)
  if (!result.success) throw new Error('Kimi model list returned an unsupported data format')
  return Object.entries(result.data.models)
    .filter(([id]) => !!id.trim())
    .map(([id, model]) => ({ id, name: model.display_name?.trim() || id }))
}
