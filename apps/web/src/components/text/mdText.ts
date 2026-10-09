import { Lexer, type Token } from 'marked'
import type { AttachmentView } from '@kanbanto/model/api'
import { FILE_MARK } from '@/components/task/RichText'

/**
 * Descriptions and comments are stored as Markdown (what assistants and the API read and write). These are the small
 * text helpers the editor and the display share.
 */

/**
 * Whether a piece of HTML in the text is nothing but line breaks written as tags ("<br>"): the one piece of HTML
 * that is shown as what it means and not as text, since it is how a table's cell has two lines in Markdown.
 */
export const isBreak = (html: string) => /^(?:\s*<br\s*\/?>)+\s*$/i.test(html)

/**
 * What the editor saves, tidied: no escapes a person didn't type (underscores inside words, like "📎plan_v2.pdf",
 * never start emphasis; a lone "&" needs no entity; a footnote's mark keeps its brackets), and no blank lines around
 * it. "<br>" typed as words stays written as "&lt;br&gt;": written as the tag it would be a line break.
 */
export function tidyMarkdown(md: string): string {
  return md
    .replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, '_')
    .replace(/\\\[\^([^\]\s\\]+)\\\]/g, '[^$1]')
    .replace(/&lt;br\s*\/?&gt;|&lt;|&gt;/gi, (m) => (m.length > 4 ? m : m === '&lt;' ? '<' : '>'))
    .replace(/&amp;(?![a-zA-Z0-9#]+;)/g, '&')
    .trim()
}

/**
 * Text for the editor: "<" outside code written as "&lt;", so something that looks like HTML ("<script>" in a note
 * about it) stays text instead of being read as HTML and dropped. (tidyMarkdown turns it back.) A line break
 * written as a tag ("<br>") is left: the editor reads it as the line break it is.
 */
export function forEditor(md: string): string {
  let fenced = false
  return md
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) fenced = !fenced
      if (fenced || FENCE.test(line)) return line
      // Leave `code spans` alone.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : part.replace(/<(?!br\s*\/?>)/gi, '&lt;')))
        .join('')
    })
    .join('\n')
}

const FENCE = /^\s{0,3}(```|~~~)/
// (A checklist can be inside a quote or a callout: the ">" before it.)
const TASK = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/

/** Ticks or unticks the `n`th checklist item ("- [ ] …") in the text, counting in order and skipping code blocks. */
export function toggleTask(text: string, n: number): string {
  const lines = text.split('\n')
  let fenced = false
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced
    if (fenced) continue
    const m = TASK.exec(lines[i])
    if (!m) continue
    if (seen++ === n) {
      lines[i] = lines[i].replace(TASK, (_, a, mark, b) => `${a}${mark === ' ' ? 'x' : ' '}${b}`)
      return lines.join('\n')
    }
  }
  return text
}

/** Markdown as marked's tokens: line breaks count (as people type them), plus GitHub's tables, checklists, ~~strike~~. */
export const lex = (text: string) => new Lexer({ gfm: true, breaks: true }).lex(text)

const plain = (s: string) =>
  s
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e]!)
    .replace(/[*_`~]/g, '')

/**
 * The top-level headings, for a table of contents (numbered like Markdown's `headingIds`: h-0, h-1…). `slug`: what
 * a heading says, as it goes in an address ("Who to ask" is who-to-ask; said twice, the second is who-to-ask-2):
 * a link to a section, and a fold kept on it, go by it.
 */
export function headingsOf(text: string): { id: string; depth: number; text: string; slug: string }[] {
  const slug = slugger()
  return lex(text)
    .filter((t: Token): t is Token & { type: 'heading'; depth: number; text: string } => t.type === 'heading')
    .map((t, i) => ({ id: `h-${i}`, depth: t.depth, text: plain(t.text), slug: slug(plain(t.text)) }))
}

/** Gives each heading of one text its slug, in order (the same words said again get a number: see `headingsOf`). */
export function slugger(): (words: string) => string {
  const said = new Map<string, number>()
  return (words) => {
    const slug =
      words
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'section'
    const n = (said.get(slug) ?? 0) + 1
    said.set(slug, n)
    return n > 1 ? `${slug}-${n}` : slug
  }
}

/**
 * What is put away when some headings are folded: for each top-level piece of the text, the folded headings it is
 * under (a heading folds everything down to the next heading of its size or bigger, smaller headings with it), and
 * for each folded heading how many words it puts away.
 */
export function foldedParts(tokens: Token[], folded: ReadonlySet<number>): { under: number[][]; words: Map<number, number> } {
  const under: number[][] = []
  const words = new Map<number, number>()
  let open: { i: number; depth: number }[] = []
  let heading = 0
  for (const t of tokens) {
    const h = t.type === 'heading' ? (t as Token & { depth: number }) : null
    if (h) open = open.filter((o) => o.depth < h.depth)
    under.push(open.map((o) => o.i))
    if (open.length && t.type !== 'space') {
      const n = countWords(t.raw)
      for (const o of open) words.set(o.i, (words.get(o.i) ?? 0) + n)
    }
    if (h) {
      if (folded.has(heading)) open = [...open, { i: heading, depth: h.depth }]
      heading++
    }
  }
  return { under, words }
}

/**
 * Whether pasted plain text is Markdown to format (a heading, a list, a checklist, a quote, a table, a code fence,
 * **bold**, a [link](…)), rather than words to put in as they are.
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^ {0,3}#{1,6} +\S/m.test(text) ||
    /^[ \t]*(?:[-*+]|\d{1,9}[.)]) +\S/m.test(text) ||
    /^ {0,3}> ?\S/m.test(text) ||
    /^ {0,3}(```|~~~)/m.test(text) ||
    /^ {0,3}\|.+\|[ \t]*\r?\n {0,3}(?=[ \t:|-]*-{3})[ \t:|-]+$/m.test(text) ||
    /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(text) ||
    /\*\*[^*\n]+\*\*|__[^_\n]+__/.test(text) ||
    /\[[^\]\n]+\]\((?:https?:|mailto:|\/)[^)\s]*\)/.test(text)
  )
}

/**
 * How many words a text has, whatever the language (Thai and Japanese have no spaces between words: the browser knows
 * where they end). Markdown's own marks, and a link's address, aren't words.
 */
export function countWords(md: string): number {
  // (Each pattern looks at one line, or at so many letters and no more: a text written to be slow to read, such as
  // thousands of empty lines, would otherwise hold the page of everyone who opens it. See the model's plainWords.)
  const text = md
    .replace(/\]\([^)\s]{0,2000}\)/g, ']')
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\]/gm, '')
    .replace(/^[ \t\r:|-]+$/gm, (line) => (line.includes('---') ? '' : line))
  if (typeof Intl.Segmenter !== 'function') return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  let n = 0
  for (const s of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) if (s.isWordLike) n++
  return n
}

/**
 * The pictures a paragraph is, when every line of it is the name of one of the card's pictures ("📎plan.png");
 * null when it is anything else. That is how a description has pictures in it: a picture named by itself on a line is
 * shown there (see Markdown, and the editor's Pictures), and named inside a sentence it stays a small link.
 */
export function picturesNamed(paragraph: string, pictures: ReadonlyMap<string, AttachmentView>): AttachmentView[] | null {
  const lines = paragraph
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const out = lines.map((l) => (l.startsWith(FILE_MARK) ? pictures.get(l.slice(FILE_MARK.length)) : undefined))
  return out.length && out.every((f) => !!f) ? (out as AttachmentView[]) : null
}
