import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { createLowlight } from 'lowlight'
import { CODE_LANGS, DIAGRAM } from './codeLangs'

// What colours code: which of its words are keywords, strings, comments (highlight.js's grammars, through lowlight,
// which gives the pieces as data and not as HTML). The languages are the ones codeLangs.ts names. A file of its
// own, so it is fetched when a text has code in it: by the reader when it shows one, and with the editor.

export const lowlight = createLowlight({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
})
// (The other ways each is written. A diagram's text isn't coloured: it is a language to the editor all the same.)
lowlight.registerAlias(Object.fromEntries(CODE_LANGS.filter((l) => l.id !== DIAGRAM && l.also?.length).map((l) => [l.id, l.also!])))

/**
 * The same, for the editor's code block, which asks for a guess when a block doesn't say its language (or says one
 * we don't know): no guessing. Such a block is plain, written as it is read.
 */
export const colouring = {
  highlight: lowlight.highlight,
  listLanguages: lowlight.listLanguages,
  registered: lowlight.registered,
  highlightAuto: (code: string) => ({
    type: 'root' as const,
    children: [{ type: 'text' as const, value: code }],
    data: { language: undefined, relevance: 0 },
  }),
}

/** A piece of coloured code: words, or a stretch of them of some kind (`hljs-keyword`…). */
export type Piece = { type: 'text'; value: string } | { type: 'element'; properties?: { className?: string[] }; children: Piece[] }

/** Code as its pieces, for a language codeLangs.ts knows. */
export const colour = (code: string, lang: string): Piece[] => lowlight.highlight(lang, code).children as Piece[]
