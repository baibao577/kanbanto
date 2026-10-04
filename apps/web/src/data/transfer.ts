import type { BoardSnapshot } from '@kanbanto/model/api'
import { exportFile } from '@kanbanto/model/transfer'
import type { BoardData } from '@kanbanto/model/types'
import { api } from '@/api/client'

/** A name that's safe in a file name, in any language: letters (with their accents and marks) and digits kept, the rest become dashes. */
export const fileSafe = (name: string) =>
  name
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)

/**
 * Downloads the board as a JSON file: as you see it, with all its archived cards (which aren't kept here: they're
 * fetched for this).
 */
export async function exportBoard(data: BoardData) {
  const whole = await api<BoardSnapshot>('GET', `/boards/${encodeURIComponent(data.board.id)}?archived=all`)
  const archived = Object.fromEntries(Object.entries({ ...whole.data.archived, ...data.archived }).filter(([id]) => !data.tasks[id]))
  const blob = new Blob([JSON.stringify(exportFile({ ...data, archived }), null, 1)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${fileSafe(data.board.name) || 'board'}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
