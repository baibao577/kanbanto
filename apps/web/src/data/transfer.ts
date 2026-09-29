import { exportFile } from '@kanbanto/model/transfer'
import type { BoardData } from '@kanbanto/model/types'

/** A name that's safe in a file name, in any language: letters (with their accents and marks) and digits kept, the rest become dashes. */
export const fileSafe = (name: string) =>
  name
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)

/** Downloads the board as a JSON file. */
export function exportBoard(data: BoardData) {
  const blob = new Blob([JSON.stringify(exportFile(data), null, 1)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${fileSafe(data.board.name) || 'board'}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
