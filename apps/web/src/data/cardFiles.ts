import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AttachmentView } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
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

/** A card's files — its own and those in its comments — kept up to date live. */
export function useCardFiles(boardId: string, taskId: string, onActivity: (l: (m: TaskActivity) => void) => () => void) {
  const [files, setFiles] = useState<AttachmentView[]>([])
  const [uploading, setUploading] = useState<string[]>([])

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

  const remove = async (a: AttachmentView) => {
    try {
      await api('DELETE', `/boards/${boardId}/attachments/${a.id}`)
      setFiles((xs) => xs.filter((x) => x.id !== a.id))
      toast(`Removed “${a.name}”`, {
        action: {
          label: 'Undo',
          onClick: () =>
            api<{ attachment: AttachmentView }>('POST', `/boards/${boardId}/attachments/${a.id}/restore`).then(
              (r) => upsert(r.attachment),
              (e) => toast.error(errorMessage(e)),
            ),
        },
      })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return { files, uploading, add, remove, upsert }
}

export type CardFiles = ReturnType<typeof useCardFiles>
