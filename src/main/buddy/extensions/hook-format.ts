import { createHash } from 'node:crypto'
import type { ExtensionAdapter } from '../../../shared/extensions'

export const PORTABLE_HOOK_EVENTS = ['turn-end', 'after-tool', 'before-tool', 'prompt', 'session-start'] as const
export type PortableHookEvent = (typeof PORTABLE_HOOK_EVENTS)[number]
export const PORTABLE_HOOK_TOOLS = ['shell', 'edit'] as const

export interface HookSpec {
  name: string
  description: string
  event: string
  matcher: string
  command: string
  timeoutSeconds: number
}

const CLAUDE_EVENTS: Record<PortableHookEvent, string> = {
  'turn-end': 'Stop',
  'after-tool': 'PostToolUse',
  'before-tool': 'PreToolUse',
  prompt: 'UserPromptSubmit',
  'session-start': 'SessionStart'
}

const CLAUDE_TOOLS: Record<string, string> = {
  shell: 'Bash',
  edit: 'Edit|Write|MultiEdit'
}

const CODEX_EVENTS = CLAUDE_EVENTS
const CODEX_TOOLS: Record<string, string> = {
  shell: 'Bash',
  edit: 'apply_patch'
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export function validateHookSpec(spec: HookSpec): string | null {
  if (!NAME_RE.test(spec.name)) return 'unsupported'
  if (!spec.command.trim()) return 'unsupported'
  if (spec.description.length > 200) return 'unsupported'
  if (spec.timeoutSeconds < 0 || spec.timeoutSeconds > 86400) return 'unsupported'
  if (!(PORTABLE_HOOK_EVENTS as readonly string[]).includes(spec.event)) return 'unsupported'
  if (spec.matcher && (!(PORTABLE_HOOK_TOOLS as readonly string[]).includes(spec.matcher) || !['after-tool', 'before-tool'].includes(spec.event))) {
    return 'unsupported'
  }
  return null
}

export function hookSupportsAdapter(adapter: ExtensionAdapter): boolean {
  return adapter === 'claude' || adapter === 'codex'
}

export function nativeHookEvent(adapter: ExtensionAdapter, portable: string): string | null {
  if (!(PORTABLE_HOOK_EVENTS as readonly string[]).includes(portable)) return null
  if (adapter === 'claude') return CLAUDE_EVENTS[portable as PortableHookEvent]
  if (adapter === 'codex') return CODEX_EVENTS[portable as PortableHookEvent]
  return null
}

export function buildHookEntry(adapter: ExtensionAdapter, spec: HookSpec): { event: string; entry: Record<string, unknown> } | null {
  const event = nativeHookEvent(adapter, spec.event)
  if (!event) return null
  const tools = adapter === 'codex' ? CODEX_TOOLS : CLAUDE_TOOLS
  const matcher = spec.matcher ? (tools[spec.matcher] ?? '') : ''
  const timeout = spec.timeoutSeconds > 0 ? spec.timeoutSeconds : undefined
  const cmd: Record<string, unknown> = { type: 'command', command: spec.command }
  if (timeout !== undefined) cmd.timeout = timeout
  const entry: Record<string, unknown> = { hooks: [cmd] }
  if (matcher) entry.matcher = matcher
  return { event, entry }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export function entryHash(entry: unknown): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex')
}

/** Upsert one Buddy-managed hook entry under hooks.<event>. Preserves other top-level keys and other entries. */
export function upsertHookInSettings(
  text: string,
  event: string,
  entry: Record<string, unknown>,
  previous: string | null
): { ok: true; text: string; changed: boolean } | { ok: false; code: string } {
  const parsed = parseJsonObject(text)
  if (!parsed.ok) return parsed
  const root = parsed.value
  const hooks = asObject(root.hooks) ?? {}
  const list = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : []
  const want = canonicalJson(entry)
  let index = -1
  if (previous) {
    index = list.findIndex((item) => canonicalJson(item) === previous)
  }
  if (index < 0) {
    index = list.findIndex((item) => canonicalJson(item) === want)
  }
  if (index >= 0) {
    if (canonicalJson(list[index]) === want) {
      root.hooks = { ...hooks, [event]: list }
      return { ok: true, text: `${JSON.stringify(root, null, 2)}\n`, changed: false }
    }
    list[index] = entry
  } else {
    // same command already present as user-owned: do not claim it
    if (list.some((item) => canonicalJson(item) === want)) {
      return { ok: false, code: 'conflict' }
    }
    list.push(entry)
  }
  root.hooks = { ...hooks, [event]: list }
  return { ok: true, text: `${JSON.stringify(root, null, 2)}\n`, changed: true }
}

export function removeHookFromSettings(
  text: string,
  event: string,
  previous: string
): { ok: true; text: string; changed: boolean } | { ok: false; code: string } {
  const parsed = parseJsonObject(text)
  if (!parsed.ok) return parsed
  const root = parsed.value
  const hooks = asObject(root.hooks)
  if (!hooks) return { ok: true, text, changed: false }
  const list = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : []
  const index = list.findIndex((item) => canonicalJson(item) === previous)
  if (index < 0) {
    // entry gone or edited: leave file alone
    return { ok: false, code: 'changed_externally' }
  }
  list.splice(index, 1)
  if (list.length === 0) delete hooks[event]
  else hooks[event] = list
  if (Object.keys(hooks).length === 0) delete root.hooks
  else root.hooks = hooks
  return { ok: true, text: `${JSON.stringify(root, null, 2)}\n`, changed: true }
}

function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; code: string } {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return { ok: true, value: {} }
  if (trimmed.includes('//') || trimmed.includes('/*')) return { ok: false, code: 'comment' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, code: 'unsupported' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'unsupported' }
  return { ok: true, value: { ...(parsed as Record<string, unknown>) } }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return { ...(value as Record<string, unknown>) }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return out
}
