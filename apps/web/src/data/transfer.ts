import type { BoardSnapshot } from '@kanbanto/model/api'
import { cardsCsv } from '@kanbanto/model/exportSheet'
import type { TitleOf } from '@kanbanto/model/fields'
import { exportFile, type BoardExtras } from '@kanbanto/model/transfer'
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

/** Hands the browser a file to save: the board's name and today's date, with this ending. */
function save(data: BoardData, text: string, type: string, ending: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = `${fileSafe(data.board.name) || 'board'}-${new Date().toISOString().slice(0, 10)}.${ending}`
  a.click()
  URL.revokeObjectURL(a.href)
}

/** The board with all its archived cards (which aren't kept here: they're fetched for this), and the time logged on each card. */
async function whole(data: BoardData) {
  const all = await api<BoardSnapshot>('GET', `/boards/${encodeURIComponent(data.board.id)}?archived=all`)
  const archived = Object.fromEntries(Object.entries({ ...all.data.archived, ...data.archived }).filter(([id]) => !data.tasks[id]))
  return { data: { ...data, archived }, minutes: all.counts.time }
}

/**
 * Downloads the board as a JSON file: as you see it, with all its archived cards. `extras`: with what was said and
 * logged on its cards too (its comments and logged time, which the board itself doesn't hold: they're asked for).
 */
export async function exportBoard(data: BoardData, opts: { extras?: boolean } = {}) {
  const board = await whole(data)
  const extras = opts.extras ? await api<BoardExtras>('GET', `/boards/${encodeURIComponent(data.board.id)}/extras`) : undefined
  save(data, JSON.stringify(exportFile(board.data, extras), null, 1), 'application/json', 'json')
}

/**
 * Downloads the board's cards as a spreadsheet (.csv): one row for each (see model exportSheet.ts). `ids`: only
 * these cards, in this order (the ones a search and a filter found); left out, every card on the board in the
 * outline's order. `archived`: with the cards in the archive after them, the latest put away first.
 */
export async function exportSheet(
  data: BoardData,
  opts: { ids?: readonly string[]; order: readonly string[]; archived?: boolean; titleOf?: TitleOf },
) {
  const board = await whole(data)
  const put = (id: string) => board.data.archived[id]?.archivedAt ?? ''
  const away = opts.archived ? Object.keys(board.data.archived).sort((a, b) => put(b).localeCompare(put(a))) : []
  const csv = cardsCsv(board.data, [...(opts.ids ?? opts.order), ...away], {
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    minutes: board.minutes,
    titleOf: opts.titleOf,
  })
  save(data, csv, 'text/csv;charset=utf-8', 'csv')
}
