/**
 * Drag and drop with pointer events, so it works with a mouse, a pen and a finger alike (the browser's own
 * drag-and-drop doesn't work on touch screens).
 *
 * - Mouse: the drag starts once the pointer has moved a few pixels, so a click stays a click.
 * - Touch and pen: press and hold briefly to pick the item up. Moving the finger sooner scrolls the page as usual.
 * - While dragging, a copy of the item follows the pointer, scroll areas scroll when the pointer nears their edge,
 *   and Escape cancels. The click that would follow the drop is swallowed.
 * - Touch and pen, in a `paged` area (a board): the area holds still sideways, and moves one stop (one list) when
 *   the finger rests on the next one, at its side. Then it holds still again until the finger has come back in. On a
 *   small screen, scrolling freely under a finger that's always near an edge would keep moving the lists away.
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
  /** Touch and pen: the scroll area that moves sideways one stop at a time (`stops`: a selector for them, inside it). */
  paged?: { area: HTMLElement; stops: string }
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
/** Paged areas: how close to a side the pointer turns the page, and how long it has to rest there first. */
const PAGE_EDGE = 36
const PAGE_DWELL = 350
/** How long a page takes to slide in, and the most room left beside the stop it brings in. */
const PAGE_MS = 240
const PAGE_INSET = 72
const GHOST_MAX_WIDTH = 420

/** Where the drag can't start: typing, and buttons that open a menu. */
const IGNORE = 'input, textarea, select, [contenteditable="true"], [aria-haspopup], [data-no-drag]'

/** Pointers that are down but haven't started dragging: only the first one counts. */
let busy = false
/** An item has been picked up and is following the pointer. */
let carrying = false

// Once an item is picked up, the finger drags it instead of scrolling the page. This listens all the time, not just
// from when a finger goes down: a browser settles at the start of a touch whether the page may stop it from
// scrolling. Added later, Firefox for Android ignores it after a long press and scrolls the page under the item.
if (typeof window !== 'undefined') window.addEventListener('touchmove', (ev) => carrying && ev.cancelable && ev.preventDefault(), { passive: false })

/** Scroll speed for a pointer at `pos` within [start, end]: negative near the start, positive near the end. */
export function edgeSpeed(pos: number, start: number, end: number): number {
  const size = Math.min(EDGE, (end - start) / 3)
  if (size <= 0) return 0
  if (pos < start + size) return -Math.ceil(MAX_SPEED * Math.min(1, (start + size - pos) / size))
  if (pos > end - size) return Math.ceil(MAX_SPEED * Math.min(1, (pos - (end - size)) / size))
  return 0
}

/** Room left beside a stop brought into view: it sits in the middle when only one fits (a phone). */
export const pageInset = (areaWidth: number, stopWidth: number) => Math.max(8, Math.min((areaWidth - stopWidth) / 2, PAGE_INSET))

type Span = { left: number; right: number }

/**
 * The side of a paged area the pointer is asking for: it's on the part still showing of a stop that the side cuts
 * off, or right at the side. 0 anywhere else.
 */
export function pageSide(x: number, area: Span, stops: Span[]): -1 | 0 | 1 {
  if (x > area.right - PAGE_EDGE) return 1
  if (x < area.left + PAGE_EDGE) return -1
  const next = stops.find((s) => s.right > area.right + 0.5)
  if (next && x >= next.left) return 1
  const prev = stops.findLast((s) => s.left < area.left - 0.5)
  if (prev && x <= prev.right) return -1
  return 0
}

/**
 * How far to scroll a paged area to bring in the next stop on side `dir` that isn't fully in view (0 if there's
 * none): it ends up `inset` away from that side.
 */
