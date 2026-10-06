/**
 * The text of a spreadsheet file someone chose. A .csv is usually UTF-8, but Excel also saves them in the computer's
 * older encoding (Thai or Western Windows), and "Unicode text" as UTF-16: those are told apart here, and when it
 * can't be known the person is asked (`sure` is false, and `decodeSheet` can be run again with another encoding).
 */
export const SHEET_ENCODINGS = [
  ['utf-8', 'UTF-8'],
  ['windows-874', 'Thai (Windows-874)'],
  ['windows-1252', 'Western (Windows-1252)'],
] as const
export type SheetEncoding = (typeof SHEET_ENCODINGS)[number][0]

export function decodeSheet(bytes: Uint8Array, as?: SheetEncoding): { text: string; encoding: SheetEncoding | 'utf-16'; sure: boolean } {
  // (An Excel workbook is a zip: it starts with "PK". So does a Numbers or an OpenDocument file.)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b)
    throw new Error('That’s a spreadsheet file, not a .csv. Save it as CSV first, or copy the rows in the spreadsheet and paste them here.')
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    return { text: new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes), encoding: 'utf-16', sure: true }
  if (!as || as === 'utf-8') {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', sure: true }
    } catch {
      // Not UTF-8: one of the older encodings, guessed from the language the browser is in.
    }
  }
  const encoding: SheetEncoding = as && as !== 'utf-8' ? as : navigator.language.toLowerCase().startsWith('th') ? 'windows-874' : 'windows-1252'
  return { text: new TextDecoder(encoding).decode(bytes), encoding, sure: false }
}
