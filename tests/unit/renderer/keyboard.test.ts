// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  matchShortcut,
  loadBindings,
  saveBinding,
  resetBinding,
  resetAllBindings,
  findConflict,
  bindingsEqual,
  formatBinding,
  eventToBinding,
} from '../../../src/renderer/lib/keyboard'
import type { KeyBinding } from '../../../src/renderer/lib/keyboard'

afterEach(() => {
  try { window.localStorage?.clear() } catch {}
})

function fakeEvent(overrides: Partial<KeyboardEventInit> & { key: string; code?: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...overrides,
  })
}

describe('keyboard.ts', () => {
  describe('normalizeKey via matchShortcut', () => {
    it('matches Cmd+] even though Shift+Cmd+] yields e.key="}"', () => {
      const bindings = loadBindings()
      const e = fakeEvent({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })
      expect(matchShortcut(e, bindings)).toBe('nextTask')
    })

    it('matches Cmd+[ even though Shift+Cmd+[ yields e.key="{"', () => {
      const bindings = loadBindings()
      const e = fakeEvent({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true })
      expect(matchShortcut(e, bindings)).toBe('prevTask')
    })

    it('matches Cmd+? even though Shift+Cmd+/ yields e.key="?"', () => {
      const bindings = loadBindings()
      const e = fakeEvent({ key: '?', code: 'Slash', metaKey: true, shiftKey: true })
      expect(matchShortcut(e, bindings)).toBe('showShortcuts')
    })

    it('matches Cmd+n with lowercase letter', () => {
      const bindings = loadBindings()
      const e = fakeEvent({ key: 'n', code: 'KeyN', metaKey: true })
      expect(matchShortcut(e, bindings)).toBe('newTask')
    })

    it('matches Cmd+N by normalizing via code', () => {
      const bindings = loadBindings()
      const e = fakeEvent({ key: 'N', code: 'KeyN', metaKey: true, shiftKey: true })
      // Cmd+Shift+n should NOT match 'newTask' because newTask requires shiftKey=false
      expect(matchShortcut(e, bindings)).not.toBe('newTask')
    })

    it('matches Cmd+1 through Cmd+9', () => {
      const bindings = loadBindings()
      for (let i = 1; i <= 9; i++) {
        const e = fakeEvent({ key: String(i), code: `Digit${i}`, metaKey: true })
        expect(matchShortcut(e, bindings)).toBe(`selectTask${i}`)
      }
    })

    it('matches Escape', () => {
      const bindings = loadBindings()
      const e = fakeEvent({ key: 'Escape', code: 'Escape' })
      expect(matchShortcut(e, bindings)).toBe('escape')
    })

    it('returns null for unmatched shortcuts', () => {
      const bindings = loadBindings()
      const e = fakeEvent({ key: 'z', code: 'KeyZ', metaKey: true })
      expect(matchShortcut(e, bindings)).toBeNull()
    })
  })

  describe('eventToBinding', () => {
    it('ignores lone modifier presses', () => {
      expect(eventToBinding(fakeEvent({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBeNull()
      expect(eventToBinding(fakeEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull()
    })

    it('normalizes Shift-modified keys to their base', () => {
      const binding = eventToBinding(fakeEvent({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }))
      expect(binding).not.toBeNull()
      expect(binding!.key).toBe(']')
      expect(binding!.shiftKey).toBe(true)
    })

    it('normalizes Shift+/ to base key "/"', () => {
      const binding = eventToBinding(fakeEvent({ key: '?', code: 'Slash', metaKey: true, shiftKey: true }))
      expect(binding).not.toBeNull()
      expect(binding!.key).toBe('/')
      expect(binding!.shiftKey).toBe(true)
    })

    it('normalizes uppercase letters to lowercase via code', () => {
      const binding = eventToBinding(fakeEvent({ key: 'N', code: 'KeyN', metaKey: true, shiftKey: false }))
      expect(binding).not.toBeNull()
      expect(binding!.key).toBe('n')
    })
  })

  describe('persistence', () => {
    it('saveBinding returns updated map', () => {
      resetAllBindings()
      const newBinding: KeyBinding = { key: 't', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
      const updated = saveBinding('newTask', newBinding)
      expect(updated.newTask.key).toBe('t')
      expect(updated.newTask.metaKey).toBe(true)
    })

    it('resetBinding restores default', () => {
      saveBinding('newTask', { key: 't', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })
      const reset = resetBinding('newTask')
      expect(reset.newTask.key).toBe('n')
    })

    it('resetAllBindings restores all defaults', () => {
      saveBinding('newTask', { key: 'x', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })
      const reset = resetAllBindings()
      expect(reset.newTask.key).toBe('n')
    })
  })

  describe('conflict detection', () => {
    it('finds a conflicting binding', () => {
      const bindings = loadBindings()
      // 'newTask' is Cmd+n, try to bind 'openSettings' to the same
      const conflict = findConflict(bindings.newTask, 'openSettings', bindings)
      expect(conflict).toBe('newTask')
    })

    it('returns null when no conflict', () => {
      const bindings = loadBindings()
      const unique: KeyBinding = { key: 'z', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }
      const conflict = findConflict(unique, 'newTask', bindings)
      expect(conflict).toBeNull()
    })
  })

  describe('bindingsEqual', () => {
    it('returns true for identical bindings', () => {
      const a: KeyBinding = { key: 'n', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
      expect(bindingsEqual(a, a)).toBe(true)
    })

    it('returns false for different keys', () => {
      const a: KeyBinding = { key: 'n', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
      const b: KeyBinding = { key: 'm', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
      expect(bindingsEqual(a, b)).toBe(false)
    })
  })

  describe('formatBinding', () => {
    it('formats Cmd+Shift+] correctly', () => {
      const binding: KeyBinding = { key: ']', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
      expect(formatBinding(binding)).toBe('⇧⌘]')
    })

    it('formats Cmd+Enter correctly', () => {
      const binding: KeyBinding = { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
      expect(formatBinding(binding)).toBe('⌘⏎')
    })

    it('formats Escape correctly', () => {
      const binding: KeyBinding = { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }
      expect(formatBinding(binding)).toBe('⎋')
    })

    it('formats Option+Cmd+B correctly', () => {
      const binding: KeyBinding = { key: 'b', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }
      expect(formatBinding(binding)).toBe('⌥⌘B')
    })
  })
})
