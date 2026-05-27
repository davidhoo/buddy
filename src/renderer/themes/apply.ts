/** Theme application utilities */

import { BuddyTheme, DerivedTokens, deriveTokens } from './derive'

export function applyTheme(theme: BuddyTheme): void {
  const root = document.documentElement
  const tokens = deriveTokens(theme)

  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value)
  }

  root.classList.toggle('dark', theme.type === 'dark')
}

export function getDefaultTheme(type: 'dark' | 'light'): BuddyTheme {
  if (type === 'dark') {
    return {
      id: 'buddy-dark',
      name: 'Buddy Dark',
      type: 'dark',
      surface: '#18181a',
      ink: '#e8e8e3',
      accent: '#339cff',
      success: '#40c977',
      danger: '#fa423e',
      contrast: 60,
    }
  }
  return {
    id: 'buddy-light',
    name: 'Buddy Light',
    type: 'light',
    surface: '#f3f3f1',
    ink: '#1c1c1a',
    accent: '#339cff',
    success: '#00a240',
    danger: '#ba2623',
    contrast: 45,
  }
}

export function getThemeFromCustom(
  base: BuddyTheme,
  custom: Partial<Pick<BuddyTheme, 'surface' | 'ink' | 'accent' | 'success' | 'danger' | 'contrast'>>
): BuddyTheme {
  return {
    ...base,
    ...custom,
  }
}
