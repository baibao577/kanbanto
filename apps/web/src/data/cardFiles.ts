import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AttachmentView } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { coverPicture } from '@/lib/picture'
import type { TaskActivity } from './sync'

/**
 * Sends one file: its bytes as-is, name and type in headers. `forComment` uploads it for a comment being written
 * (a draft until the comment is posted; anyone who can comment may do this).
 */
export async function uploadFile(boardId: string, taskId: string, file: File, forComment = false) {
  const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/attachments`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name || 'pasted-image.png'),
      'x-file-type': file.type || 'application/octet-stream',
      ...(forComment ? { 'x-attach-to': 'comment' } : {}),
    },
    body: file,
  }).catch(() => null)
  const json = res ? await res.json().catch(() => null) : null
  if (!res?.ok) throw new Error(json?.error ?? (res ? `Upload failed (${res.status}).` : 'Can’t reach the server.'))
  return (json as { attachment: AttachmentView }).attachment
}

/** What the server said went wrong, or that it couldn't be reached. */
const refusal = async (res: Response | null, what: string) => {
  const json = res ? await res.json().catch(() => null) : null
  return new Error(json?.error ?? (res ? `${what} (${res.status}).` : 'Can’t reach the server.'))
}

/**
 * Gives a picture its small copy, which is what the Board draws when the picture is a card's cover: the original is
 * read through the server, shrunk here, and the small one sent back. Done once for a picture; answers with where the
 * small copy is.
 */
async function makeThumb(boardId: string, a: AttachmentView) {
  const at = `/api/boards/${encodeURIComponent(boardId)}/attachments/${a.id}`
  const original = await fetch(`${at}/original`, { credentials: 'same-origin' }).catch(() => null)
  if (!original?.ok) throw await refusal(original, 'Couldn’t read the picture')
  const small = await coverPicture(await original.blob())
  const res = await fetch(`${at}/thumb`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': small.type }, body: small }).catch(
    () => null,
  )
  if (!res?.ok) throw await refusal(res, 'Couldn’t save the cover')
  return ((await res.json()) as { thumb: string }).thumb
}

/** A card's files — its own and those in its comments — kept up to date live. */
export function useCardFiles(boardId: string, taskId: string, onActivity: (l: (m: TaskActivity) => void) => () => void) {
  const [files, setFiles] = useState<AttachmentView[]>([])
  const [uploading, setUploading] = useState<string[]>([])
  /** The picture being made the cover (its small copy can take a moment), or 'none' while the cover is being removed. */
  const [covering, setCovering] = useState<string | null>(null)

  const upsert = useCallback((a: AttachmentView) => setFiles((xs) => (xs.some((x) => x.id === a.id) ? xs : [...xs, a])), [])

  useEffect(() => {
    api<{ attachments: AttachmentView[] }>('GET', `/boards/${boardId}/tasks/${taskId}/attachments`).then(
      (r) => setFiles(r.attachments),
      () => {},
    )
    return onActivity((m) => {
      if (m.taskId !== taskId || m.type === 'time') return
      if (m.type === 'attachment') {
        if (m.action === 'deleted') setFiles((xs) => xs.filter((x) => x.id !== m.attachmentId))
        else if (m.attachment) upsert(m.attachment)
      } else if (m.action === 'deleted') setFiles((xs) => xs.filter((x) => x.commentId !== m.commentId))
      else m.comment?.attachments.forEach(upsert)
    })
  }, [boardId, taskId, onActivity, upsert])

  /** Attaches files to the card itself (editors and owners). Returns the ones that were attached. */
  const add = async (list: FileList | File[]) => {
    const added: AttachmentView[] = []
    for (const f of [...list]) {
      setUploading((u) => [...u, f.name])
      try {
        const a = await uploadFile(boardId, taskId, f)
        upsert(a)
        added.push(a)
      } catch (e) {
        toast.error(`Couldn’t attach “${f.name}”`, { description: errorMessage(e), duration: 8000 })
      } finally {
        setUploading((u) => {
          const i = u.indexOf(f.name)
          return i === -1 ? u : [...u.slice(0, i), ...u.slice(i + 1)]
        })
      }
    }
    return added
  }

  /**
   * Makes a picture the card's cover, or (null) takes the cover away. The card itself changes on the board, for
   * everyone, as any change does: nothing is kept here but which picture is being seen to.
   */
  const setCover = async (a: AttachmentView | null) => {
    setCovering(a?.id ?? 'none')
    try {
      if (a && !a.thumb) {
        const thumb = await makeThumb(boardId, a)
        setFiles((xs) => xs.map((x) => (x.id === a.id ? { ...x, thumb } : x)))
      }
      const cover = `/boards/${boardId}/tasks/${taskId}/cover`
      if (a) await api('PUT', cover, { attachmentId: a.id })
      else await api('DELETE', cover)
    } catch (e) {
      toast.error(a ? `Couldn’t make “${a.name}” the cover` : 'Couldn’t remove the cover', { description: errorMessage(e), duration: 8000 })
    } finally {
      setCovering(null)
    }
  }

  const remove = async (a: AttachmentView) => {
    try {
      const gone = await api<{ wasCover?: boolean }>('DELETE', `/boards/${boardId}/attachments/${a.id}`)
      setFiles((xs) => xs.filter((x) => x.id !== a.id))
      toast(`Removed “${a.name}”`, {
        action: {
          label: 'Undo',
          onClick: () =>
            api<{ attachment: AttachmentView }>('POST', `/boards/${boardId}/attachments/${a.id}/restore`).then(
              (r) => {
                upsert(r.attachment)
                // (It was the card's cover, which went with it: back with it too.)
                if (gone.wasCover) void setCover(r.attachment)
              },
              (e) => toast.error(errorMessage(e)),
            ),
        },
      })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return { files, uploading, covering, add, remove, setCover, upsert }
}

export type CardFiles = ReturnType<typeof useCardFiles>
