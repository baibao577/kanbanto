import { api, ApiError } from '@/api/client'
import type { ConfirmRequest } from '@/components/common/ConfirmDialog'

const list = (names: string[]) => names.map((n) => `“${n}”`).join(', ')

/**
 * Moves a board to a workspace, or (null) to your Personal boards. Its fields belong to the place it leaves: if
 * moving them would add fields to the other place's library, or leave some behind with their values, the server
 * says so first and `ask` puts it to the person. Resolves once it has moved (never, if they say no).
 */
export async function moveBoardTo(boardId: string, to: { id: string; name: string } | null, ask: (request: ConfirmRequest) => void) {
  const put = (confirm?: boolean) =>
    api<{ visibility: string }>('PUT', `/boards/${encodeURIComponent(boardId)}/workspace`, {
      workspaceId: to?.id ?? null,
      ...(confirm && { confirm }),
    })
  try {
    return await put()
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'fields') throw e
    const { add = [], lose = [], links = 0 } = (e.details ?? {}) as { add?: string[]; lose?: string[]; links?: number }
    const where = to ? `${to.name}’s fields` : 'your own fields'
    const added = add.length ? `${add.length === 1 ? 'This will be added' : 'These will be added'} to ${where}: ${list(add)}. ` : ''
    const lost = lose.length
      ? `${list(lose)} ${lose.length === 1 ? 'isn’t' : 'aren’t'} among ${where}${to ? ', and only its admins can add to them' : ''}: ${lose.length === 1 ? 'its values' : 'their values'} on this board will be lost. `
      : ''
    // Links between cards never leave a space: the ones between this board's cards and the boards it leaves go.
    const unlinked = links ? `${links === 1 ? '1 link' : `${links} links`} between its cards and cards on the boards it leaves will be removed. ` : ''
    return new Promise<{ visibility: string }>((resolve, reject) =>
      ask({
        title: add.length || lose.length ? 'Move the board with its fields?' : 'Move the board?',
        description: `${added}${lost}${unlinked}`.trim(),
        confirmLabel: lose.length || links ? 'Move anyway' : 'Move',
        destructive: lose.length > 0 || links > 0,
        onConfirm: () => void put(true).then(resolve, reject),
      }),
    )
  }
}
