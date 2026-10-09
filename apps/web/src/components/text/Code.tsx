import { Code as CodeIcon, Copy, TreeStructure } from '@phosphor-icons/react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { copyText } from '@/lib/copy'
import { DIAGRAM, langOf } from './codeLangs'
import { drawDiagram, isDark, watchDark, type Drawn } from './diagram'
import type { Piece } from './highlight'

// A code block as it is read: its words coloured when it says what language it is in, the language named, and a
// button to copy it; or, when it is a diagram written as text, the diagram.
//
// The page holds the code's own letters and no others, as everywhere (see caret.ts and passages.ts): the language's
// name is shown by the stylesheet, the buttons are icons, and a diagram is a picture with its text kept out of sight.

const pieces = (list: Piece[], key = ''): ReactNode =>
  list.map((p, i) =>
    p.type === 'text' ? (
      p.value
    ) : (
      <span key={`${key}${i}`} className={p.properties?.className?.join(' ')}>
        {pieces(p.children, `${key}${i}.`)}
      </span>
    ),
  )

/** `lang`: what stands after the fence (```ts), if anything. */
export function Code({ text, lang }: { text: string; lang?: string }) {
  const known = langOf(lang)
  if (known?.id === DIAGRAM) return <Diagram code={text} />
  return <Coloured text={text} lang={known?.id} label={known?.label} />
}

function Coloured({ text, lang, label }: { text: string; lang?: string; label?: string }) {
  // (What colours code is fetched when there is code to colour; until it has come, the code is shown plain.)
  const [coloured, setColoured] = useState<{ of: string; pieces: Piece[] } | null>(null)
  useEffect(() => {
    if (!lang) return
    let on = true
    void import('./highlight').then(
      (h) => on && setColoured({ of: `${lang}\n${text}`, pieces: h.colour(text, lang) }),
      () => {},
    )
    return () => {
      on = false
    }
  }, [text, lang])
  return (
    <div className="md-code" data-lang={label}>
      <button
        type="button"
        className="md-code-tool"
        aria-label="Copy the code"
        title="Copy the code"
        onClick={(e) => {
          e.stopPropagation()
          void copyText(text, 'Code')
        }}
      >
        <Copy />
      </button>
      <pre>
        <code>{lang && coloured?.of === `${lang}\n${text}` ? pieces(coloured.pieces) : text}</code>
      </pre>
    </div>
  )
}

const dark = { subscribe: watchDark, now: isDark, never: () => false }

function Diagram({ code }: { code: string }) {
  const isDarkNow = useSyncExternalStore(dark.subscribe, dark.now, dark.never)
  const [drawn, setDrawn] = useState<{ of: string; as: Drawn } | null>(null)
  const [asCode, setAsCode] = useState(false)
  const of = `${isDarkNow}\n${code}`
  useEffect(() => {
    let on = true
    void drawDiagram(code, isDarkNow).then((as) => on && setDrawn({ of, as }))
    return () => {
      on = false
    }
  }, [code, isDarkNow, of])
  const now = drawn?.of === of ? drawn.as : null
  const picture = now && 'uri' in now ? now : null
  const shown = !!picture && !asCode
  return (
    <figure
      className="md-diagram"
      // (Why it isn't drawn is said by the stylesheet: the page holds the text's own letters only.)
      data-error={now && 'error' in now ? now.error : undefined}
      data-drawing={now ? undefined : ''}
    >
      {picture && (
        <button
          type="button"
          className="md-code-tool"
          aria-pressed={asCode}
          aria-label={asCode ? 'Show the diagram' : 'Show the diagram’s text'}
          title={asCode ? 'Show the diagram' : 'Show the diagram’s text'}
          onClick={(e) => {
            e.stopPropagation()
            setAsCode((c) => !c)
          }}
        >
          {asCode ? <TreeStructure /> : <CodeIcon />}
        </button>
      )}
      {shown && <img src={picture.uri} width={picture.width} height={picture.height} alt="" draggable={false} />}
      {/* The diagram's text: what is shown until it is drawn, and when it can't be; out of sight once it is. */}
      <pre className={shown ? 'sr-only' : undefined}>
        <code>{code}</code>
      </pre>
    </figure>
  )
}