export function pageStep(area: Span, stops: Span[], dir: -1 | 1, inset: number): number {
  if (dir === 1) {
    const next = stops.find((s) => s.right > area.right + 0.5)
    return next ? next.right - (area.right - inset) : 0
  }
  const prev = stops.findLast((s) => s.left < area.left - 0.5)
  return prev ? prev.left - (area.left + inset) : 0
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
  // Paging (touch only): the side the pointer is at, since when, and whether it has turned the page already (once
  // per visit: the pointer comes back in before it can turn another); and the page sliding in.
  const paged = touch ? opts.paged : undefined
  let side: { dir: -1 | 0 | 1; since: number; turned: boolean } = { dir: 0, since: 0, turned: false }
  let slide: { from: number; by: number; t0: number } | null = null
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
    carrying = true
    // Rows of a table have no background of their own (only on hover): without one, the page would show through.
    if (getComputedStyle(ghost).backgroundColor === 'rgba(0, 0, 0, 0)') ghost.style.backgroundColor = 'var(--card)'
    document.documentElement.classList.add('dragging')
    window.getSelection()?.removeAllRanges()
    // Let events reach whatever is under the finger (touch pointers stick to where they went down).
    const target = e.target as Element
    if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id)
    if (touch) navigator.vibrate?.(10)
    place()
    session.move(aimX(), pointer.y)
    frame = requestAnimationFrame(autoScroll)
  }

  const stopsOf = (area: HTMLElement, stops: string) => [...area.querySelectorAll<HTMLElement>(stops)].map((el) => el.getBoundingClientRect())

  /**
   * Where the item is aimed sideways. In a paged area the pointer is kept clear of the sides, so that held at a
   * side it aims at the stop in view (the one just brought in), not at the sliver of the next one under the finger.
   */
  function aimX() {
    if (!paged) return pointer.x
    const r = paged.area.getBoundingClientRect()
    const first = paged.area.querySelector<HTMLElement>(paged.stops)
    if (!first) return pointer.x
    const inset = pageInset(r.width, first.offsetWidth) + 4
    return Math.max(r.left + inset, Math.min(pointer.x, r.right - inset))
  }

  /** Slides a paged area to the next stop once the pointer has rested at its side. True if it scrolled. */
  function turnPage(now: number, area: HTMLElement, stops: string) {
    if (slide) {
      const t = Math.min(1, (now - slide.t0) / PAGE_MS)
      area.scrollLeft = slide.from + slide.by * (1 - (1 - t) ** 3)
      if (t === 1) slide = null
      return true
    }
    const r = area.getBoundingClientRect()
    const spans = stopsOf(area, stops)
    const dir = pageSide(pointer.x, r, spans)
    if (dir !== side.dir) side = { dir, since: now, turned: false }
    if (!dir || side.turned || now - side.since < PAGE_DWELL || !spans.length) return false
    side.turned = true
    const by = pageStep(r, spans, dir, pageInset(r.width, spans[0].width))
    const to = Math.max(0, Math.min(area.scrollLeft + by, area.scrollWidth - area.clientWidth))
    if (Math.abs(to - area.scrollLeft) < 1) return false
    slide = { from: area.scrollLeft, by: to - area.scrollLeft, t0: now }
    return false
  }

  function place() {
    if (ghost) ghost.style.transform = `translate(${pointer.x - grab.x}px, ${pointer.y - grab.y}px) rotate(2deg)`
  }

  /** Scrolls the scroll areas under the pointer when it's near their edge, then re-checks what's under it. */
  function autoScroll(now: number) {
    if (!session) return
    let moved = paged ? turnPage(now, paged.area, paged.stops) : false
    const x = aimX()
    let el = document.elementFromPoint(x, pointer.y)
    // A paged area only moves sideways a page at a time.
    let dx = !paged
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
    if (moved) session.move(x, pointer.y)
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
    session.move(aimX(), pointer.y)
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    if (session) {
      pointer.x = ev.clientX
      pointer.y = ev.clientY
      session.drop(aimX(), pointer.y)
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
  // A long press would otherwise open the browser's menu, or select text.
  const block = (ev: Event) => (session || hold) && ev.preventDefault()

  function finish() {
    if (hold) window.clearTimeout(hold)
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('contextmenu', block)
    document.removeEventListener('selectstart', block)
    ghost?.remove()
    document.documentElement.classList.remove('dragging')
    const s = session
    session = null
    busy = false
    carrying = false
    s?.end()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
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
export function swallowClick() {
  const stop = (ev: MouseEvent) => {
    ev.stopPropagation()
    ev.preventDefault()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 300)
}
