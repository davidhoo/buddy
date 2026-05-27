/**
 * Keyboard shortcuts system for Buddy.
 *
 * Defines shortcut IDs, default keybindings, matching logic,
 * localStorage persistence, conflict detection, and reset.
 */

// ── Shortcut IDs ──────────────────────────────────────────────

export type ShortcutId =
  | 'newTask'
  | 'openSettings'
  | 'toggleSidebar'
  | 'toggleStatusBar'
  | 'selectTask1'
  | 'selectTask2'
  | 'selectTask3'
  | 'selectTask4'
  | 'selectTask5'
  | 'selectTask6'
  | 'selectTask7'
  | 'selectTask8'
  | 'selectTask9'
  | 'nextTask'
  | 'prevTask'
  | 'interrupt'
  | 'escape'
  | 'showShortcuts'

// ── Key binding representation ────────────────────────────────

export interface KeyBinding {
  key: string           // e.g. 'n', 'Enter', '[', ']', '/', '?', '1'-'9'
  metaKey: boolean      // Cmd on macOS
  ctrlKey: boolean
  altKey: boolean       // Option on macOS
  shiftKey: boolean
}

// ── Shortcut definition (for display in settings) ─────────────

export interface ShortcutDef {
  id: ShortcutId
  group: 'application' | 'navigation'
  labelKey: string        // i18n key for display name
  defaultBinding: KeyBinding
  /** If true, keep the shortcut active but hide it from settings UI */
  hidden?: boolean
  /** If true, this shortcut can never be unbound or remapped */
  readonly?: boolean
}

// ── Default shortcuts ─────────────────────────────────────────

export const SHORTCUT_DEFS: ShortcutDef[] = [
  // Application
  { id: 'newTask',        group: 'application', labelKey: 'shortcuts.newTask',        defaultBinding: { key: 'n',  metaKey: true,  ctrlKey: false, altKey: false, shiftKey: false } },
  { id: 'openSettings',   group: 'application', labelKey: 'shortcuts.openSettings',   defaultBinding: { key: ',',  metaKey: true,  ctrlKey: false, altKey: false, shiftKey: false } },
  { id: 'toggleSidebar',  group: 'application', labelKey: 'shortcuts.toggleSidebar',  defaultBinding: { key: 'b',  metaKey: true,  ctrlKey: false, altKey: false, shiftKey: false } },
  { id: 'toggleStatusBar',group: 'application', labelKey: 'shortcuts.toggleStatusBar',defaultBinding: { key: 'b',  metaKey: true,  ctrlKey: false, altKey: true,  shiftKey: false } },
  { id: 'interrupt',      group: 'application', labelKey: 'shortcuts.interrupt',      defaultBinding: { key: '.',  metaKey: true,  ctrlKey: false, altKey: false, shiftKey: false } },
  { id: 'showShortcuts',  group: 'application', labelKey: 'shortcuts.showShortcuts',  defaultBinding: { key: '/',  metaKey: true,  ctrlKey: false, altKey: false, shiftKey: true  } },
  // Navigation
  { id: 'selectTask1', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '1', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'selectTask2', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '2', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'selectTask3', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '3', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'selectTask4', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '4', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'selectTask5', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '5', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'selectTask6', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '6', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'selectTask7', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '7', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'selectTask8', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '8', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'selectTask9', group: 'navigation', labelKey: 'shortcuts.selectTaskN', defaultBinding: { key: '9', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, hidden: true },
  { id: 'nextTask',    group: 'navigation', labelKey: 'shortcuts.nextTask',   defaultBinding: { key: ']', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true  } },
  { id: 'prevTask',    group: 'navigation', labelKey: 'shortcuts.prevTask',   defaultBinding: { key: '[', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true  } },
  { id: 'escape',      group: 'application', labelKey: 'shortcuts.escape',      defaultBinding: { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, readonly: true },
]

// ── Persistence ───────────────────────────────────────────────

const STORAGE_KEY = 'buddy.keybindings'

type BindingMap = Record<ShortcutId, KeyBinding>

function defaultBindingMap(): BindingMap {
  const map = {} as BindingMap
  for (const def of SHORTCUT_DEFS) {
    map[def.id] = { ...def.defaultBinding }
  }
  return map
}

function readBindingMap(): BindingMap {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return defaultBindingMap()
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return defaultBindingMap()
    // Merge with defaults so new shortcuts get values
    const defaults = defaultBindingMap()
    for (const id of Object.keys(defaults) as ShortcutId[]) {
      if (parsed[id] && typeof parsed[id] === 'object' && typeof parsed[id].key === 'string') {
        defaults[id] = {
          key: parsed[id].key,
          metaKey: !!parsed[id].metaKey,
          ctrlKey: !!parsed[id].ctrlKey,
          altKey: !!parsed[id].altKey,
          shiftKey: !!parsed[id].shiftKey,
        }
      }
    }
    return defaults
  } catch {
    return defaultBindingMap()
  }
}

function writeBindingMap(map: BindingMap): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {}
}

// ── Public API ────────────────────────────────────────────────

/** Get current key bindings (defaults + user overrides from localStorage) */
export function loadBindings(): BindingMap {
  return readBindingMap()
}

/** Save a single shortcut binding override */
export function saveBinding(id: ShortcutId, binding: KeyBinding): BindingMap {
  const map = loadBindings()
  map[id] = { ...binding }
  writeBindingMap(map)
  return map
}

/** Reset a single shortcut to its default */
export function resetBinding(id: ShortcutId): BindingMap {
  const map = loadBindings()
  const def = SHORTCUT_DEFS.find(d => d.id === id)
  if (def) map[id] = { ...def.defaultBinding }
  writeBindingMap(map)
  return map
}

