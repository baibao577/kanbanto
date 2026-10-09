import { z } from 'zod'

// A comment about some words of a card's description.
//
// The description is Markdown that anyone and anything may rewrite: a person, several at once, an assistant, the
// API. So nothing is written into it to say "a comment is here". The comment keeps the words it is about, with a
// little of what stood before and after them, and each time the text is shown the words are looked for again.
// Found, they are marked and the comment sits beside them, wherever they have moved to. Not found (they were
// rewritten), the comment stays in the card's comments and says so. Nobody needs to be able to edit the card to
// comment on it this way, and no comment is lost to an edit.
//
// Words are compared without their spaces, and without the mark a file's name is written with: a description
// isn't laid out the same when it is read, when it is written, and as the Markdown it is saved as, but in all
// three it holds the same letters in the same order (the editor's cursor is placed by the same rule: see the
// web's text/caret.ts).

/** The words a comment is about, as the person selected them, and up to this much of the text on each side. */
export interface Passage {
  quote: string
  before: string
  after: string
}

/** How long the words a comment is about may be, and how much of the text around them is kept. */
export const QUOTE_MAX = 1000
export const AROUND_MAX = 80

const around = z
  .string()
  .max(AROUND_MAX * 2)
  .refine((s) => !s.includes('\u0000'))
  .default('')
export const PassageSchema = z.object({
  quote: z
    .string()
    .max(QUOTE_MAX * 2)
    .refine((s) => !s.includes('\u0000') && squeeze(s).length > 0, 'Select some words first.'),
  before: around,
  after: around,
})

const FILE_MARK = '📎'

/** A text's letters alone: no spaces, no line breaks, no file marks. What two layouts of the same text share. */
export function squeeze(text: string): string {
  return text.replaceAll(FILE_MARK, '').replace(/\s+/gu, '')
}

/** A passage as it is kept: spaces tidied, and no longer than is kept. */
export function tidyPassage(p: { quote: string; before?: string; after?: string }): Passage {
  const tidy = (s: string) => s.replace(/\s+/gu, ' ').trim()
  const quote = tidy(p.quote)
  const before = tidy(p.before ?? '')
  const after = tidy(p.after ?? '')
  return {
    quote: quote.length > QUOTE_MAX ? quote.slice(0, QUOTE_MAX) : quote,
    // (The nearest words count most: the end of what came before, the start of what comes after.)
    before: before.slice(-AROUND_MAX),
    after: after.slice(0, AROUND_MAX),
  }
}

const sharedEnd = (a: string, b: string) => {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}
const sharedStart = (a: string, b: string) => {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/**
 * Where a passage's words are in a text now: from which letter to which, counting letters only (see `squeeze`: give
 * the text squeezed, or not, it is squeezed here). Where the words are there more than once, the place whose
 * surroundings are most like the ones kept with the passage. Null: the words aren't in the text any more.
 */
export function locate(text: string, p: Passage): { start: number; end: number } | null {
  const words = squeeze(text)
  const quote = squeeze(p.quote)
  if (!quote) return null
  const before = squeeze(p.before)
  const after = squeeze(p.after)
  let best = -1
  let fit = -1
  for (let at = words.indexOf(quote); at >= 0; at = words.indexOf(quote, at + 1)) {
    const end = at + quote.length
    const score = sharedEnd(words.slice(Math.max(0, at - before.length), at), before) + sharedStart(words.slice(end, end + after.length), after)
    if (score > fit) {
      best = at
      fit = score
    }
  }
  return best < 0 ? null : { start: best, end: best + quote.length }
}

/** A passage's words for a line of text: whole when short, else their beginning and their end. */
export function quoteLine(quote: string, max = 80): string {
  const q = quote.replace(/\s+/gu, ' ').trim()
  if (q.length <= max) return q
  const head = Math.ceil((max - 3) * 0.65)
  return `${q.slice(0, head).trimEnd()} … ${q.slice(q.length - (max - 3 - head)).trimStart()}`
}

/**
 * Links and pictures as their words, not their addresses: `[words](address)` and `![words](address)`. Read in one
 * pass over the text, so a text made to be slow to read (a long run of "[") costs no more than any other of its
 * length: the same answer as `/!?\[([^\]]*)\]\([^)]*\)/g` gives, without going over the same letters again.
 */
function linkWords(md: string): string {
  let out = ''
  let from = 0
  // The next "]" and the next ")", each from where it was last looked for (-1: there is none any more).
  let close = -2
  let end = -2
  for (let open = md.indexOf('['); open >= 0; open = md.indexOf('[', open + 1)) {
    if (open < from) continue
    if (close !== -1 && close < open) close = md.indexOf(']', open)
    if (close === -1) break
    if (md[close + 1] !== '(') continue
    if (end !== -1 && end < close + 2) end = md.indexOf(')', close + 2)
    if (end === -1) break
    const mark = open > from && md[open - 1] === '!' ? open - 1 : open
    out += md.slice(from, mark) + md.slice(open + 1, close)
    from = end + 1
  }
  return out + md.slice(from)
}

/**
 * Markdown as plain words, near enough to how it reads: what marks it up is taken out. For looking a passage up
 * where the text isn't on the screen (the card's comments, an assistant): `locate` in this.
 *
 * A description is written by anyone who can edit a board, and this runs on the server for assistants: every step
 * reads the text once, whatever is in it. So a pattern that starts at a line's start looks at that line only (a
 * space or a tab, never "any white space", which takes the lines after it too), and none has two parts that could
 * both take the same letters.
 */
export function plainWords(markdown: string): string {
  return (
    linkWords(markdown)
      // A table's rule line (and a line drawn across): nothing but bars, colons, dashes and spaces, with a dash.
      .replace(/^[ \t\r:|-]+$/gm, (line) => (line.includes('-') ? '' : line))
      // A heading's marks, a quote's, a list's, a checklist's box.
      .replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gm, '')
      .replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm, '')
      // A callout's mark (a quote's first line: "[!NOTE]"), and a line break written as a tag.
      .replace(/^\\?\[!(?:note|tip|important|warning|caution)\\?\][ \t]*$/gim, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(?:\[[ xX]\][ \t]+)?|$)/gm, '')
      .replace(/^[ \t]*(?:`{3,}|~{3,}).*$/gm, '')
      // Emphasis, code, a table's bars, escapes.
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(?<![\p{L}\p{N}])[*_]|[*_](?![\p{L}\p{N}])/gu, '')
      .replace(/\|/g, ' ')
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  )
}

/**
 * Whether a passage's words are still in a description, told from its Markdown alone. Sure when it says yes; when
 * the layout is unusual it may say yes for words that are found only by their letters (it leans that way: a
 * comment wrongly called out of date would be worse than one wrongly called current).
 */
export function stillThere(markdown: string, p: Passage): boolean {
  if (locate(plainWords(markdown), p)) return true
  // (Whatever marks the Markdown up, between two letters of the words: looked for with those taken out as well.)
  const bare = (s: string) => squeeze(s).replace(/[*_~`|\\>#[\]()-]/g, '')
  const quote = bare(p.quote)
  return !!quote && bare(markdown).includes(quote)
}
