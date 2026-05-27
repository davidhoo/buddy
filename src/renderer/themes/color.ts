/** Color utility functions for theme derivation */

export interface RGB {
  red: number
  green: number
  blue: number
}

export function parseHex(hex: string): RGB {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return { red: r, green: g, blue: b }
}

export function toHex(rgb: RGB): string {
  const r = Math.round(rgb.red).toString(16).padStart(2, '0')
  const g = Math.round(rgb.green).toString(16).padStart(2, '0')
  const b = Math.round(rgb.blue).toString(16).padStart(2, '0')
  return `#${r}${g}${b}`
}

export function toRgba(rgb: RGB, alpha: number): string {
  return `rgba(${Math.round(rgb.red)}, ${Math.round(rgb.green)}, ${Math.round(rgb.blue)}, ${alpha})`
}

export function lerpColor(a: RGB, b: RGB, ratio: number): RGB {
  return {
    red: a.red + (b.red - a.red) * ratio,
    green: a.green + (b.green - a.green) * ratio,
    blue: a.blue + (b.blue - a.blue) * ratio,
  }
}

export function mixHex(a: string, b: string, ratio: number): string {
  return toHex(lerpColor(parseHex(a), parseHex(b), ratio))
}

export function withAlpha(color: string, alpha: number): string {
  return toRgba(parseHex(color), alpha)
}

export function lighten(hex: string, amount: number): string {
  const rgb = parseHex(hex)
  return toHex({
    red: rgb.red + (255 - rgb.red) * amount,
    green: rgb.green + (255 - rgb.green) * amount,
    blue: rgb.blue + (255 - rgb.blue) * amount,
  })
}

export function darken(hex: string, amount: number): string {
  const rgb = parseHex(hex)
  return toHex({
    red: rgb.red * (1 - amount),
    green: rgb.green * (1 - amount),
    blue: rgb.blue * (1 - amount),
  })
}
