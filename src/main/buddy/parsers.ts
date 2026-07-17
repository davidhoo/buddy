export interface ParsedActorLine {
  text?: string
  sessionId?: string
  threadId?: string
  rawType?: string
  /** True for noise events (e.g. system/hook) that carry no actor content */
  noise?: boolean
}

export interface ParseActorOptions {
  cursorPartialOutput?: boolean
}

export type BuddyMessage =
  | { kind: 'break'; content: string; reason?: string }
  | { kind: 'message'; text: string }

export function parseClaudeStreamLine(line: string): ParsedActorLine {
  const json = JSON.parse(line)
  const text = Array.isArray(json.message?.content)
    ? json.message.content
        .filter((part: { type?: string; text?: string }) => part.type === 'text' && part.text)
        .map((part: { text: string }) => part.text)
        .join('')
    : undefined

  const isHook = json.type === 'system' && (typeof json.subtype === 'string' && (json.subtype as string).startsWith('hook_'))

  return {
    text,
    sessionId: claudeSessionIdFromEvent(json),
    rawType: json.type,
    noise: isHook
  }
}

export function parseCodexJsonLine(line: string): ParsedActorLine {
  const json = JSON.parse(line)
  let text: string | undefined

  if (Array.isArray(json.content)) {
    const parts: string[] = []
    for (const part of json.content as Record<string, unknown>[]) {
      if ((part.type === 'text' || part.type === 'output_text') && part.text) {
        parts.push(part.text as string)
      } else if (part.type === 'tool_call' && part.name) {
        const detail = codexToolDetail(part.name as string, part.input)
        parts.push(detail ? `🔧 ${part.name} ${detail}` : `🔧 ${part.name}`)
      }
    }
    text = parts.join('') || undefined
  }

  if (!text) {
    const itemText = json.item && typeof json.item === 'object' && !Array.isArray(json.item)
      ? (json.item as { text?: unknown }).text
      : undefined
    if (typeof itemText === 'string') text = itemText
    else if (json.message) text = textValue(json.message)
  }

  return {
    text,
    sessionId: stableSessionIdFromEvent('codex', json),
    threadId: stableThreadIdFromEvent('codex', json) ?? textValue(json.thread_id),
    rawType: json.type
  }
}

function codexToolDetail(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  if (toolName === 'shell' || toolName === 'bash') {
    const cmd = textValue(obj.command) ?? textValue(obj.cmd)
    if (cmd) return truncate(cmd, 80)
  }
  const path = textValue(obj.path) ?? textValue(obj.file_path) ?? textValue(obj.file)
  if (path) return truncate(path, 80)
  for (const v of Object.values(obj)) {
    const s = textValue(v)
    if (s) return truncate(s, 80)
  }
  return undefined
}

export function parseOpenCodeJsonLine(line: string): ParsedActorLine {
  const json = JSON.parse(line)
  const part = objectValue(json.part)
  let text: string | undefined

  if (json.type === 'text') {
    text = textValue(part?.text)
  } else if (json.type === 'error') {
    text = stringifyValue(json.error)
  } else if (json.type === 'step_start') {
    // step_start is a lifecycle event, not actor content.
    // Mark as noise so downstream logic doesn't treat the placeholder "..."
    // as a valid buddy message (which would cause infinite loops when the
    // actor's context is exhausted and only step_start events are emitted).
    return {
      text: '...',
      sessionId: stableSessionIdFromEvent('opencode', json) ?? textValue(json.sessionID),
      rawType: json.type,
      noise: true
    }
  } else if (json.type === 'step_finish') {
    return {
      sessionId: stableSessionIdFromEvent('opencode', json) ?? textValue(json.sessionID),
      rawType: json.type,
      noise: true
    }
  } else if (json.type === 'tool_use') {
    const toolName = part?.tool ?? 'tool'
    const state = objectValue(part?.state)
    const input = state?.input ?? part?.input
    const output = textValue(state?.output)
    // If tool output contains a buddy message, show it directly (e.g. echo commands)
    if (output && BUDDY_JSON_PATTERN.test(output)) {
      text = output.trim()
    } else {
      const detail = openCodeToolDetail(toolName, input)
      text = detail ? `🔧 ${toolName} ${detail}` : `🔧 ${toolName}`
    }
  }

  return {
    text,
    sessionId: stableSessionIdFromEvent('opencode', json) ?? textValue(json.sessionID),
    rawType: json.type
  }
}

