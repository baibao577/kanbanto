/**
 * Drag and drop with pointer events, so it works with a mouse, a pen and a finger alike (the browser's own
 * drag-and-drop doesn't work on touch screens).
 *
 * - Mouse: the drag starts once the pointer has moved a few pixels, so a click stays a click.
 * - Touch and pen: press and hold briefly to pick the item up. Moving the finger sooner scrolls the page as usual.
 * - While dragging, a copy of the item follows the pointer, scroll areas scroll when the pointer nears their edge,
 *   and Escape cancels. The click that would follow the drop is swallowed.
 *
 * What's under the pointer is up to the caller: `move` gets the pointer position (again after auto-scrolling) and
 * `drop` the position where it was let go.
 */

export interface DragCallbacks {
  /** The pointer moved, or the page scrolled under it. */
  move(x: number, y: number): void
  /** Let go at this point. */
  drop(x: number, y: number): void
  /** Always called last, after a drop or a cancel. */
  end(): void
}

export interface DragOptions {
  /** The element that follows the pointer (a copy of it is shown). */
  ghost: HTMLElement
  /** The drag really starts: set up, and return what to do next (or null to not drag after all). */
  start(): DragCallbacks | null
}

/** Mouse: pixels to move before a drag starts. */
const MOUSE_SLOP = 5
/** Touch and pen: how long to hold, and how far the finger may wander meanwhile. */
const HOLD_MS = 250
const HOLD_SLOP = 8
/** Auto-scroll: how close to an edge it starts, and the top speed (pixels per frame). */
export const EDGE = 56
const MAX_SPEED = 18
const GHOST_MAX_WIDTH = 420

/** Where the drag can't start: typing, and buttons that open a menu. */
const IGNORE = 'input, textarea, select, [contenteditable="true"], [aria-haspopup], [data-no-drag]'

/** Pointers that are down but haven't started dragging: only the first one counts. */
let busy = false

/** Scroll speed for a pointer at `pos` within [start, end]: negative near the start, positive near the end. */
export function edgeSpeed(pos: number, start: number, end: number): number {
  const size = Math.min(EDGE, (end - start) / 3)
  if (size <= 0) return 0
  if (pos < start + size) return -Math.ceil(MAX_SPEED * Math.min(1, (start + size - pos) / size))
  if (pos > end - size) return Math.ceil(MAX_SPEED * Math.min(1, (pos - (end - size)) / size))
  return 0
}

