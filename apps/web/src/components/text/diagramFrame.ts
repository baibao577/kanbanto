// Where diagrams are drawn: this is the script of diagram.html, a page of its own that the app loads out of sight
// (see diagram.ts, which asks it and waits for the answer).
//
// Mermaid draws on the page it runs in, to measure, and a diagram's text can name things to load: a picture for a
// node's shape, a style with a background from somewhere, a label made of HTML. Drawn on the app's own page, the
// reader's browser would ask those other sites for them, which tells them who is reading and when. This page is
// not allowed to load anything but this site's scripts (its content policy: no pictures, styles, fonts or
// connections at all), so nothing a diagram names is ever asked for. What goes back is the drawing as text, which
// the app shows as a picture.

import type { Asked, Answered } from './diagram'

type Mermaid = typeof import('mermaid').default
let fetched: Promise<Mermaid> | null = null
let dressed: boolean | null = null
/** (One at a time: Mermaid draws on the page to measure, and its settings are its own.) */
let line: Promise<unknown> = Promise.resolve()

/** What went wrong, in a line (Mermaid says where it stopped reading). */
const said = (e: unknown) => {
  const lines = String((e as Error)?.message ?? e)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return (lines[0] ?? 'This diagram can’t be drawn.').slice(0, 160)
}

async function draw(n: number, code: string, dark: boolean): Promise<{ svg: string } | { error: string }> {
  const id = `diagram-${n}`
  try {
    const mermaid = await (fetched ??= import('mermaid').then((m) => m.default))
    if (dressed !== dark) {
      mermaid.initialize({
        startOnLoad: false,
        // (No clicks, no scripts; and labels as plain text, not as HTML: belt and braces, on a page that can load nothing.)
        securityLevel: 'strict',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        suppressErrorRendering: true,
        theme: dark ? 'dark' : 'neutral',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
        // A diagram is a page of a description, not a map of everything: one too big to lay out in a moment isn't drawn.
        maxTextSize: 20_000,
        maxEdges: 300,
        // What a diagram's own text may not set for itself, besides Mermaid's own list: how it is styled and whether
        // labels are HTML.
        secure: [
          'secure',
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'suppressErrorRendering',
          'maxEdges',
          'themeCSS',
          'fontFamily',
          'altFontFamily',
          'htmlLabels',
        ],
      })
      dressed = dark
    }
    return { svg: (await mermaid.render(id, code)).svg }
  } catch (e) {
    // (What Mermaid put on the page to measure, when it stopped half way.)
    for (const left of [id, `d${id}`]) document.getElementById(left)?.remove()
    return { error: said(e) }
  }
}

// Asked by the app's page, and only by it: the page this one sits in, on this site.
window.addEventListener('message', (e: MessageEvent<Asked>) => {
  if (e.origin !== location.origin || e.source !== window.parent || e.data?.kind !== 'draw') return
  const { n, code, dark } = e.data
  line = line
    .then(() => draw(n, String(code), !!dark))
    .then((out) => window.parent.postMessage({ kind: 'drawn', n, ...out } satisfies Answered, location.origin))
})
if (window.parent !== window) window.parent.postMessage({ kind: 'ready' } satisfies Answered, location.origin)