export function parseKimiJSONLine(line: string): ParsedActorLine {
  const json = JSON.parse(line)
  const part = objectValue(json.part)
  let text: string | undefined

  // New stream-json format (mirrors OpenCode event types)
  if (json.type === 'text') {
    text = textValue(part?.text)
  } else if (json.type === 'error') {
    text = stringifyValue(json.error)
  } else if (json.type === 'step_start') {
    return {
      text: '...',
      sessionId: stableSessionIdFromEvent('kimi', json)
        ?? (json.role === 'meta' && json.type === 'session.resume_hint' ? textValue(json.session_id) : undefined)
        ?? textValue(json.sessionID),
      rawType: json.type,
      noise: true
    }
  } else if (json.type === 'step_finish') {
    return {
      sessionId: stableSessionIdFromEvent('kimi', json) ?? textValue(json.sessionID),
      rawType: json.type,
      noise: true
    }
  } else if (json.type === 'tool_use') {
    const toolName = typeof part?.tool === 'string' ? part.tool : 'tool'
    const state = objectValue(part?.state)
    const input: unknown = state?.input ?? part?.input
    const output = textValue(state?.output)
    if (output && BUDDY_JSON_PATTERN.test(output)) {
      text = output.trim()
    } else {
      const detail = kimiToolDetail(toolName, input)
      text = detail ? `🔧 ${toolName} ${detail}` : `🔧 ${toolName}`
    }
  } else if (json.role === 'assistant') {
    // Legacy OpenAI-compatible format
    text = textValue(json.content)
    if (Array.isArray(json.tool_calls)) {
      const toolTexts = (json.tool_calls as Record<string, unknown>[]).map(tc => {
        const fn = objectValue(tc.function)
        const name = textValue(fn?.name ?? tc.name) ?? 'tool'
        const args = fn?.arguments
        const detail = kimiToolDetail(name, args)
        return detail ? `🔧 ${name} ${detail}` : `🔧 ${name}`
      })
      if (toolTexts.length) text = toolTexts.join(' ')
    }
  }

  const sessionId = stableSessionIdFromEvent('kimi', json)
    ?? (json.role === 'meta' && json.type === 'session.resume_hint' ? textValue(json.session_id) : undefined)
    ?? textValue(json.sessionID)

  return {
    text,
    sessionId,
    rawType: json.type ?? json.role
  }
}

export function parseCursorStreamLine(line: string, partialOutput = false): ParsedActorLine {
  const json = JSON.parse(line) as Record<string, unknown>
  const type = textValue(json.type)
  const sessionId = textValue(json.session_id)

  if (type === 'assistant') {
    // Partial streams emit a duplicate buffered flush before tool calls. The
    // event carrying model_call_id contains no new text and must be ignored.
    if (
      json.model_call_id != null
      || (partialOutput && typeof json.timestamp_ms !== 'number')
    ) {
      return { sessionId, rawType: type, noise: true }
    }
    const message = objectValue(json.message)
    const content = message?.content
    const text = Array.isArray(content)
      ? content.map(textFromContentPart).filter(Boolean).join('')
      : undefined
    return { text: text || undefined, sessionId, rawType: type }
  }

  if (type === 'tool_call') {
    if (json.subtype === 'completed') {
      return { sessionId, rawType: type, noise: true }
    }
    const detail = cursorToolDetail(json.tool_call)
    return {
      text: detail ? `🔧 ${detail}` : '🔧 tool',
      sessionId,
      rawType: type
    }
  }

  return {
    sessionId,
    rawType: type,
    noise: type === 'system' || type === 'user' || type === 'result'
  }
}

function cursorToolDetail(value: unknown): string | undefined {
  const toolCall = objectValue(value)
  if (!toolCall) return undefined
  const [kind, payloadValue] = Object.entries(toolCall)[0] ?? []
  if (!kind) return undefined
  const payload = objectValue(payloadValue)
  const args = objectValue(payload?.args)
  const name = kind.replace(/ToolCall$/, '')
  const command = textValue(args?.command)
  const path = textValue(args?.path)
  const suffix = command ?? path
  return suffix ? `${name} ${truncate(suffix, 80)}` : name
}

