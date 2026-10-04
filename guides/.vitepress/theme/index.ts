import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'

/** Click a picture to see it full size; click again (or Esc) to put it back. */
function zoomPictures() {
  document.addEventListener('click', (e) => {
    const open = document.querySelector('.zoomed')
    if (open) return open.remove()
    const img = (e.target as HTMLElement).closest?.('.vp-doc img') as HTMLImageElement | null
    if (!img) return
    const big = document.createElement('div')
    big.className = 'zoomed'
    big.append(Object.assign(new Image(), { src: img.src, alt: img.alt }))
    document.body.append(big)
  })
  document.addEventListener('keydown', (e) => e.key === 'Escape' && document.querySelector('.zoomed')?.remove())
}

/**
 * The pictures are taken at twice their size (so they're sharp): each is shown at its real size, or the page's width
 * if that's smaller, instead of being stretched.
 */
function sizePictures() {
  const fit = (img: HTMLImageElement) => img.naturalWidth && (img.style.width = `${Math.round(img.naturalWidth / 2)}px`)
  document.addEventListener('load', (e) => e.target instanceof HTMLImageElement && e.target.closest('.vp-doc') && fit(e.target), true)
  new MutationObserver(() => document.querySelectorAll<HTMLImageElement>('.vp-doc img').forEach((img) => img.complete && fit(img))).observe(
    document.body,
    {
      childList: true,
      subtree: true,
    },
  )
}

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (typeof document === 'undefined') return
    zoomPictures()
    sizePictures()
  },
} satisfies Theme
