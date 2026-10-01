import { swallowClick } from './pointerDrag'

/**
 * Moving a scroll area by dragging its empty parts with a mouse, like a hand tool: a mouse wheel only scrolls up and
 * down, so a wide board is otherwise reached by its scrollbar. (Fingers and trackpads already scroll both ways.)
 */

/** Pixels to move before it pans, so a click stays a click. */
const SLOP = 4

/** Where it can't start: things that are clicked, typed in or picked up. */
const IGNORE = 'button, a, input, textarea, select, label, [contenteditable="true"], [role="button"], [data-drag], [data-no-drag]'

/** Pressed on an element's own scrollbar (it lies outside the element's content box). */
function onScrollbar(e: PointerEvent, el: HTMLElement) {
  const r = el.getBoundingClientRect()
  return e.clientX - r.left - el.clientLeft >= el.clientWidth || e.clientY - r.top - el.clientTop >= el.clientHeight
}

/** Starts watching a mouse that went down inside `area`. Call from `onPointerDown`. */
export function panScroll(e: React.PointerEvent<HTMLElement> | PointerEvent, area: HTMLElement) {
  if (e.pointerType !== 'mouse' || e.button !== 0 || !e.isPrimary) return
  const target = e.target as HTMLElement
  if (target.closest(IGNORE) || onScrollbar(e as PointerEvent, target)) return

  const id = e.pointerId
  const from = { x: e.clientX, y: e.clientY, left: area.scrollLeft, top: area.scrollTop }
  let panning = false

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    const dx = ev.clientX - from.x
    const dy = ev.clientY - from.y
    if (!panning) {
      if (Math.hypot(dx, dy) < SLOP) return
      panning = true
      document.documentElement.classList.add('dragging')
      window.getSelection()?.removeAllRanges()
      // Keep following the mouse when it leaves the window.
      try {
        area.setPointerCapture(id)
      } catch {
        // The pointer is already gone: the next event ends it.
      }
    }
    area.scrollLeft = from.left - dx
    area.scrollTop = from.top - dy
  }
  const finish = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    if (!panning) return
    document.documentElement.classList.remove('dragging')
    swallowClick()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}
