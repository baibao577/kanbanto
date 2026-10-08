import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import type { CarryOn, FieldMap } from '@kanbanto/model/fields'
import { describeRule, MAX_RULES, namesPeople, remapRule, ruleProblem, type BoardRule } from '@kanbanto/model/rules'
import { BoardRuleSchema } from '@kanbanto/model/schema'
import { count, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Tx } from '../db'
import { boardActivity, boardRules } from '../db/schema'
import { HttpError } from '../http'
import { boardRulesOf, loadBoard } from './store'

// A board's rules (see model rules.ts), kept one to a row and loaded with the board. Like the board's fields, they
// are not a command's to change: its owners change them here, the board's change number moves with the change, and
// every open copy reads the board again. Nothing a rule works out is stored.

const said = (actorId: string, boardId: string, text: string, via?: string | null) => ({
  id: newId(),
  boardId,
  actorId,
  command: 'board.rules',
  items: [{ text }],
  via: via ?? null,
})

/**
 * Makes a rule (no `ruleId`) or changes one, for the board's owners. The rule has to be whole and about things the
 * board has now: a rule that names a list, a label, a person or a field that's gone is refused with the reason, as
 * is one a rule can't be (about "me", or a date). Answers with the rule as it's kept.
 */
export async function saveRule(app: FastifyInstance, boardId: string, me: { id: string }, input: unknown, ruleId?: string, via?: string | null) {
  const read = BoardRuleSchema.safeParse({ ...(input as object), id: ruleId ?? newId() })
  if (!read.success) throw new HttpError(400, 'That isn’t a rule this board can keep.')
  const rule = read.data
  await app.db.transaction(async (tx) => {
    // (The board is held first, as for any change to it, then read: what the rule names is checked against that.)
    await app.engine.bump(tx, [boardId])
    const { data } = (await loadBoard(tx, boardId))!
    const problem = ruleProblem(indexFor(data), rule, data.labels)
    if (problem) throw new HttpError(422, `That rule can’t be kept. ${problem}`)
    const words = describeRule(rule, data)
    if (ruleId) {
      const [was] = await tx.update(boardRules).set({ rule, updatedBy: me.id, updatedAt: new Date() }).where(eq(boardRules.id, ruleId)).returning()
      if (!was || was.boardId !== boardId) throw new HttpError(404, 'That rule no longer exists.')
      await tx.insert(boardActivity).values(said(me.id, boardId, `changed a limit: ${words}`, via))
    } else {
      const [{ n }] = await tx.select({ n: count() }).from(boardRules).where(eq(boardRules.boardId, boardId))
      if (n >= MAX_RULES) throw new HttpError(422, `A board can have up to ${MAX_RULES} rules. Remove one first.`)
      await tx.insert(boardRules).values({ id: rule.id, boardId, rule, updatedBy: me.id })
      await tx.insert(boardActivity).values(said(me.id, boardId, `added a limit: ${words}`, via))
    }
  })
  app.engine.reloaded([boardId])
  return rule
}

/** Removes a rule (the board's owners). */
export async function removeRule(app: FastifyInstance, boardId: string, me: { id: string }, ruleId: string, via?: string | null) {
  await app.db.transaction(async (tx) => {
    await app.engine.bump(tx, [boardId])
    const { data } = (await loadBoard(tx, boardId))!
    const [was] = await tx.delete(boardRules).where(eq(boardRules.id, ruleId)).returning()
    if (!was || was.boardId !== boardId) throw new HttpError(404, 'That rule no longer exists.')
    const rule = BoardRuleSchema.safeParse({ ...(was.rule as object), id: was.id })
    await tx
      .insert(boardActivity)
      .values(said(me.id, boardId, rule.success ? `removed a limit: ${describeRule(rule.data, data)}` : 'removed a rule', via))
  })
  app.engine.reloaded([boardId])
}

/**
 * A board's fields are getting other ids (two fields merged into one; the board moving to another library of
 * fields): its rules follow, the way its saved filters do (`remapRule`). A rule that can't be carried whole is left
 * as it is, and shows as one that can't be worked out until its owner sees to it: carried without a condition, it
 * would be a wider limit and nobody would know. The caller holds the board (`engine.bump`).
 */
export async function moveRuleFields(tx: Tx, boardId: string, map: FieldMap, others: 'keep' | 'drop', on?: CarryOn) {
  for (const rule of await boardRulesOf(tx, boardId)) {
    const next = remapRule(rule, map, others, on)
    if (next && JSON.stringify(next) !== JSON.stringify(rule)) await tx.update(boardRules).set({ rule: next }).where(eq(boardRules.id, rule.id))
  }
}

/**
 * The rules a board brings with it from a file, kept for the board made from it: under new ids (the same file may
 * be read twice), with its fields' new ids, and without the ones that name people (who aren't carried over) or that
 * can't be carried whole.
 */
export async function adoptRules(
  tx: Tx,
  boardId: string,
  rules: BoardRule[] | undefined,
  by: string,
  map: FieldMap,
  isPersonField: (id: string) => boolean,
) {
  const kept = (rules ?? [])
    .filter((r) => !namesPeople(r, isPersonField))
    .flatMap((r) => remapRule(r, map, 'drop') ?? [])
    .slice(0, MAX_RULES)
    .map((r) => ({ ...r, id: newId() }))
  // (Made a millisecond apart, so they stay in the order they came in: a board's rules are listed oldest first.)
  const now = Date.now()
  if (kept.length)
    await tx
      .insert(boardRules)
      .values(kept.map((rule, i) => ({ id: rule.id, boardId, rule, updatedBy: by, createdAt: new Date(now + i), updatedAt: new Date(now + i) })))
  return kept.length
}
