import { useEffect, useCallback } from 'react'
import {
  type ShortcutId,
  type KeyBinding,
  loadBindings,
  matchShortcut,
} from '../lib/keyboard'

export interface ShortcutActions {
  onNewTask: () => void
  onOpenSettings: () => void
  onToggleSidebar: () => void
  onToggleStatusBar: () => void
  onSelectTaskByIndex: (index: number) => void
  onNextTask: () => void
  onPrevTask: () => void
  onInterrupt: () => void
  onEscape: () => void
  onShowShortcuts: () => void
}

/**
 * Global keyboard shortcut listener.
 * Attaches a `keydown` listener on `window` and dispatches to the provided actions.
 * Skips when the active element is an input/textarea/select (unless the shortcut
 * includes a modifier like Cmd/Option, which signals an app-level action).
 */
export function useKeyboardShortcuts(actions: ShortcutActions) {
  const handler = useCallback((e: KeyboardEvent) => {
    const bindings = loadBindings()
    const matched = matchShortcut(e, bindings)
    if (!matched) return

    // Protect text input: if user is typing in an input/textarea and the
    // shortcut has no modifier keys, ignore it (except Escape which always works).
    const active = document.activeElement
    const isTextEntry =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      (active?.getAttribute('contenteditable') === 'true')

    if (isTextEntry && matched !== 'escape') {
      const binding: KeyBinding = bindings[matched]
      // Allow through if Cmd (meta) or Option (alt) is held — these are app-level
      if (!binding.metaKey && !binding.altKey) return
    }

    // Prevent default browser behavior for our shortcuts
    e.preventDefault()
    e.stopPropagation()

    switch (matched) {
      case 'newTask':
        actions.onNewTask()
        break
      case 'openSettings':
        actions.onOpenSettings()
        break
      case 'toggleSidebar':
        actions.onToggleSidebar()
        break
      case 'toggleStatusBar':
        actions.onToggleStatusBar()
        break
      case 'selectTask1': case 'selectTask2': case 'selectTask3':
      case 'selectTask4': case 'selectTask5': case 'selectTask6':
      case 'selectTask7': case 'selectTask8': case 'selectTask9': {
        const index = parseInt(matched.slice(-1), 10) - 1
        actions.onSelectTaskByIndex(index)
        break
      }
      case 'nextTask':
        actions.onNextTask()
        break
      case 'prevTask':
        actions.onPrevTask()
        break
      case 'interrupt':
        actions.onInterrupt()
        break
      case 'escape':
        actions.onEscape()
        break
      case 'showShortcuts':
        actions.onShowShortcuts()
        break
    }
  }, [actions])

  useEffect(() => {
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handler])
}
