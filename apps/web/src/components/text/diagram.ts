// A diagram written as text (a code block that says `mermaid`), drawn. Mermaid does the drawing, and is large: it is
// fetched the first time a text with a diagram is shown, never before.
//
// Nothing a diagram's text says can make the reader's browser ask another site for anything (it would tell that
// site who is reading), or run anything:
//  - it is drawn on a page of its own, loaded out of sight, that is allowed to load nothing but this site's scripts
//    (diagram.html, see diagramFrame.ts). Mermaid draws on the page it runs in to measure, and a diagram can name a
//    picture for a shape, a style with a background from elsewhere, a label made of HTML: on that page none of it
//    is asked for, whatever form it is written in;
//  - what comes back is the drawing as text, and it is shown as a picture (an image whose address holds the SVG),
//    not put into the page as SVG: a picture can't run or fetch anything either;
//  - a picture has no words in it for the page: the text shown keeps the letters of the text saved (the diagram's
//    code stays on the page, out of sight), which is what comments on words and the cursor go by.

export type Drawn = { uri: string; width: number; height: number } | { error: string }

/** What the app's page asks the page diagrams are drawn in, and what that page answers (see diagramFrame.ts). */
export type Asked = { kind: 'draw'; n: number; code: string; dark: boolean }
export type Answered = { kind: 'ready' } | ({ kind: 'drawn'; n: number } & ({ svg: string } | { error: string }))

/** How long the drawing page has to load, and then to draw one diagram. */
const LOAD_MS = 30_000
const DRAW_MS = 30_000

let n = 0
const kept = new Map<string, Drawn>()
const waiting = new Map<number, (out: { svg: string } | { error: string }) => void>()
let page: Promise<Window> | null = null
let frame: HTMLIFrameElement | null = null

/** The page diagrams are drawn in: made the first time one is, out of sight, and kept. */
function drawingPage(): Promise<Window> {
  return (page ??= new Promise<Window>((resolve, reject) => {
    const el = document.createElement('iframe')
    el.src = `${import.meta.env.BASE_URL}diagram.html`
    el.setAttribute('aria-hidden', 'true')
    el.setAttribute('inert', '')
    el.tabIndex = -1
    // (Laid out, since Mermaid measures what it draws; off the screen, and nothing to point at.)
    el.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;opacity:0;pointer-events:none'
    const late = setTimeout(() => {
      window.removeEventListener('message', hear)
      el.remove()
      page = frame = null
      reject(new Error('The page that draws diagrams didn’t load.'))
    }, LOAD_MS)
    const hear = (e: MessageEvent<Answered>) => {
      if (e.source !== el.contentWindow || e.origin !== location.origin) return
      if (e.data?.kind === 'ready') {
        clearTimeout(late)
        resolve(el.contentWindow!)
      } else if (e.data?.kind === 'drawn') {
        const { n: which, kind: _kind, ...out } = e.data
        waiting.get(which)?.(out)
        waiting.delete(which)
      }
    }
    window.addEventListener('message', hear)
    frame = el
    document.body.append(el)
  }))
}

/** The SVG as a picture of its own size (Mermaid sizes it to its box: a picture has none). */
function asPicture(svg: string): Drawn {
  const box = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg)
  const width = Math.ceil(Number(box?.[1] ?? 0))
  const height = Math.ceil(Number(box?.[2] ?? 0))
  if (!width || !height) return { error: 'This diagram came out empty.' }
  const sized = svg.replace(/<svg\b([^>]*)>/, (_, attrs: string) => {
    const rest = attrs.replace(/\s(?:width|height|style)="[^"]*"/g, '')
    return `<svg${rest} width="${width}" height="${height}">`
  })
  return { uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`, width, height }
}

/** Draws a diagram, light or dark. The same text is drawn once. Never throws: what can't be drawn says why. */
export async function drawDiagram(code: string, dark: boolean): Promise<Drawn> {
  const key = `${dark ? 'dark' : 'light'}\n${code}`
  const had = kept.get(key)
  if (had) return had
  if (!code.trim()) return { error: 'Nothing to draw yet.' }
  let out: Drawn
  try {
    const to = await drawingPage()
    const which = n++
    const answer = await new Promise<{ svg: string } | { error: string }>((resolve) => {
      waiting.set(which, resolve)
      setTimeout(() => {
        if (!waiting.delete(which)) return
        // (It may be stuck on this one: the next diagram gets a page of its own.)
        frame?.remove()
        page = frame = null
        resolve({ error: 'This diagram took too long to draw.' })
      }, DRAW_MS)
      to.postMessage({ kind: 'draw', n: which, code, dark } satisfies Asked, location.origin)
    })
    out = 'svg' in answer ? asPicture(answer.svg) : answer
  } catch (e) {
    return { error: String((e as Error)?.message ?? 'This diagram can’t be drawn.') }
  }
  const again = kept.get(key)
  if (again) return again
  if (kept.size > 80) kept.delete(kept.keys().next().value!)
  kept.set(key, out)
  return out
}

/** Whether the page is dark just now, and a way to be told when that changes. */
export const isDark = () => document.documentElement.classList.contains('dark')
export function watchDark(told: () => void): () => void {
  const o = new MutationObserver(told)
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => o.disconnect()
}