function kimiToolDetail(toolName: string, args: unknown): string | undefined {
  if (!args) return undefined
  // args may be a JSON string or an object
  let obj: Record<string, unknown> | undefined
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) } catch { return truncate(args, 80) }
  } else if (typeof args === 'object' && args !== null) {
    obj = args as Record<string, unknown>
  }
  if (!obj) return undefined
  if (toolName === 'shell' || toolName === 'bash') {
    const cmd = textValue(obj.command) ?? textValue(obj.cmd)
    if (cmd) return truncate(cmd, 80)
  }
  const path = textValue(obj.path) ?? textValue(obj.file_path) ?? textValue(obj.file)
  if (path) return truncate(path, 80)
  for (const v of Object.values(obj)) {
    const s = textValue(v)
    if (s) return truncate(s, 80)
  }
  return undefined
}

export function parseActorLine(actor: string, line: string, options: ParseActorOptions = {}): ParsedActorLine {
  if (actor === 'claude') return parseClaudeStreamLine(line)
  if (actor === 'codex') return parseCodexJsonLine(line)
  if (actor === 'opencode') return parseOpenCodeJsonLine(line)
  if (actor === 'kimi') return parseKimiJSONLine(line)
  if (actor === 'cursor') return parseCursorStreamLine(line, options.cursorPartialOutput)
  return parseCodexJsonLine(line)
}

export function parseActorEvents(actor: string, rawEvents: string, options: ParseActorOptions = {}): ParsedActorLine[] {
  return rawEvents.split(/\r?\n/).flatMap((raw) => {
    if (!raw.trim()) return []
    try {
      return [parseActorLine(actor, raw, options)]
    } catch {
      return [{ text: raw }]
    }
  })
}

export function extractActorOutput(actor: string, rawEvents: string, options: ParseActorOptions = {}): string {
  if (actor === 'claude') return extractClaudeOutput(rawEvents)
  if (actor === 'opencode') return extractOpenCodeOutput(rawEvents)
  if (actor === 'kimi') return extractKimiOutput(rawEvents)
  if (actor === 'cursor') return extractCursorOutput(rawEvents, options.cursorPartialOutput)
  return extractGenericJsonOutput(rawEvents)
}

export function parseBuddyMessage(text: string): BuddyMessage {
  const trimmed = text.trim()
  const jsonMessage = parseBuddyJsonMessage(trimmed)
  if (jsonMessage) return jsonMessage

  const fields = new Map<string, string>()
  for (const line of trimmed.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index !== -1) fields.set(line.slice(0, index), line.slice(index + 1))
  }

  if (fields.get('type') === 'break') {
    const reason = fields.get('reason')
    return { kind: 'break', reason, content: reason ?? text }
  }

  return { kind: 'message', text }
}

function parseBuddyJsonMessage(text: string): BuddyMessage | null {
  const fenced = text.match(/```json\s*(\{[\s\S]*\})\s*```/i)
  if (fenced) {
    const parsed = parseBuddyJsonCandidate(fenced[1])
    if (parsed) return parsed
    const loose = looseExtractBuddyMessage(fenced[1])
    if (loose) return loose
  }

  const parsed = parseBuddyJsonCandidate(text)
  if (parsed) return parsed

  const loose = looseExtractBuddyMessage(text)
  if (loose) return loose

  const obj = findBuddyJsonObject(text)
  if (obj) {
    const objParsed = parseBuddyJsonCandidate(obj)
    if (objParsed) return objParsed
    const objLoose = looseExtractBuddyMessage(obj)
    if (objLoose) return objLoose
  }

  const unescaped = tryUnescapeJson(text)
  if (unescaped) {
    const uobj = findBuddyJsonObject(unescaped) ?? unescaped
    const uparsed = parseBuddyJsonCandidate(uobj)
    if (uparsed) return uparsed
    const uloose = looseExtractBuddyMessage(uobj)
    if (uloose) return uloose
  }

  return null
}