/** Reset all shortcuts to defaults */
export function resetAllBindings(): BindingMap {
  const map = defaultBindingMap()
  writeBindingMap(map)
  return map
}

// ── Key normalization ──────────────────────────────────────────

/**
 * Normalize a KeyboardEvent's key value so that Shift-modified keys
 * match their unshifted base. For example, Shift+] produces `}` in
 * e.key but we want to match it against the stored binding `]`.
 * Uses e.code (physical key) to derive the base character.
 */
function normalizeKey(e: KeyboardEvent): string {
  // Special keys that are immune to Shift (Enter, Escape, arrows, etc.)
  if (e.key.length > 1) return e.key

  // Use e.code to get the physical key, which is unaffected by Shift.
  // e.code format: "KeyA", "Digit1", "BracketLeft", "Slash", "Comma", "Period", etc.
  const code = e.code
  if (!code) return e.key

  // Letter keys: "KeyA" -> "a"
  if (code.startsWith('Key') && code.length === 4) {
    return code[3].toLowerCase()
  }
  // Digit keys: "Digit1" -> "1"
  if (code.startsWith('Digit') && code.length === 6) {
    return code[5]
  }

  // Punctuation / symbol keys that Shift changes
  const CODE_TO_KEY: Record<string, string> = {
    'BracketLeft': '[',      // Shift+[ = {
    'BracketRight': ']',     // Shift+] = }
    'Slash': '/',            // Shift+/ = ?
    'Comma': ',',            // Shift+, = <
    'Period': '.',           // Shift+. = >
    'Semicolon': ';',        // Shift+; = :
    'Quote': "'",            // Shift+' = "
    'Backslash': '\\',       // Shift+\ = |
    'Backquote': '`',        // Shift+` = ~
    'Minus': '-',            // Shift+- = _
    'Equal': '=',            // Shift+= = +
  }
  if (code in CODE_TO_KEY) return CODE_TO_KEY[code]

  // Fallback: for anything not in the map, return e.key as-is
  return e.key
}

// ── Matching ──────────────────────────────────────────────────

function bindingMatchesEvent(binding: KeyBinding, e: KeyboardEvent): boolean {
  const normalizedKey = normalizeKey(e)
  return (
    normalizedKey === binding.key &&
    e.metaKey === binding.metaKey &&
    e.ctrlKey === binding.ctrlKey &&
    e.altKey === binding.altKey &&
    e.shiftKey === binding.shiftKey
  )
}

/**
 * Match a KeyboardEvent against current bindings.
 * Returns the ShortcutId if matched, or null.
 */
export function matchShortcut(e: KeyboardEvent, bindings?: BindingMap): ShortcutId | null {
  const map = bindings ?? loadBindings()
  for (const id of Object.keys(map) as ShortcutId[]) {
    if (bindingMatchesEvent(map[id], e)) {
      return id
    }
  }
  return null
}

/** Check if two key bindings are identical */
export function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return a.key === b.key && a.metaKey === b.metaKey && a.ctrlKey === b.ctrlKey && a.altKey === b.altKey && a.shiftKey === b.shiftKey
}

/**
 * Find which other shortcut ID (if any) already uses the given binding.
 * Returns the conflicting ShortcutId or null.
 */
export function findConflict(binding: KeyBinding, excludeId: ShortcutId, bindings?: BindingMap): ShortcutId | null {
  const map = bindings ?? loadBindings()
  for (const id of Object.keys(map) as ShortcutId[]) {
    if (id === excludeId) continue
    if (bindingsEqual(map[id], binding)) return id
  }
  return null
}

// ── Display helpers ───────────────────────────────────────────

const MAC_SYMBOLS: Record<string, string> = {
  'meta': '⌘',    // ⌘
  'ctrl': '⌃',    // ⌃
  'alt': '⌥',     // ⌥
  'shift': '⇧',   // ⇧
  'Enter': '⏎',   // ⏎
  'Escape': '⎋',  // ⎋
  'Backspace': '⌫', // ⌫
  'Tab': '⇥',     // ⇥
  'ArrowUp': '↑',   // ↑
  'ArrowDown': '↓', // ↓
  'ArrowLeft': '←', // ←
  'ArrowRight': '→',// →
  ' ': '␣',       // ␣
}

/** Format a KeyBinding as a human-readable string (macOS style) */
export function formatBinding(binding: KeyBinding): string {
  const parts: string[] = []
  if (binding.ctrlKey) parts.push(MAC_SYMBOLS['ctrl'])
  if (binding.altKey) parts.push(MAC_SYMBOLS['alt'])
  if (binding.shiftKey) parts.push(MAC_SYMBOLS['shift'])
  if (binding.metaKey) parts.push(MAC_SYMBOLS['meta'])
  const key = MAC_SYMBOLS[binding.key] ?? binding.key.toUpperCase()
  parts.push(key)
  return parts.join('')
}

/** Parse a KeyboardEvent into a KeyBinding for recording */
export function eventToBinding(e: KeyboardEvent): KeyBinding | null {
  // Ignore lone modifier presses
  const modifierKeys = ['Meta', 'Control', 'Alt', 'Shift']
  if (modifierKeys.includes(e.key)) return null
  // Ignore keys without a meaningful identifier
  if (e.key === 'CapsLock' || e.key === 'Fn') return null
  return {
    key: normalizeKey(e),
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
  }
}

/** Get the shortcut groups in display order */
export function getShortcutGroups(): { group: ShortcutDef['group']; labelKey: string }[] {
  return [
    { group: 'application', labelKey: 'shortcuts.group.application' },
    { group: 'navigation',  labelKey: 'shortcuts.group.navigation' },
  ]
}
