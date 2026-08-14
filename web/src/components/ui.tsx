import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/* ── Button ──────────────────────────────────────────────────────────── */

type Variant = 'primary' | 'coral' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-sky-500 text-white hover:bg-sky-600 active:bg-sky-700 shadow-soft',
  // Reserved for the single most urgent action on a screen.
  coral:
    'bg-coral-500 text-white hover:bg-coral-600 active:bg-coral-700 shadow-soft',
  outline:
    'border-2 border-canvas-200 bg-white text-ink-700 hover:bg-canvas-100 active:bg-canvas-200',
  ghost: 'text-ink-600 hover:bg-canvas-100 active:bg-canvas-200',
  danger: 'bg-berry-500 text-white hover:bg-berry-600',
}

/* Fully rounded — the pill shape is what stops this reading as an admin tool. */
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-4 text-sm gap-1.5',
  md: 'h-11 px-5 text-[0.95rem] gap-2',
  lg: 'h-14 px-7 text-[1.05rem] gap-2.5',
}

export function Button({
  variant = 'primary',
  size = 'md',
  full,
  loading,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  size?: Size
  full?: boolean
  loading?: boolean
}) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center rounded-full font-bold transition-all duration-150 active:scale-[0.98] disabled:opacity-45 disabled:pointer-events-none disabled:active:scale-100 ${VARIANTS[variant]} ${SIZES[size]} ${full ? 'w-full' : ''} ${className}`}
    >
      {loading && (
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  )
}

/* ── Card ────────────────────────────────────────────────────────────── */

export function Card({
  className = '',
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`rounded-card bg-white shadow-soft ${className}`}>
      {children}
    </div>
  )
}

/* ── Avatar ──────────────────────────────────────────────────────────── */

const KID_COLORS = [
  'var(--color-kid-1)',
  'var(--color-kid-2)',
  'var(--color-kid-3)',
  'var(--color-kid-4)',
  'var(--color-kid-5)',
  'var(--color-kid-6)',
]

/**
 * A child's colour is derived from their id, so it's the same every time on
 * every device — a parent (and a counselor scanning a roster) learns "Sofia
 * is the teal one" and stops reading names.
 */
export function colorForId(id: number): string {
  return KID_COLORS[id % KID_COLORS.length]
}

export function Avatar({
  name,
  id,
  size = 'md',
}: {
  name: string
  id: number
  size?: 'sm' | 'md' | 'lg'
}) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  const dims =
    size === 'lg'
      ? 'size-14 text-lg'
      : size === 'sm'
        ? 'size-9 text-xs'
        : 'size-11 text-sm'
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-extrabold text-white ${dims}`}
      style={{ background: colorForId(id) }}
    >
      {initials}
    </span>
  )
}

/* ── Field ───────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  error,
  id,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string
  hint?: string
  error?: string
}) {
  const inputId = id ?? `f-${label.toLowerCase().replace(/\W+/g, '-')}`
  const describedBy = error
    ? `${inputId}-err`
    : hint
      ? `${inputId}-hint`
      : undefined
  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        className="mb-1.5 block text-sm font-bold text-ink-700"
      >
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`h-13 w-full rounded-2xl border-2 bg-white px-4 py-3 text-[1rem] font-medium text-ink-900 outline-none transition placeholder:font-normal placeholder:text-ink-400 ${
          error
            ? 'border-berry-500 focus:border-berry-500'
            : 'border-canvas-200 focus:border-sky-500'
        }`}
      />
      {error ? (
        <p id={`${inputId}-err`} className="mt-1.5 text-sm text-berry-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="mt-1.5 text-sm text-ink-500">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/* ── Status pill ─────────────────────────────────────────────────────── */

type Status = 'leaf' | 'sun' | 'berry' | 'coral' | 'neutral'

const PILLS: Record<Status, string> = {
  leaf: 'bg-leaf-50 text-leaf-600',
  sun: 'bg-sun-50 text-sun-600',
  berry: 'bg-berry-50 text-berry-600',
  coral: 'bg-coral-50 text-coral-700',
  neutral: 'bg-canvas-100 text-ink-500',
}

export function Pill({
  status = 'neutral',
  children,
}: {
  status?: Status
  children: ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${PILLS[status]}`}
    >
      {children}
    </span>
  )
}

/* ── Empty & loading states ──────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && (
        <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-canvas-100 text-ink-400">
          {icon}
        </div>
      )}
      <p className="text-lg font-extrabold text-ink-800">{title}</p>
      {body && <p className="mt-1 max-w-xs text-[0.95rem] text-ink-500">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-2xl bg-canvas-200/70 ${className}`} />
  )
}
