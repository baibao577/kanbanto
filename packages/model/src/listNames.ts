import type { Category } from './types'

/**
 * What a list counts as, guessed from what it's called, for lists that arrive from another app (a Trello board).
 * English and Thai. Checked in this order, so "Not started" isn't read as "started" and "To do" isn't read as "do".
 * Whoever imports sees the guess and can change it: this only saves them most of the choosing.
 */
const HINTS: [Category, RegExp][] = [
  ['todo', /\b(not started|to[- ]?do|to[- ]?dos)\b|ต้องทำ|รอทำ|จะทำ|ยังไม่เริ่ม/],
  [
    'done',
    /\b(done|completed?|finished|closed|shipped|released|delivered|resolved|live|won|lost|cancell?ed|rejected|dropped|failed|won'?t do)\b|เสร็จ|เรียบร้อย|สำเร็จ|ปิดงาน|ปิดแล้ว|ยกเลิก|ไม่เอา|ไม่ผ่าน/,
  ],
  [
    'doing',
    /\b(doing|in progress|wip|working|ongoing|started|in review|review|reviewing|testing|qa|in development)\b|กำลัง|ดำเนินการ|ทำอยู่|รอตรวจ|ทดสอบ/,
  ],
  ['backlog', /\b(backlog|ideas?|icebox|someday|later|maybe|wish ?list|parking lot)\b|ไอเดีย|ไว้ก่อน|ทีหลัง|รอก่อน|สักวัน/],
  ['todo', /\b(next|up next|ready|planned|queue|queued|this week|today|inbox|new)\b|งานใหม่|สัปดาห์นี้|วันนี้/],
]

/** The kind of list a name suggests, or null when it says nothing ("Screening", "Marketing"). */
export function guessCategory(name: string): Category | null {
  const n = name.normalize('NFC').toLowerCase().replace(/[’`]/g, "'")
  for (const [category, words] of HINTS) if (words.test(n)) return category
  return null
}