function findBuddyJsonObject(text: string): string | null {
  const match = text.match(/\{\s*"type"\s*:\s*"(chat|break)"/)
  if (!match || match.index === undefined) return null

  let depth = 0
  let inString = false
  let inBacktick = false
  let escape = false
  let start = match.index

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inBacktick) {
      if (ch === '`') inBacktick = false
      continue
    }
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '`' && !inString) { inBacktick = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

function tryUnescapeJson(text: string): string | null {
  if (!text.includes('\\"')) return null
  const unescaped = text.replace(/\\"/g, '"')
  if (!/\{\s*"type"\s*:\s*"(chat|break)"/.test(unescaped)) return null
  return unescaped
}

function findClosingContentQuote(text: string): number {
  const len = text.length
  let pos = len - 1

  while (pos >= 0 && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r')) pos--
  if (pos < 0 || text[pos] !== '}') return -1
  pos--
  while (pos >= 0 && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n' || text[pos] === '\r')) pos--
  if (pos < 0 || text[pos] !== '"') return -1

  return pos
}

function parseBuddyJsonCandidate(text: string): BuddyMessage | null {
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const type = (parsed as { type?: unknown }).type
    const content = (parsed as { content?: unknown }).content
    if ((type === 'chat' || type === 'break') && typeof content === 'string') {
      return type === 'break'
        ? { kind: 'break', content }
        : { kind: 'message', text: content }
    }
  } catch {}
  return null
}

function looseExtractBuddyMessage(text: string): BuddyMessage | null {
  const typeMatch = text.match(/"type"\s*:\s*"(chat|break)"/)
  if (!typeMatch || typeMatch.index === undefined) return null

  const kind = typeMatch[1] as 'chat' | 'break'

  // Search for "content":" AFTER the "type" match to avoid picking up
  // "content" keys from unrelated JSON structures (e.g. tool_result)
  // that appear before the buddy JSON in the text.
  const afterType = text.slice(typeMatch.index)
  const contentKeyMatch = afterType.match(/"content"\s*:\s*"/)
  if (!contentKeyMatch || contentKeyMatch.index === undefined) return null

  const contentStart = typeMatch.index + contentKeyMatch.index + contentKeyMatch[0].length
  const closingQuote = findClosingContentQuote(text)
  const raw = closingQuote !== -1 && closingQuote > contentStart
    ? text.slice(contentStart, closingQuote)
    : text.slice(contentStart)
  const content = unescapeJsonString(raw)

  return kind === 'break'
    ? { kind: 'break', content }
    : { kind: 'message', text: content }
}

function unescapeJsonString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
}

function extractClaudeOutput(rawEvents: string): string {
  let result = ''
  const chunks: string[] = []
  for (const event of parseJsonEvents(rawEvents)) {
    const eventResult = textValue(event.result)
    if (event.type === 'result' && eventResult) result = eventResult
    const text = textValue(event.text)
    if (text) chunks.push(text)
    const message = objectValue(event.message)
    const content = message?.content
    if (Array.isArray(content)) {
      chunks.push(...content.map(textFromContentPart).filter(Boolean))
    }
  }
  return (result || chunks.join('\n')).trim()
}

const BUDDY_JSON_PATTERN = /\{\s*"type"\s*:\s*"(chat|break)"/

function extractOpenCodeOutput(rawEvents: string): string {
  const chunks: string[] = []
  for (const event of parseJsonEvents(rawEvents)) {
    if (event.type === 'text') {
      const part = objectValue(event.part)
      const text = textValue(part?.text)
      if (text) chunks.push(text)
    } else if (event.type === 'error') {
      const error = stringifyValue(event.error)
      if (error) chunks.push(error)
    } else if (event.type === 'tool_use') {
      // Some models (e.g. DeepSeek) output buddy JSON via echo/bash commands.
      // The buddy message appears in part.state.output of tool_use events.
      const part = objectValue(event.part)
      const state = objectValue(part?.state)
      const output = textValue(state?.output)
      if (output && BUDDY_JSON_PATTERN.test(output)) {
        chunks.push('\n' + output.trim())
      }
    }
  }
  return chunks.join('').trim()
}

function extractKimiOutput(rawEvents: string): string {
  const chunks: string[] = []
  let legacyLast = ''
  for (const event of parseJsonEvents(rawEvents)) {
    // New stream-json format (mirrors OpenCode event types)
    if (event.type === 'text') {
      const part = objectValue(event.part)
      const text = textValue(part?.text)
      if (text) chunks.push(text)
    } else if (event.type === 'error') {
      const error = stringifyValue(event.error)
      if (error) chunks.push(error)
    } else if (event.type === 'tool_use') {
      const part = objectValue(event.part)
      const state = objectValue(part?.state)
      const output = textValue(state?.output)
      if (output && BUDDY_JSON_PATTERN.test(output)) {
        chunks.push('\n' + output.trim())
      }
    } else if (event.role === 'assistant') {
      // Legacy OpenAI-compatible format: each event is a full message, keep last
      const content = textValue(event.content)
      if (content) legacyLast = content
    }
  }
  const streamText = chunks.join('').trim()
  return streamText || legacyLast.trim()
}

function extractCursorOutput(rawEvents: string, partialOutput = false): string {
  let result = ''
  const chunks: string[] = []
  for (const event of parseJsonEvents(rawEvents)) {
    if (event.type === 'result') {
      const eventResult = textValue(event.result)
      if (eventResult) result = eventResult
      continue
    }
    if (
      event.type !== 'assistant'
      || event.model_call_id != null
      || (partialOutput && typeof event.timestamp_ms !== 'number')
    ) continue
    const message = objectValue(event.message)
    if (!Array.isArray(message?.content)) continue
    chunks.push(...message.content.map(textFromContentPart).filter(Boolean))
  }
  return (result || chunks.join('')).trim()
}

function extractGenericJsonOutput(rawEvents: string): string {
  const chunks: string[] = []
  for (const event of parseJsonEvents(rawEvents)) {
    const item = objectValue(event.item)
    const itemText = textValue(item?.text)
    const message = textValue(event.message)
    const content = event.content
    if (Array.isArray(content)) {
      chunks.push(...content.map(textFromContentPart).filter(Boolean))
    } else if (itemText) {
      chunks.push(itemText)
    } else if (message) {
      chunks.push(message)
    }
  }
  return chunks.join('\n').trim()
}

export function parseJsonlBuffer(raw: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = []
  let buffer = ''

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue

    // If we have a stale buffer from a previous broken event and this line
    // starts a new JSON object, try to salvage the buffer first, then
    // discard it if it can't be parsed — don't let one broken event
    // swallow all subsequent events.
    if (buffer && line.startsWith('{')) {
      try {
        const obj = JSON.parse(buffer)
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          results.push(obj)
        }
      } catch { /* discard broken buffer */ }
      buffer = ''
    }

    buffer = buffer ? buffer + '\n' + line : line
    try {
      const obj = JSON.parse(buffer)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        results.push(obj)
      }
      buffer = ''
    } catch {
      // incomplete JSON, keep accumulating
    }
  }

  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        results.push(obj)
      }
    } catch { /* discard */ }
  }

  return results
}

