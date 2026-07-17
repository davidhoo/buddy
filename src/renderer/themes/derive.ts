/** Theme token derivation engine */

import { mixHex, withAlpha, lighten, darken } from './color'

export interface BuddyTheme {
  id: string
  name: string
  type: 'dark' | 'light'
  surface: string
  ink: string
  accent: string
  success: string
  danger: string
  contrast: number
  overrides?: Record<string, string>
}

export interface DerivedTokens {
  '--bg': string
  '--bg-elevated': string
  '--bg-subtle': string
  '--bg-muted': string
  '--fg': string
  '--fg-secondary': string
  '--fg-muted': string
  '--fg-inverse': string
  '--border': string
  '--border-subtle': string
  '--accent': string
  '--accent-hover': string
  '--accent-soft': string
  '--accent-soft-hover': string
  '--accent-primary': string
  '--accent-primary-hover': string
  '--success-bg': string
  '--success-fg': string
  '--danger': string
  '--danger-hover': string
  '--status-running': string
  '--status-paused': string
  '--scrollbar-thumb': string
  '--scrollbar-thumb-hover': string
  '--actor-claude': string
  '--actor-codex': string
  '--actor-opencode': string
  '--actor-kimi': string
  '--actor-cursor': string
}

export function deriveTokens(theme: BuddyTheme): DerivedTokens {
  const { surface, ink, accent, success, danger, contrast, type, overrides } = theme
  const c = contrast / 100
  const isDark = type === 'dark'

  const bgElevated = isDark
    ? mixHex(surface, ink, 0.08 + c * 0.08)
    : mixHex(surface, '#ffffff', Math.min(1, 0.85 + c * 0.15))

  const bgSubtle = isDark
    ? withAlpha(ink, 0.02 + c * 0.02)
    : mixHex(surface, ink, 0.08 + c * 0.08)

  const bgMuted = isDark
    ? withAlpha(ink, 0.04 + c * 0.03)
    : mixHex(surface, ink, 0.12 + c * 0.10)

  const fgSecondary = withAlpha(ink, 0.65 + c * 0.10)
  const fgMuted = isDark
    ? withAlpha(ink, 0.42 + c * 0.13)
    : withAlpha(ink, 0.45 + c * 0.10)
  const fgInverse = surface

  const border = withAlpha(ink, 0.06 + c * 0.04)
  const borderSubtle = withAlpha(ink, 0.04 + c * 0.02)

  const accentPrimary = ink
  const accentPrimaryHover = isDark ? lighten(ink, 0.08) : darken(ink, 0.08)

  const accentHover = isDark ? lighten(accent, 0.12) : darken(accent, 0.08)
  const accentSoft = isDark
    ? mixHex('#000000', accent, 0.20 + c * 0.08)
    : mixHex(surface, accent, 0.11 + c * 0.04)
  const accentSoftHover = isDark
    ? lighten(accentSoft, 0.06)
    : darken(accentSoft, 0.04)

  const successBg = withAlpha(success, isDark ? 0.15 : 0.12)
  const dangerHover = isDark ? lighten(danger, 0.08) : darken(danger, 0.08)

  const statusRunning = success
  const statusPaused = withAlpha(ink, 0.5 + c * 0.1)

  const scrollbarThumb = withAlpha(ink, isDark ? 0.06 + c * 0.03 : 0.06 + c * 0.04)
  const scrollbarThumbHover = withAlpha(ink, isDark ? 0.10 + c * 0.04 : 0.10 + c * 0.05)

  const tokens: Record<string, string> = {
    '--bg': surface,
    '--bg-elevated': bgElevated,
    '--bg-subtle': bgSubtle,
    '--bg-muted': bgMuted,
    '--fg': ink,
    '--fg-secondary': fgSecondary,
    '--fg-muted': fgMuted,
    '--fg-inverse': fgInverse,
    '--border': border,
    '--border-subtle': borderSubtle,
    '--accent': accent,
    '--accent-hover': accentHover,
    '--accent-soft': accentSoft,
    '--accent-soft-hover': accentSoftHover,
    '--accent-primary': accentPrimary,
    '--accent-primary-hover': accentPrimaryHover,
    '--success-bg': successBg,
    '--success-fg': success,
    '--danger': danger,
    '--danger-hover': dangerHover,
    '--status-running': statusRunning,
    '--status-paused': statusPaused,
    '--scrollbar-thumb': scrollbarThumb,
    '--scrollbar-thumb-hover': scrollbarThumbHover,
    '--actor-claude': '#8b6dba',
    '--actor-codex': '#4a9bb5',
    '--actor-opencode': '#d97706',
    '--actor-kimi': '#2e7d32',
    '--actor-cursor': '#7c5cff',
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (tokens[key] !== undefined) {
        tokens[key] = value
      }
    }
  }

  return tokens as unknown as DerivedTokens
}
