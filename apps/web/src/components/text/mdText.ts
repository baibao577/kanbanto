import { Lexer, type Token } from 'marked'

/**
 * Descriptions and comments are stored as Markdown (what assistants and the API read and write). These are the small
 * text helpers the editor and the display share.
 */

/**
 * What the editor saves, tidied: no escapes a person didn't type (underscores inside words, like "📎plan_v2.pdf",
 * never start emphasis; a lone "&" needs no entity), and no blank lines around it.
 */
export function tidyMarkdown(md: string): string {
  return md
    .replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, '_')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;(?![a-zA-Z0-9#]+;)/g, '&')
    .trim()
}

/**
 * Text for the editor: "<" outside code written as "&lt;", so something that looks like HTML ("<script>" in a note
 * about it) stays text instead of being read as HTML and dropped. (tidyMarkdown turns it back.)
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
        .map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;')))
        .join('')
    })
    .join('\n')
}

const FENCE = /^\s{0,3}(```|~~~)/
const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/

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

/** The top-level headings, for a table of contents (numbered like Markdown's `headingIds`: h-0, h-1…). */
export function headingsOf(text: string): { id: string; depth: number; text: string }[] {
  return lex(text)
    .filter((t: Token): t is Token & { type: 'heading'; depth: number; text: string } => t.type === 'heading')
    .map((t, i) => ({ id: `h-${i}`, depth: t.depth, text: plain(t.text) }))
}