function parseJsonEvents(rawEvents: string): Array<Record<string, unknown>> {
  return parseJsonlBuffer(rawEvents)
}

function claudeSessionIdFromEvent(event: Record<string, unknown>): string | undefined {
  const sessionId = textValue(event.session_id)
  if (!sessionId) return undefined

  const eventType = textValue(event.type)
  const subtype = textValue(event.subtype) ?? ''
  if (eventType === 'system') {
    if (subtype === 'init') return sessionId
    if (subtype.startsWith('hook_') || event.hook_event) return undefined
  }
  if (eventType === 'result' || eventType === 'assistant' || eventType === 'user') return sessionId
  if (eventType !== 'system') return sessionId
  return undefined
}

function stableSessionIdFromEvent(actor: string, event: Record<string, unknown>): string | undefined {
  if (event.type !== 'buddy.session' || event.actor !== actor) return undefined
  if (actor === 'codex') return undefined
  return textValue(event.session_id)
}

function stableThreadIdFromEvent(actor: string, event: Record<string, unknown>): string | undefined {
  if (actor === 'codex' && event.type === 'buddy.session' && event.actor === 'codex') {
    return textValue(event.thread_id) ?? textValue(event.session_id)
  }
  if (actor === 'codex' && event.type === 'thread.started') return textValue(event.thread_id)
  return undefined
}

function textFromContentPart(part: unknown): string {
  const candidate = objectValue(part)
  if (!candidate) return ''
  const type = candidate.type
  return (type === 'text' || type === 'output_text') ? textValue(candidate.text) ?? '' : ''
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function openCodeToolDetail(toolName: unknown, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const obj = input as Record<string, unknown>
  // bash/shell: show command
  if (toolName === 'bash' || toolName === 'shell') {
    const cmd = textValue(obj.command) ?? textValue(obj.cmd)
    if (cmd) return truncate(cmd, 80)
  }
  // file operations: show path
  const path = textValue(obj.path) ?? textValue(obj.file_path) ?? textValue(obj.file)
  if (path) return truncate(path, 80)
  // generic: show first string value
  for (const v of Object.values(obj)) {
    const s = textValue(v)
    if (s) return truncate(s, 80)
  }
  return undefined
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd() + '…'
}

function stringifyValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  return JSON.stringify(value)
}
