import * as chrono from 'chrono-node'

/** A time from plain words ("tmr 10:00", "wed1pm", "next monday 1pm", "in 2 hours"), and the words it came from. */
export interface When {
  date: Date
  /** The words that were read as the time (to highlight, or take out of a title). */
  text: string
  index: number
  /** A time of day was given (else it's 9:00 on that day). */
  timed: boolean
}

/** With no time of day, "friday" means 9:00 that day. */
const DEFAULT_HOUR = 9

/**
 * Reads a time from plain words, in the future. Shortcuts people type work too: "tmr"/"tmrw"/"tml" for tomorrow,
 * and no space between a word and a time ("tmr10:00", "wed1pm"). English only.
 */
export function parseWhen(text: string, ref = new Date()): When | null {
  const { spaced, from } = tidy(text)
  const [r] = chrono.parse(spaced, ref, { forwardDate: true })
  if (!r) return null
  const timed = r.start.isCertain('hour')
  const date = r.start.date()
  if (!timed) date.setHours(DEFAULT_HOUR, 0, 0, 0)
  // Back to the words as typed.
  const index = from[r.index]
  const end = from[r.index + r.text.length - 1] + 1
  return { date, text: text.slice(index, end), index, timed }
}

/**
 * The text as chrono reads it best: "tmr" → "tomorrow", and a space between a word and a number ("wed1pm" → "wed
 * 1pm"). `from[i]` is where character i came from in the original, to find the words again.
 */
function tidy(text: string) {
  let spaced = ''
  const from: number[] = []
  const tomorrow = /(?:tmrw?|tml)\b/iy
  for (let i = 0; i < text.length;) {
    tomorrow.lastIndex = i
    const m = !/[a-z]/i.test(text[i - 1] ?? '') && tomorrow.exec(text)
    if (m) {
      for (let k = 0; k < 8; k++) from.push(k < 7 ? i : i + m[0].length - 1)
      spaced += 'tomorrow'
      i += m[0].length
      continue
    }
    spaced += text[i]
    from.push(i)
    if (/[a-z]/i.test(text[i]) && /\d/.test(text[i + 1] ?? '')) {
      spaced += ' '
      from.push(i)
    }
    i++
  }
  return { spaced, from }
}
