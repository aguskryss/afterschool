import { useCallback, useEffect, useRef, useState } from 'react'
import { Eraser } from 'lucide-react'

/** Logical drawing surface. The element is scaled to fit; strokes are stored
 *  against these coordinates so the exported PNG is the same size on a phone
 *  and on a laptop. */
const WIDTH = 600
const HEIGHT = 200
const LINE_WIDTH = 2.5

/**
 * Where the person collecting a child signs for them.
 *
 * A canvas rather than a library: the only thing needed is a stroke and a PNG,
 * and `web/src/lib/image.ts` already establishes that canvas-to-image works
 * here. A dependency would be more code, not less.
 *
 * Emits `null` until there is a stroke, so the caller can disable its confirm
 * button on that alone rather than tracking emptiness itself.
 */
export function SignaturePad({
  onChange,
  disabled,
}: {
  onChange: (dataUrl: string | null) => void
  disabled?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  // Kept in a ref so the pointer handlers, which are attached once, never read
  // a stale onChange from a re-render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const prepare = useCallback((ctx: CanvasRenderingContext2D) => {
    // White, not transparent. A transparent PNG renders as an invisible
    // signature the moment anyone prints the record or opens it on a dark
    // background — which is precisely when it matters.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, WIDTH, HEIGHT)
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = LINE_WIDTH
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Back the canvas at device resolution so the stroke isn't soft on the
    // phone screens this is actually used on, then draw in logical units.
    const ratio = Math.min(window.devicePixelRatio || 1, 3)
    canvas.width = WIDTH * ratio
    canvas.height = HEIGHT * ratio
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(ratio, ratio)
    prepare(ctx)
  }, [prepare])

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * HEIGHT,
    }
  }

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    // Capture so a finger that slides off the canvas mid-stroke keeps drawing
    // instead of dropping the line where the edge happened to be.
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    const { x, y } = pointAt(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
    // A tap with no movement is still a mark, so put a dot down now.
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = pointAt(e)
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  const end = () => {
    if (!drawing.current) return
    drawing.current = false
    const canvas = canvasRef.current
    if (!canvas) return
    setHasInk(true)
    onChangeRef.current(canvas.toDataURL('image/png'))
  }

  const clear = () => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    prepare(ctx)
    setHasInk(false)
    onChangeRef.current(null)
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl border-2 border-dashed border-canvas-200 bg-white">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          aria-label="Signature"
          // touch-none is load-bearing: without it the browser treats a finger
          // drag as a scroll and nothing is ever drawn on a phone.
          className="block h-36 w-full touch-none"
          style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        />
        {!hasInk && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[0.82rem] font-semibold text-ink-300">
            Sign here
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <p className="text-[0.75rem] font-medium text-ink-400">
          Signing confirms you collected this child.
        </p>
        <button
          type="button"
          onClick={clear}
          disabled={!hasInk || disabled}
          className="flex items-center gap-1 rounded-xl px-2 py-1 text-[0.78rem] font-bold text-ink-500 transition-colors hover:bg-canvas-100 disabled:opacity-40"
        >
          <Eraser className="size-3.5" strokeWidth={2.4} />
          Clear
        </button>
      </div>
    </div>
  )
}
