import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import type { CarryOn, FieldMap } from '@kanbanto/model/fields'
import { ASSIGNEE, describeRule, MAX_RULES, namesPeople, remapRule, ruleProblem, toldBy, type BoardRule } from '@kanbanto/model/rules'
import { BoardRuleSchema } from '@kanbanto/model/schema'
import { and, count, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Db, Tx } from '../db'
import { boardActivity, boardRuleMutes, boardRules, users } from '../db/schema'
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

/** How the board's log names a rule: a limit is a limit, one that tells people is a rule. */
const aRule = (rule: BoardRule) => (rule.kind === 'limit' ? 'a limit' : 'a rule')

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
    // (Once kept, a rule goes on telling the others when someone it names leaves. Made or changed, it names only people here.)
    if (rule.kind === 'when' && toldBy(rule).some((id) => id !== ASSIGNEE && !data.members.some((m) => m.id === id)))
      throw new HttpError(422, 'That rule can’t be kept. Someone it tells isn’t on the board.')
    const words = describeRule(rule, data)
    if (ruleId) {
      const [was] = await tx.update(boardRules).set({ rule, updatedBy: me.id, updatedAt: new Date() }).where(eq(boardRules.id, ruleId)).returning()
      if (!was || was.boardId !== boardId) throw new HttpError(404, 'That rule no longer exists.')
      await tx.insert(boardActivity).values(said(me.id, boardId, `changed ${aRule(rule)}: ${words}`, via))
    } else {
      const [{ n }] = await tx.select({ n: count() }).from(boardRules).where(eq(boardRules.boardId, boardId))
      if (n >= MAX_RULES) throw new HttpError(422, `A board can have up to ${MAX_RULES} rules. Remove one first.`)
      await tx.insert(boardRules).values({ id: rule.id, boardId, rule, updatedBy: me.id })
      await tx.insert(boardActivity).values(said(me.id, boardId, `added ${aRule(rule)}: ${words}`, via))
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
      .values(said(me.id, boardId, rule.success ? `removed ${aRule(rule.data)}: ${describeRule(rule.data, data)}` : 'removed a rule', via))
  })
  app.engine.reloaded([boardId])
}

/**
 * Who asked which of a board's rules not to tell them: your own (`mine`, rule ids), and for the board's owners
 * (`all`) everyone's, by rule. Kept apart from the board, which is sent whole to everyone who can open it.
 */
export async function ruleMutes(db: Db | Tx, boardId: string, userId: string, all: boolean) {
  const rows = await db
    .select({ ruleId: boardRuleMutes.ruleId, userId: boardRuleMutes.userId, name: users.name })
    .from(boardRuleMutes)
    .innerJoin(boardRules, eq(boardRules.id, boardRuleMutes.ruleId))
    .innerJoin(users, eq(users.id, boardRuleMutes.userId))
    .where(and(eq(boardRules.boardId, boardId), all ? undefined : eq(boardRuleMutes.userId, userId)))
    .orderBy(boardRuleMutes.createdAt)
  const everyone: Record<string, { id: string; name: string }[]> = {}
  for (const r of rows) (everyone[r.ruleId] ??= []).push({ id: r.userId, name: r.name })
  return { mine: rows.filter((r) => r.userId === userId).map((r) => r.ruleId), ...(all && { all: everyone }) }
}

/** Asks a rule that tells people not to tell you (or to tell you again). Changes nothing about the board. */
export async function setRuleMute(db: Db | Tx, boardId: string, ruleId: string, userId: string, muted: boolean) {
  const [row] = await db
    .select({ rule: boardRules.rule })
    .from(boardRules)
    .where(and(eq(boardRules.id, ruleId), eq(boardRules.boardId, boardId)))
  if (!row) throw new HttpError(404, 'That rule no longer exists.')
  if ((row.rule as { kind?: string }).kind !== 'when') throw new HttpError(422, 'That rule doesn’t tell anyone.')
  if (muted) await db.insert(boardRuleMutes).values({ ruleId, userId }).onConflictDoNothing()
  else await db.delete(boardRuleMutes).where(and(eq(boardRuleMutes.ruleId, ruleId), eq(boardRuleMutes.userId, userId)))
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