/** Starts watching a pointer that went down on something draggable. Call from `onPointerDown`. */
export function pointerDrag(e: React.PointerEvent<HTMLElement> | PointerEvent, opts: DragOptions) {
  if (busy || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
  if ((e.target as Element).closest(IGNORE)) return
  busy = true

  const touch = e.pointerType !== 'mouse'
  const origin = { x: e.clientX, y: e.clientY }
  const pointer = { ...origin }
  const id = e.pointerId
  let session: DragCallbacks | null = null
  let ghost: HTMLElement | null = null
  let grab = { x: 0, y: 0 }
  let frame = 0
  let hold = touch ? window.setTimeout(activate, HOLD_MS) : 0

  function activate() {
    hold = 0
    const rect = opts.ghost.getBoundingClientRect()
    grab = { x: Math.min(pointer.x - rect.left, GHOST_MAX_WIDTH - 16), y: pointer.y - rect.top }
    ghost = makeGhost(opts.ghost, rect)
    session = opts.start()
    if (!session) {
      ghost.remove()
      return finish()
    }
    document.body.append(ghost)
    // Rows of a table have no background of their own (only on hover): without one, the page would show through.
    if (getComputedStyle(ghost).backgroundColor === 'rgba(0, 0, 0, 0)') ghost.style.backgroundColor = 'var(--card)'
    document.documentElement.classList.add('dragging')
    window.getSelection()?.removeAllRanges()
    // Let events reach whatever is under the finger (touch pointers stick to where they went down).
    const target = e.target as Element
    if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id)
    if (touch) navigator.vibrate?.(10)
    place()
    session.move(pointer.x, pointer.y)
    frame = requestAnimationFrame(autoScroll)
  }

  function place() {
    if (ghost) ghost.style.transform = `translate(${pointer.x - grab.x}px, ${pointer.y - grab.y}px) rotate(2deg)`
  }

  /** Scrolls the scroll areas under the pointer when it's near their edge, then re-checks what's under it. */
  function autoScroll() {
    if (!session) return
    let moved = false
    let el = document.elementFromPoint(pointer.x, pointer.y)
    let dx = true
    let dy = true
    for (; el && (dx || dy); el = el.parentElement) {
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (dx && /auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth) {
        const v = edgeSpeed(pointer.x, r.left, r.right)
        if (v && canScroll(el.scrollLeft, el.scrollWidth - el.clientWidth, v)) {
          el.scrollLeft += v
          dx = false
          moved = true
        }
      }
      if (dy && /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight) {
        const v = edgeSpeed(pointer.y, r.top, r.bottom)
        if (v && canScroll(el.scrollTop, el.scrollHeight - el.clientHeight, v)) {
          el.scrollTop += v
          dy = false
          moved = true
        }
      }
    }
    if (moved) session.move(pointer.x, pointer.y)
    frame = requestAnimationFrame(autoScroll)
  }

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    pointer.x = ev.clientX
    pointer.y = ev.clientY
    const far = Math.hypot(pointer.x - origin.x, pointer.y - origin.y)
    if (!session) {
      if (touch && far > HOLD_SLOP)
        finish() // a scroll or a swipe, not a drag
      else if (!touch && far > MOUSE_SLOP) activate()
      return
    }
    place()
    session.move(pointer.x, pointer.y)
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    if (session) {
      pointer.x = ev.clientX
      pointer.y = ev.clientY
      session.drop(pointer.x, pointer.y)
      swallowClick()
    }
    finish()
  }
  const onCancel = (ev: PointerEvent) => ev.pointerId === id && finish()
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !session) return
    ev.preventDefault()
    ev.stopPropagation()
    finish()
  }
  // Once an item is picked up, the finger drags it instead of scrolling the page.
  const onTouchMove = (ev: TouchEvent) => session && ev.cancelable && ev.preventDefault()
  // A long press would otherwise open the browser's menu, or select text.
  const block = (ev: Event) => (session || hold) && ev.preventDefault()

  function finish() {
    if (hold) window.clearTimeout(hold)
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('touchmove', onTouchMove)
    window.removeEventListener('contextmenu', block)
    document.removeEventListener('selectstart', block)
    ghost?.remove()
    document.documentElement.classList.remove('dragging')
    const s = session
    session = null
    busy = false
    s?.end()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('touchmove', onTouchMove, { passive: false })
  window.addEventListener('contextmenu', block)
  document.addEventListener('selectstart', block)
}

const canScroll = (pos: number, max: number, v: number) => (v < 0 ? pos > 0 : pos < max - 0.5)

function makeGhost(source: HTMLElement, rect: DOMRect): HTMLElement {
  const g = source.cloneNode(true) as HTMLElement
  g.removeAttribute('id')
  g.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
  g.setAttribute('aria-hidden', 'true')
  g.inert = true
  g.classList.remove('opacity-40')
  Object.assign(g.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    margin: '0',
    width: `${Math.min(rect.width, GHOST_MAX_WIDTH)}px`,
    maxHeight: '60vh',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '1000',
    opacity: '0.95',
    boxShadow: '0 12px 28px -6px rgb(0 0 0 / 0.3)',
    transformOrigin: '0 0',
    willChange: 'transform',
  })
  return g
}

/** After a drop, the browser may still send a click to what's under the pointer: ignore it. */
function swallowClick() {
  const stop = (ev: MouseEvent) => {
    ev.stopPropagation()
    ev.preventDefault()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 300)
}
