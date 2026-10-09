import { newId } from '@kanbanto/model/ids'
import { indexFor } from '@kanbanto/model/indexer'
import type { Change } from '@kanbanto/model/records'
import { ASSIGNEE, firings, momentOf, toldBy, whensOf, type WhenRule } from '@kanbanto/model/rules'
import type { BoardData } from '@kanbanto/model/types'
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { boardRuleMutes, notifications, users, type RuleNotice } from '../db/schema'
import { tellPerson } from '../tell'

// The board's rules that tell people (model rules.ts: "when a card arrives in Quoted, tell Dana"), asked at each
// change to the board. Which cards arrived or left is the model's to say, from the board before and after; here is
// who hears of it, and how: a line under the bell (and in the morning summary), and as it happens for the people who
// asked for that about the cards they follow.

/** What one rule says to one person about one person's changes within this long is one line under the bell. */
const TOGETHER_MS = 10 * 60_000
/** Cards named in one line; the rest are counted. */
const MAX_CARDS = 20

type Card = { id: string; title: string }
const q = (s: string) => `“${s}”`
/** "“Call Acme” and 2 more cards" */
export const cardsInWords = (cards: Card[], more: number) => {
  const others = cards.length - 1 + more
  return `${q(cards[0]?.title ?? 'A card')}${others > 0 ? ` and ${others.toLocaleString('en')} more ${others === 1 ? 'card' : 'cards'}` : ''}`
}

/**
 * After a change to a board (a command, or a card moving to or from another board): each of its rules that tells
 * people is asked which cards arrived in its cards, or left them, and the people it names are told: the ones ticked
 * who are still on the board, and whoever the card is assigned to (as it arrives; as it was when it left). Never the
 * person who made the change, nor anyone who switched that rule off for themselves.
 *
 * Answers with the cards each person was told about, so they aren't told the same again as followers of them.
 */
export async function tellByRules(
  app: FastifyInstance,
  boardId: string,
  e: { userId: string; changes: Change[]; data: BoardData; before: BoardData },
): Promise<Map<string, Set<string>>> {
  const told = new Map<string, Set<string>>()
  const rules = whensOf(e.data.rules)
  if (!rules.length) return told
  const touched = e.changes.flatMap((c) => (c.entity === 'task' ? [c.id] : []))
  if (!touched.length) return told

  const before = { idx: indexFor(e.before), labels: e.before.labels }
  const after = { idx: indexFor(e.data), labels: e.data.labels }
  const onBoard = new Set(e.data.members.map((m) => m.id))
  const fired: { rule: WhenRule; moment: string; people: Map<string, Card[]> }[] = []
  for (const rule of rules) {
    const f = firings(before, after, rule, touched)
    // (A card that arrived is read from the board as it is; one that left, from the board as it was.)
    const [ids, side, idx] = rule.on === 'enters' ? [f.entered, e.data, after.idx] : [f.left, e.before, before.idx]
    if (!ids.length) continue
    const who = toldBy(rule)
    const ticked = who.filter((id) => id !== ASSIGNEE && onBoard.has(id))
    const people = new Map<string, Card[]>()
    for (const id of [...ids].sort((a, b) => idx.position.get(a)! - idx.position.get(b)!)) {
      const card = side.tasks[id]
      const to = new Set(ticked)
      if (who.includes(ASSIGNEE) && card.assigneeId && onBoard.has(card.assigneeId)) to.add(card.assigneeId)
      to.delete(e.userId)
      for (const userId of to) {
        const cards = people.get(userId)
        if (cards) cards.push({ id, title: card.title })
        else people.set(userId, [{ id, title: card.title }])
      }
    }
    if (people.size) fired.push({ rule, moment: momentOf(rule, e.data), people })
  }
  if (!fired.length) return told

  const off = new Set(
    (
      await app.db
        .select()
        .from(boardRuleMutes)
        .where(
          inArray(
            boardRuleMutes.ruleId,
            fired.map((f) => f.rule.id),
          ),
        )
    ).map((m) => `${m.ruleId}:${m.userId}`),
  )
  // One push to a person for a change, however many rules it set off for them: the first one's.
  const pushes = new Map<string, { rule: WhenRule; moment: string; cards: Card[] }>()
  const since = new Date(Date.now() - TOGETHER_MS)
  await app.db.transaction(async (tx) => {
    for (const { rule, moment, people } of fired)
      for (const [userId, cards] of people) {
        if (off.has(`${rule.id}:${userId}`)) continue
        // More from the same rule about the same person's changes, not yet seen: added to that line.
        const [open] = await tx
          .select({ id: notifications.id, said: notifications.said })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, userId),
              eq(notifications.kind, 'rule'),
              eq(notifications.boardId, boardId),
              eq(notifications.ruleId, rule.id),
              eq(notifications.actorId, e.userId),
              isNull(notifications.readAt),
              isNull(notifications.keptAt),
              isNull(notifications.emailedAt),
              gt(notifications.createdAt, since),
            ),
          )
          .orderBy(desc(notifications.createdAt))
          .limit(1)
        if (open?.said && open.said.moment === moment) {
          const had = new Set(open.said.cards.map((c) => c.id))
          const all = [...open.said.cards, ...cards.filter((c) => !had.has(c.id))]
          const said: RuleNotice = { moment, cards: all.slice(0, MAX_CARDS), more: open.said.more + Math.max(0, all.length - MAX_CARDS) }
          await tx
            .update(notifications)
            .set({ said, createdAt: sql`now()` })
            .where(eq(notifications.id, open.id))
        } else {
          const said: RuleNotice = { moment, cards: cards.slice(0, MAX_CARDS), more: Math.max(0, cards.length - MAX_CARDS) }
          await tx
            .insert(notifications)
            .values({ id: newId(), userId, kind: 'rule', boardId, taskId: cards[0].id, actorId: e.userId, ruleId: rule.id, said })
        }
        if (!pushes.has(userId)) pushes.set(userId, { rule, moment, cards })
        const mine = told.get(userId)
        if (mine) for (const c of cards) mine.add(c.id)
        else told.set(userId, new Set(cards.map((c) => c.id)))
      }
  })
  if (!pushes.size) return told

  // (Someone who moved a card here from another board needn't be on this one.)
  let actor = e.data.members.find((m) => m.id === e.userId)?.name
  if (!actor) [{ name: actor } = { name: undefined }] = await app.db.select({ name: users.name }).from(users).where(eq(users.id, e.userId))
  const board = `/#/b/${encodeURIComponent(boardId)}`
  for (const [userId, p] of pushes) {
    // (A card that left by being deleted, archived or moved away has nothing to open: the board, then.)
    const first = p.cards[0].id
    const url = e.data.tasks[first] ? `${board}?task=${encodeURIComponent(first)}` : board
    void tellPerson(
      app,
      userId,
      'follows',
      {
        title: `${cardsInWords(p.cards, 0)} ${p.moment}`,
        body: [p.rule.name, `By ${actor ?? 'someone'}`, e.data.board.name].filter(Boolean).join(' · '),
        url,
        tag: `rule:${boardId}:${p.rule.id}`,
      },
      24 * 3600,
      { boardId, covered: 'board.changed' },
    ).catch((err) => app.log.error({ err: err instanceof Error ? err.message : err }, 'push'))
  }
  return told
}
