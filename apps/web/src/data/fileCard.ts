import type { MovePlan } from '@kanbanto/model/moveBoard'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { navigate } from '@/app/router'
import type { DropPlace } from '@/components/board/dnd'

type Summary = MovePlan['summary']
export interface Filed {
  id: string
  summary: Summary
  board: { id: string; name: string }
}

/** Moves a card (with its subtasks, comments and files) to another board, at a place there when one is given. */
export const fileCard = (fromBoardId: string, taskId: string, toBoardId: string, place: DropPlace = {}) =>
  api<Filed>('POST', `/boards/${encodeURIComponent(fromBoardId)}/tasks/${encodeURIComponent(taskId)}/move`, {
    boardId: toBoardId,
    ...(place.list && { list: place.list }),
    ...(place.parentId && { parentId: place.parentId }),
    ...(place.list && place.order && { order: place.order }),
  })

const quoted = (names: string[]) => names.map((n) => `“${n}”`)
const joinWords = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)))

/**
 * What a move changed besides the card's place, in a sentence or two (undefined: nothing): what couldn't come along,
 * and the labels the other board got. For a move made without asking first, by dragging.
 */
export function lostInMove(s: Summary): string | undefined {
  const left = [
    s.droppedFields.length > 0 && `${plural(s.droppedFields.length, 'the field', 'the fields')} ${joinWords(quoted(s.droppedFields))}`,
    s.droppedLinks > 0 && plural(s.droppedLinks, 'a “waiting on” link', '# “waiting on” links'),
    !!s.linksRemoved && plural(s.linksRemoved, 'a link to it from another card', 'links to it from # other cards'),
    s.unassigned.length > 0 && `${joinWords(s.unassigned)} as assignee`,
    s.leftBehind.length > 0 && `${joinWords(s.leftBehind)} in its people fields`,
  ].filter((x): x is string => !!x)
  const out = [
    left.length > 0 && `Left behind: ${joinWords(left)}.`,
    s.newLabels.length > 0 && `Added ${plural(s.newLabels.length, 'the label', 'the labels')} ${joinWords(quoted(s.newLabels))} there.`,
  ].filter((x): x is string => !!x)
  return out.length ? out.join(' ') : undefined
}

/** Says a card was moved, what was left behind, and offers to open it where it went. */
export function saidMoved(r: Filed) {
  toast(`Moved to “${r.board.name}”`, {
    description: lostInMove(r.summary),
    action: { label: 'Open', onClick: () => navigate({ page: 'board', id: r.board.id, task: r.id }) },
  })
}
