/**
 * Rows of a spreadsheet, from what a person pasted (Excel and Google Sheets copy cells as tab-separated text) or from
 * a .csv file (commas, or semicolons where the comma is the decimal mark). Cells in quotes may hold the separator,
 * line breaks and doubled quotes.
 */
export interface Sheet {
  /** Every row as wide as the widest, in the order given: row 1 of the sheet is `rows[0]`. Trailing empty rows are dropped. */
  rows: string[][]
  delimiter: '\t' | ',' | ';'
}

/** Rows and columns one sheet can have (the first row may be the columns' names). */
export const SHEET_MAX_ROWS = 2001
export const SHEET_MAX_COLUMNS = 40
/** Cells one row may have as it is read, empty ones at its end included (those are dropped afterwards): far more than any sheet's. */
const ROW_MAX_CELLS = 2000

/** What separates the cells: a tab if the first line has one, else whichever of comma and semicolon it has more of. */
function delimiterOf(text: string): Sheet['delimiter'] {
  let tabs = 0
  let commas = 0
  let semis = 0
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (quoted) continue
    else if (ch === '\n' || ch === '\r') break
    else if (ch === '\t') tabs++
    else if (ch === ',') commas++
    else if (ch === ';') semis++
  }
  return tabs ? '\t' : semis > commas ? ';' : ','
}

/** Reads the text into rows. Throws, with words for the person, when there's nothing in it or far too much. */
export function parseSheet(input: string): Sheet {
  // (A file saved as "CSV UTF-8" starts with a byte-order mark; PostgreSQL text can't hold a NUL.)
  const text = input.replace(/^\uFEFF/, '').replaceAll('\u0000', '')
  const delimiter = delimiterOf(text)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  // (Whether the cell being read began with a quote: only then does a quote mean anything.)
  let wasQuoted = false
  // (Whether the cell so far is nothing but spaces. Kept as it is read: asking the cell itself at every quote would
  // read a long cell again for each of them, and a text made of one long cell and a million quotes never ends.)
  let blank = true
  const endCell = () => {
    if (row.length >= ROW_MAX_CELLS) throw new Error(`That’s too many columns: ${SHEET_MAX_COLUMNS} at most.`)
    row.push(wasQuoted ? cell : cell.trim())
    cell = ''
    wasQuoted = false
    blank = true
  }
  const endRow = () => {
    endCell()
    rows.push(row)
    row = []
    if (rows.length > SHEET_MAX_ROWS * 2) throw new Error(`That’s too many rows: ${(SHEET_MAX_ROWS - 1).toLocaleString('en')} at most.`)
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch !== '"') cell += ch
      else if (text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = false
    } else if (ch === '"' && blank && !wasQuoted) {
      quoted = true
      wasQuoted = true
      cell = ''
    } else if (ch === delimiter) endCell()
    else if (ch === '\n') endRow()
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      endRow()
    } else if (!wasQuoted || ch.trim()) {
      cell += ch
      if (blank && ch.trim()) blank = false
    }
  }
  if (cell || row.length || wasQuoted) endRow()
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop()
  if (!rows.length) throw new Error('There’s nothing to import: paste rows from a spreadsheet, or choose a .csv file.')
  if (rows.length > SHEET_MAX_ROWS) throw new Error(`That’s too many rows: ${(SHEET_MAX_ROWS - 1).toLocaleString('en')} at most.`)
  // (Columns that are empty all the way down at the end are dropped: sheets often have them.)
  // (Each row is read back from its end to its last cell with something in it: once over the cells, however wide.)
  let width = 1
  for (const r of rows) {
    let last = r.length
    while (last > width && !r[last - 1]) last--
    if (last > width) width = last
  }
  if (width > SHEET_MAX_COLUMNS) throw new Error(`That’s too many columns: ${SHEET_MAX_COLUMNS} at most.`)
  return { rows: rows.map((r) => Array.from({ length: width }, (_, i) => plainText(r[i] ?? ''))), delimiter }
}

/**
 * A cell as its text. A spreadsheet's way of saying "this is text, not a formula" is an apostrophe in front, and
 * the sheets Kanbanto saves use it for what someone typed that starts like a formula (see exportSheet.ts): read
 * back, the apostrophe is the mark, not part of the text.
 */
const plainText = (cell: string) => (/^'[=+\-@]/.test(cell) ? cell.slice(1) : cell)
