import { newId } from '@kanbanto/model/ids'
import type { Change } from '@kanbanto/model/records'
import type { Task } from '@kanbanto/model/types'
import { and, desc, eq, gt, isNull, notInArray } from 'drizzle-orm'
import type { Db } from '../db'
import { descriptionVersions } from '../db/schema'

// Earlier versions of a card's description. A description is one text that is replaced whole each time it is saved,
// by a person, an assistant, an undo, or (while people write together) every moment someone stops typing. What it
// read like before is kept here, so a text that was spoiled, by anyone or anything, can be looked at and brought
// back.

/**
 * A person's saves within this long of the first of them are one version: the last of them. (Counted from the first,
 * not the latest: text written together is saved every few seconds for as long as the writing goes on, and an
 * afternoon of it would otherwise be one version.)
 */
export const SITTING_MS = 10 * 60_000
/** Versions kept for one card: its newest. */
export const VERSIONS_KEPT = 100

/** The cards whose description a change replaced, with the text before and after. */
export function descriptionsChanged(changes: Change[]): { taskId: string; before: Task; text: string }[] {
  const out: { taskId: string; before: Task; text: string }[] = []
  for (const c of changes) {
    if (c.entity !== 'task' || !c.before || !c.after) continue
    const before = c.before as Task
    const text = (c.after as Task).description ?? ''
    if ((before.description ?? '') !== text) out.push({ taskId: c.id, before, text })
  }
  return out
}

/**
 * After a change: for each card whose description it replaced, the new text is kept as a version, by whoever made
 * the change. Their own version begun in the last few minutes is replaced by it (a sitting is one version, however
 * often it was saved); otherwise it is a new one. The first time a card's text changes, the text there was is kept too, as
 * the version before all of them (nobody's: versions weren't kept when it was written). A card keeps its newest
 * `VERSIONS_KEPT`.
 */
export async function keepVersions(db: Db, boardId: string, e: { userId: string; changes: Change[]; via?: string | null }, now = new Date()) {
  const changed = descriptionsChanged(e.changes)
  if (!changed.length) return
  await db.transaction(async (tx) => {
    for (const { taskId, before, text } of changed) {
      const card = and(eq(descriptionVersions.boardId, boardId), eq(descriptionVersions.taskId, taskId))
      // (Through the same app: what an assistant wrote in someone's name isn't put over what they wrote themselves.)
      const [mine] = await tx
        .select({ id: descriptionVersions.id })
        .from(descriptionVersions)
        .where(
          and(
            card,
            eq(descriptionVersions.by, e.userId),
            e.via ? eq(descriptionVersions.via, e.via) : isNull(descriptionVersions.via),
            gt(descriptionVersions.since, new Date(now.getTime() - SITTING_MS)),
          ),
        )
        .orderBy(desc(descriptionVersions.at))
        .limit(1)
      if (mine) {
        await tx.update(descriptionVersions).set({ text, at: now }).where(eq(descriptionVersions.id, mine.id))
        continue
      }
      const [any] = await tx.select({ id: descriptionVersions.id }).from(descriptionVersions).where(card).limit(1)
      const was = before.description ?? ''
      if (!any && was) {
        // (When it was last changed is the nearest there is to when that text was written.)
        const at = new Date(Math.min(Date.parse(before.updatedAt) || 0, now.getTime() - 1))
        await tx.insert(descriptionVersions).values({ id: newId(), boardId, taskId, text: was, by: null, via: null, at, since: at })
      }
      await tx.insert(descriptionVersions).values({ id: newId(), boardId, taskId, text, by: e.userId, via: e.via ?? null, at: now, since: now })
      const kept = await tx
        .select({ id: descriptionVersions.id })
        .from(descriptionVersions)
        .where(card)
        .orderBy(desc(descriptionVersions.at))
        .limit(VERSIONS_KEPT)
      if (kept.length === VERSIONS_KEPT)
        await tx.delete(descriptionVersions).where(
          and(
            card,
            notInArray(
              descriptionVersions.id,
              kept.map((k) => k.id),
            ),
          ),
        )
    }
  })
}
