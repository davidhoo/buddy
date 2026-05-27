import { useEffect, useState, useCallback } from 'react'
import { BuddyTheme, applyTheme, getDefaultTheme, getThemeFromCustom, getThemeById } from '../themes'

export type ThemeMode = 'light' | 'dark' | 'system'

export interface ThemeState {
  mode: ThemeMode
  themeId: string
  custom: Partial<Pick<BuddyTheme, 'surface' | 'ink' | 'accent' | 'success' | 'danger' | 'contrast'>>
  resolvedMode: 'light' | 'dark'
  theme: ThemeMode
  setMode: (mode: ThemeMode) => void
  setThemeId: (id: string) => void
  setCustom: (patch: ThemeState['custom']) => void
  resetCustom: () => void
  setTheme: (mode: ThemeMode) => void
}

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? getSystemTheme() : mode
}

function loadMode(): ThemeMode {
  try {
    const saved = localStorage.getItem('theme-mode')
    if (saved && ['light', 'dark', 'system'].includes(saved)) return saved as ThemeMode
    const legacy = localStorage.getItem('theme')
    if (legacy && ['light', 'dark', 'system'].includes(legacy)) return legacy as ThemeMode
  } catch {}
  return 'system'
}

function loadThemeId(): string {
  try {
    const saved = localStorage.getItem('theme-id')
    if (saved) return saved
  } catch {}
  return 'buddy-dark'
}

function loadCustom(): ThemeState['custom'] {
  try {
    const saved = localStorage.getItem('theme-custom')
    if (saved) return JSON.parse(saved)
  } catch {}
  return {}
}

function saveMode(mode: ThemeMode) {
  try { localStorage.setItem('theme-mode', mode) } catch {}
}

function saveThemeId(id: string) {
  try { localStorage.setItem('theme-id', id) } catch {}
}

function saveCustom(custom: ThemeState['custom']) {
  try {
    if (Object.keys(custom).length === 0) {
      localStorage.removeItem('theme-custom')
    } else {
      localStorage.setItem('theme-custom', JSON.stringify(custom))
    }
  } catch {}
}

function getResolvedTheme(mode: ThemeMode, themeId: string, custom: ThemeState['custom']): BuddyTheme {
  const resolvedMode = resolveMode(mode)
  const base = getThemeById(themeId) ?? getDefaultTheme(resolvedMode)
  const themeWithCorrectType = base.type === resolvedMode ? base : getDefaultTheme(resolvedMode)
  return getThemeFromCustom(themeWithCorrectType, custom)
}

export function useTheme(): ThemeState {
  const [mode, setModeState] = useState<ThemeMode>(loadMode)
  const [themeId, setThemeIdState] = useState<string>(loadThemeId)
  const [custom, setCustomState] = useState<ThemeState['custom']>(loadCustom)
  const resolvedMode = resolveMode(mode)

  const applyCurrentTheme = useCallback(() => {
    const theme = getResolvedTheme(mode, themeId, custom)
    applyTheme(theme)
  }, [mode, themeId, custom])

  useEffect(() => {
    applyCurrentTheme()
  }, [applyCurrentTheme])

  useEffect(() => {
    if (mode !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      applyCurrentTheme()
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [mode, applyCurrentTheme])

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode)
    saveMode(newMode)
  }, [])

  const setThemeId = useCallback((newId: string) => {
    setThemeIdState(newId)
    saveThemeId(newId)
    setCustomState({})
    saveCustom({})
  }, [])

  const setCustom = useCallback((patch: ThemeState['custom']) => {
    setCustomState((prev) => {
      const next = { ...prev, ...patch }
      saveCustom(next)
      return next
    })
  }, [])

  const resetCustom = useCallback(() => {
    setCustomState({})
    saveCustom({})
  }, [])

  return {
    mode,
    themeId,
    custom,
    resolvedMode,
    theme: mode,
    setMode,
    setThemeId,
    setCustom,
    resetCustom,
    setTheme: setMode,
  }
}
