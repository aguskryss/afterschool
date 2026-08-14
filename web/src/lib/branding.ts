import type { Organization } from './auth'

/**
 * Per-organization theming.
 *
 * The design system keeps every colour in CSS custom properties, so dressing
 * the app in a JCC's palette is a matter of overriding two variables and the
 * shades derived from them — no component knows an organization exists.
 *
 * Only the interactive primary and the urgent accent are themable. Status
 * colours (here / absent / pending) deliberately are not: those carry meaning,
 * and a JCC whose brand happens to be red should not end up with an "absent"
 * badge that reads as normal.
 */

/** #RRGGBB -> "r g b", the form colour-mix and alpha compositing want. */
function channels(hex: string): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/** Mix towards white (amount < 0) or black (amount > 0). */
function shade(hex: string, amount: number): string | null {
  const rgb = channels(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.split(' ').map(Number)
  const target = amount > 0 ? 0 : 255
  const t = Math.abs(amount)
  const mix = (c: number) => Math.round(c + (target - c) * t)
  return `#${[mix(r), mix(g), mix(b)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`
}

const DEFAULTS: Record<string, string> = {
  '--color-sky-50': '#eef4ff',
  '--color-sky-100': '#dbe6ff',
  '--color-sky-500': '#2f6fed',
  '--color-sky-600': '#2058ce',
  '--color-sky-700': '#1a46a3',
  '--color-coral-50': '#fff0ec',
  '--color-coral-100': '#ffdcd2',
  '--color-coral-500': '#ff5a36',
  '--color-coral-600': '#ea4220',
  '--color-coral-700': '#c03214',
}

export function applyBranding(org: Organization | null): void {
  const root = document.documentElement

  // Always start from the defaults, so switching accounts can't leave the
  // previous organization's colours behind.
  for (const [name, value] of Object.entries(DEFAULTS)) {
    root.style.setProperty(name, value)
  }
  if (!org) return

  const ramp = (base: string, prefix: string) => {
    if (!channels(base)) return
    root.style.setProperty(`${prefix}-500`, base)
    const s600 = shade(base, 0.15)
    const s700 = shade(base, 0.3)
    const s100 = shade(base, -0.78)
    const s50 = shade(base, -0.93)
    if (s600) root.style.setProperty(`${prefix}-600`, s600)
    if (s700) root.style.setProperty(`${prefix}-700`, s700)
    if (s100) root.style.setProperty(`${prefix}-100`, s100)
    if (s50) root.style.setProperty(`${prefix}-50`, s50)
  }

  if (org.brand_primary) ramp(org.brand_primary, '--color-sky')
  if (org.brand_accent) ramp(org.brand_accent, '--color-coral')
}
