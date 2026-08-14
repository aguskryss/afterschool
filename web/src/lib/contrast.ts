/**
 * Contrast, so a JCC's palette cannot make the app unreadable.
 *
 * brand_primary is not decoration: `--color-sky-500` is the fill behind white
 * text on every primary button, and brand_accent does the same for the urgent
 * ones. A JCC whose brand is a pale yellow gets white-on-yellow buttons that
 * are legible on the designer's monitor and invisible on a counselor's phone
 * in a sunlit playground.
 *
 * The console cannot refuse someone's actual brand colour — it is their brand.
 * So this exists to say so plainly at the moment of choosing, and to offer the
 * fix (dark text) rather than only the complaint.
 *
 * WCAG 2.1 relative luminance and contrast ratio. Thresholds used here:
 *   4.5  normal body text
 *   3.0  large text and UI component boundaries — the bar a button label on a
 *        coloured fill actually has to clear
 */

export type Legibility = {
  /** Contrast of white text on this colour. */
  onWhite: number
  /** Contrast of near-black text on this colour. */
  onInk: number
  /** Which foreground the button should use to stay readable. */
  prefer: 'white' | 'ink'
  /** True when neither foreground clears 3:1 — the colour itself is the problem. */
  unusable: boolean
}

const INK = '#101828'

function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function luminance(hex: string): number | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** How a brand colour behaves as a button fill. Null for a malformed hex. */
export function legibility(hex: string): Legibility | null {
  const onWhite = contrast(hex, '#ffffff')
  const onInk = contrast(hex, INK)
  if (onWhite === null || onInk === null) return null
  return {
    onWhite,
    onInk,
    prefer: onWhite >= onInk ? 'white' : 'ink',
    unusable: Math.max(onWhite, onInk) < 3,
  }
}
