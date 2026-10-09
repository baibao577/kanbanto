// A diagram written as text (a code block that says `mermaid`), drawn. Mermaid does the drawing, and is large: it is
// fetched the first time a text with a diagram is shown, never before.
//
// The drawing is shown as a picture (an image whose address holds the SVG), not put into the page as SVG:
//  - a picture can't run anything or fetch anything, whatever the diagram's text says. Descriptions never load
//    pictures from elsewhere (it would tell that site who is reading), and a diagram's labels can't either;
//  - a picture has no words in it for the page: the text shown keeps the letters of the text saved (the diagram's
//    code stays on the page, out of sight), which is what comments on words and the cursor go by.

export type Drawn = { uri: string; width: number; height: number } | { error: string }

type Mermaid = typeof import('mermaid').default
let fetched: Promise<Mermaid> | null = null
let dressed: boolean | null = null
let n = 0
/** (One at a time: Mermaid draws on the page to measure, and its settings are its own.) */
let line: Promise<unknown> = Promise.resolve()
const kept = new Map<string, Drawn>()

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

/** What went wrong, in a line (Mermaid says where it stopped reading). */
const said = (e: unknown) => {
  const lines = String((e as Error)?.message ?? e)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines[0] ?? 'This diagram can’t be drawn.').slice(0, 160)
}

/** Draws a diagram, light or dark. The same text is drawn once. Never throws: what can't be drawn says why. */
export function drawDiagram(code: string, dark: boolean): Promise<Drawn> {
  const key = `${dark ? 'dark' : 'light'}\n${code}`
  const had = kept.get(key)
  if (had) return Promise.resolve(had)
  const next = line.then(async (): Promise<Drawn> => {
    const again = kept.get(key)
    if (again) return again
    let out: Drawn
    const id = `diagram-${n++}`
    try {
      const mermaid = await (fetched ??= import('mermaid').then((m) => m.default))
      if (dressed !== dark) {
        mermaid.initialize({
          startOnLoad: false,
          // (No clicks, no scripts; and labels as plain text, not as HTML: belt and braces, since it is shown as a picture.)
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          suppressErrorRendering: true,
          theme: dark ? 'dark' : 'neutral',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        })
        dressed = dark
      }
      out = code.trim() ? asPicture((await mermaid.render(id, code)).svg) : { error: 'Nothing to draw yet.' }
    } catch (e) {
      out = { error: said(e) }
      // (What Mermaid put on the page to measure, when it stopped half way.)
      for (const left of [id, `d${id}`]) document.getElementById(left)?.remove()
    }
    if (kept.size > 80) kept.delete(kept.keys().next().value!)
    kept.set(key, out)
    return out
  })
  line = next.catch(() => {})
  return next
}

/** Whether the page is dark just now, and a way to be told when that changes. */
export const isDark = () => document.documentElement.classList.contains('dark')
export function watchDark(told: () => void): () => void {
  const o = new MutationObserver(told)
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => o.disconnect()
}
