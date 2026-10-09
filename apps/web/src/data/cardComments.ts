import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AttachmentView, CommentView } from '@kanbanto/model/api'
import type { Passage } from '@kanbanto/model/passages'
import { api } from '@/api/client'
import type { TaskActivity } from './sync'

/**
 * A comment about some words of the card's description (see the model's passages.ts), with the answers to it,
 * oldest first.
 */
export interface Thread {
  root: CommentView & { passage: Passage }
  answers: CommentView[]
}

/**
 * A card's comments, kept up to date live, and what can be done with them. Shared by the two places that show them:
 * the card's Comments, and the full page of its description, where the ones about a passage sit beside the text.
 */
export interface CardComments {
  items: CommentView[]
  /** The comments about a passage, each with its answers, in the order they were made. */
  threads: Thread[]
  /** `about`: some words of the description (it starts a thread), or the comment about a passage it answers. */
  post: (body: string, mentions: string[], attachments: string[], about?: { passage?: Passage; parentId?: string }) => Promise<CommentView>
  save: (c: CommentView, body: string, mentions: string[], attachments: string[]) => Promise<void>
  /** Deletes it (the answers to a comment about a passage go with it). Throws when it can't be. */
  remove: (c: CommentView) => Promise<void>
  /** Answers it with an emoji, or takes this person's back: shown at once, then as the server has it. */
  react: (c: CommentView, emoji: string, on: boolean, me: { id: string; name: string }) => Promise<void>
  /** Resolves a comment about a passage, or opens it again. */
  resolve: (c: CommentView, resolved: boolean) => Promise<void>
}

export function useCardComments(
  boardId: string,
  taskId: string,
  onActivity: (l: (m: TaskActivity) => void) => () => void,
  /** Told the files a comment brought (the card's files show them too). */
  onFiles?: (a: AttachmentView) => void,
): CardComments {
  const [items, setItems] = useState<CommentView[]>([])
  const put = useCallback(
    (c: CommentView) => setItems((xs) => (xs.some((x) => x.id === c.id) ? xs.map((x) => (x.id === c.id ? c : x)) : [...xs, c])),
    [],
  )

  useEffect(() => {
    api<{ comments: CommentView[] }>('GET', `/boards/${boardId}/tasks/${taskId}/comments`).then(
      (r) => setItems(r.comments),
      () => {},
    )
    // Others' comments arrive live.
    return onActivity((m) => {
      if (m.type !== 'comment' || m.taskId !== taskId) return
      if (m.action === 'deleted') setItems((xs) => xs.filter((x) => x.id !== m.commentId && x.parentId !== m.commentId))
      else if (m.comment) put(m.comment)
    })
  }, [boardId, taskId, onActivity, put])

  const threads = useMemo(
    () => items.flatMap((c) => (c.passage && !c.parentId ? [{ root: c as Thread['root'], answers: items.filter((a) => a.parentId === c.id) }] : [])),
    [items],
  )

  const post = useCallback<CardComments['post']>(
    async (body, mentions, attachments, about) => {
      const r = await api<{ comment: CommentView }>('POST', `/boards/${boardId}/tasks/${taskId}/comments`, { body, mentions, attachments, ...about })
      put(r.comment)
      r.comment.attachments.forEach((a) => onFiles?.(a))
      return r.comment
    },
    [boardId, taskId, put, onFiles],
  )
  const save = useCallback<CardComments['save']>(
    async (c, body, mentions, attachments) => {
      const r = await api<{ comment: CommentView }>('PATCH', `/boards/${boardId}/comments/${c.id}`, { body, mentions, attachments })
      put(r.comment)
      r.comment.attachments.forEach((a) => onFiles?.(a))
    },
    [boardId, put, onFiles],
  )
  const remove = useCallback<CardComments['remove']>(
    async (c) => {
      await api('DELETE', `/boards/${boardId}/comments/${c.id}`)
      setItems((xs) => xs.filter((x) => x.id !== c.id && x.parentId !== c.id))
    },
    [boardId],
  )
  const react = useCallback<CardComments['react']>(
    async (c, emoji, on, me) => {
      const without = c.reactions.map((r) => (r.emoji === emoji ? { ...r, by: r.by.filter((p) => p.id !== me.id) } : r)).filter((r) => r.by.length)
      const next = !on
        ? without
        : without.some((r) => r.emoji === emoji)
          ? without.map((r) => (r.emoji === emoji ? { ...r, by: [...r.by, me] } : r))
          : [...without, { emoji, by: [me] }]
      put({ ...c, reactions: next })
      try {
        put((await api<{ comment: CommentView }>('PUT', `/boards/${boardId}/comments/${c.id}/reactions`, { emoji, on })).comment)
      } catch (e) {
        put(c)
        throw e
      }
    },
    [boardId, put],
  )
  const resolve = useCallback<CardComments['resolve']>(
    async (c, resolved) => {
      put((await api<{ comment: CommentView }>('PUT', `/boards/${boardId}/comments/${c.id}/resolved`, { resolved })).comment)
    },
    [boardId, put],
  )

  return useMemo(() => ({ items, threads, post, save, remove, react, resolve }), [items, threads, post, save, remove, react, resolve])
}
