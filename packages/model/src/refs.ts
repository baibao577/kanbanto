import type { Change } from './records'
import type { Board, BoardData, Task } from './types'

// What a card is called: its board's letters and its own number, like WEB-12. The letters are the board's to choose
// (suggested from its name); the number is given by the server, counting up, and stays with the card for as long as
// it's on that board.

/** A board's letters: 2 to 5 capitals or digits, starting with a letter (WEB, KAN, B1). */
export const CODE = /^[A-Z][A-Z0-9]{1,4}$/
export const isCode = (s: string) => CODE.test(s)
/** The Inbox's letters, on every account. */
export const INBOX_CODE = 'IN'
/** The letters a board had before, kept so a number written with them still finds its card. */
export const PAST_CODES = 5
/** The highest number a card can have (it's a whole number in the database, and a file could bring any). */
export const MAX_NUMBER = 999_999_999

/** "WEB-12". Nothing while the board has no letters yet, or the card no number (one just made, until the server answers). */
export const refOf = (board: Pick<Board, 'code'>, task: Pick<Task, 'number'>): string | undefined =>
  board.code && task.number ? `${board.code}-${task.number}` : undefined

/** Is this one of the board's sets of letters, now or before? (In any case.) */
export const isCodeOf = (board: Pick<Board, 'code' | 'pastCodes'>, code: string) => {
  const c = code.toUpperCase()
  return board.code === c || !!board.pastCodes?.includes(c)
}

/** A card's name as someone typed it: "WEB-12", "web-12", "#12" or "12". Null when it isn't one. */
export function readRef(text: string): { code?: string; number: number } | null {
  const m = text.trim().match(/^(?:([A-Za-z][A-Za-z0-9]{1,4})-|#)?(\d{1,9})$/)
  if (!m) return null
  const number = Number(m[2])
  return number > 0 ? { ...(m[1] && { code: m[1].toUpperCase() }), number } : null
}

/** The card a name means on this board (also an archived one), or nothing: other letters, or no such number. */
export function taskByRef(data: Pick<BoardData, 'board' | 'tasks' | 'archived'>, text: string): Task | undefined {
  const ref = readRef(text)
  if (!ref || (ref.code && !isCodeOf(data.board, ref.code))) return undefined
  for (const id in data.tasks) if (data.tasks[id].number === ref.number) return data.tasks[id]
  if (data.archived) for (const id in data.archived) if (data.archived[id].number === ref.number) return data.archived[id]
  return undefined
}

/**
 * Letters for a board, from its name, that no board in `taken` has: the start of its first word (Website launch →
 * WEB, Stel → STEL), then its initials, then other spellings, then a digit after them. A name with no Latin letters
 * gets B1, B2…: its owner picks better ones.
 */
export function suggestCode(name: string, taken: Iterable<string> = []): string {
  // (The Inbox's letters are the Inbox's.)
  const used = new Set([INBOX_CODE, ...[...taken].map((c) => c.toUpperCase())])
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    // (Letters first: "2026 plan" is PLA, not 202.)
    .map((w) => w.replace(/^[0-9]+/, ''))
    .filter(Boolean)
  const tries: string[] = []
  const [first, second] = words
  if (first) {
    tries.push(first.length <= 4 ? first : first.slice(0, 3))
    if (words.length > 1)
      tries.push(
        words
          .slice(0, 4)
          .map((w) => w[0])
          .join(''),
      )
    if (second) tries.push(first.slice(0, 2) + second[0])
    tries.push(first.slice(0, 4), first.slice(0, 5))
  }
  for (const t of tries) if (isCode(t) && !used.has(t)) return t
  // (One letter is all there is, "X": XX. None at all: B.)
  const base = first ? (first.length > 1 ? first.slice(0, 3) : first + first) : 'B'
  for (let n = first ? 2 : 1; n < 10_000; n++) {
    const code = `${base.slice(0, 5 - String(n).length)}${n}`
    if (isCode(code) && !used.has(code)) return code
  }
  return base
}

/** The letters a board gets when they change: the old ones are remembered (the latest first, a few). */
export function withCode(board: Board, code: string): Board {
  if (board.code === code) return board
  const past = [...(board.code ? [board.code] : []), ...(board.pastCodes ?? [])].filter((c, i, all) => c !== code && all.indexOf(c) === i)
  const { pastCodes: _was, ...rest } = board
  return { ...rest, code, ...(past.length && { pastCodes: past.slice(0, PAST_CODES) }) }
}

const usable = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_NUMBER

/**
 * Gives the cards in `changes` their numbers, the way only the server may (it holds the board's counter: `next`, the
 * number the next new card gets). A command never chooses a number, and what a browser sends for one doesn't count:
 *
 * - a card that has a number keeps it, whatever the change says (an undo made from a copy that never knew it, an
 *   older browser tab that drops what it doesn't know);
 * - a card that comes back with the number it had (an undo of a delete, a redo) keeps it while nobody else has it;
 * - any other new card, or an old one that never had a number, takes the next.
 *
 * No number is given twice in one go (a list of changes that asks for the same free number for two cards), and a card
 * that appears twice in the list gets one number. Nothing else about a record is touched (its version least of all:
 * undo goes by it). `data`: the board before the changes. Changes that need nothing are handed back as they are.
 */
export function withNumbers(data: Pick<BoardData, 'tasks' | 'archived'>, changes: Change[], next: number): { changes: Change[]; next: number } {
  let held: Set<number> | null = null
  const taken = (n: number) => {
    if (!held) {
      held = new Set()
      for (const id in data.tasks) if (data.tasks[id].number) held.add(data.tasks[id].number!)
      if (data.archived) for (const id in data.archived) if (data.archived[id].number) held.add(data.archived[id].number!)
    }
    return held.has(n)
  }
  let out: Change[] | null = null
  const given = new Set<number>()
  const theirs = new Map<string, number>()
  changes.forEach((c, i) => {
    if (c.entity !== 'task' || !c.after) return
    const was = (data.tasks[c.id] ?? data.archived?.[c.id])?.number
    let number = c.after.number
    if (usable(was)) number = was
    else if (theirs.has(c.id)) number = theirs.get(c.id)!
    else if (!usable(number) || number >= next || given.has(number) || taken(number)) number = next++
    given.add(number)
    theirs.set(c.id, number)
    if (number !== c.after.number) (out ??= [...changes])[i] = { ...c, after: { ...c.after, number } }
  })
  return { changes: out ?? changes, next }
}

/**
 * Numbers for a whole board made at once (a starter, an imported file, a board that is older than card numbers):
 * cards that bring a number of their own keep it, when it's theirs alone; the rest are counted on from there, in the
 * order they were made, and where many were made in the same moment (a starter, an import) in `order` (the order
 * the outline shows them). Returns each card's number by id, and the number the next card gets.
 */
export function numbersFor(tasks: Iterable<Task>, order: readonly string[] = [], from = 1): { numbers: Map<string, number>; next: number } {
  const numbers = new Map<string, number>()
  const seen = new Set<number>()
  const rest: Task[] = []
  let next = from
  for (const t of tasks) {
    if (usable(t.number) && !seen.has(t.number)) {
      seen.add(t.number)
      numbers.set(t.id, t.number)
      if (t.number >= next) next = t.number + 1
    } else rest.push(t)
  }
  const place = new Map(order.map((id, i) => [id, i]))
  rest.sort(
    (a, b) =>
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (place.get(a.id) ?? order.length) - (place.get(b.id) ?? order.length) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  for (const t of rest) numbers.set(t.id, next++)
  return { numbers, next }
}
