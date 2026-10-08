import { describe, expect, it } from 'vitest'
import { describeAllChanges } from './activity'
import { applyChanges, invertChanges } from './changes'
import { execute } from './commands'
import type { BoardField } from './fields'
import { indexFor } from './indexer'
import { exampleData } from './sample'
import { CommandSchema } from './schema'
import { boardTemplateOf, fromTemplate, readTemplateCards, stepsOf, templateOf, TEMPLATE_CARDS_MAX, type TemplateCard } from './templates'
import type { BoardData } from './types'

const NOW = '2026-10-08T03:00:00.000Z'
const FIELDS: BoardField[] = [
  { id: 'f-client', name: 'Client', type: 'text' },
  { id: 'f-hours', name: 'Estimate', type: 'number', unit: 'h' },
  { id: 'f-paid', name: 'Paid', type: 'checkbox' },
  { id: 'f-close', name: 'Close date', type: 'date' },
  { id: 'f-stage', name: 'Stage', type: 'choice', options: [{ id: 'o-new', name: 'New', color: 'blue' }] },
  { id: 'f-rep', name: 'Rep', type: 'person' },
]
/** The example board, with fields, where Launch website (A) has values and its steps wait on each other. */
function board(): BoardData {
  const data = { ...exampleData('b1'), fields: FIELDS }
  data.tasks = {
    ...data.tasks,
    A: {
      ...data.tasks.A,
      description: 'Everything for launch day.',
      priority: 'high',
      labels: ['marketing'],
      custom: { 'f-client': 'Acme', 'f-hours': 40, 'f-paid': true, 'f-close': '2026-11-01', 'f-stage': ['o-new'], 'f-rep': ['ton'] },
    },
    A3: { ...data.tasks.A3, blockedBy: ['A2', 'B1'] },
  }
  return data
}
const cardsOf = (data: BoardData, id: string) => {
  const cards = templateOf(data, id)
  if ('error' in cards) throw new Error(cards.error)
  return cards
}
let n = 0
const use = (data: BoardData, cards: TemplateCard[], to: Parameters<typeof fromTemplate>[2]) => {
  const made = fromTemplate(data, { name: 'Launch', cards }, to, () => `n${++n}`)
  const r = execute(data, made.command, { now: NOW, newId: () => 'x', idx: indexFor(data) })
  if ('error' in r) throw new Error(r.error)
  return { ...made, changes: r.changes, after: applyChanges(data, r.changes) }
}

describe('a card template', () => {
  it('keeps what the card is, with everything under it, and leaves what happened to it', () => {
    const data = board()
    const cards = cardsOf(data, 'A')
    // The top card first, then the outline's order: a card always comes after its parent.
    expect(cards.map((c) => [c.key, c.parent, c.title])).toEqual([
      ['c0', null, 'Launch website'],
      ['c1', 'c0', 'Buy domain'],
      ['c2', 'c0', 'Design'],
      ['c3', 'c2', 'Homepage'],
      ['c4', 'c2', 'Logo'],
      ['c5', 'c0', 'Deploy'],
      ['c6', 'c0', 'Write the launch blog post'],
    ])
    expect(cards[0]).toEqual({
      key: 'c0',
      parent: null,
      title: 'Launch website',
      description: 'Everything for launch day.',
      labels: ['marketing'],
      priority: 'high',
      // Text, a number, a tick, a choice. Not the day, not the person.
      custom: { 'f-client': 'Acme', 'f-hours': 40, 'f-paid': true, 'f-stage': ['o-new'] },
    })
    // Nobody, no dates, no list, no number; a step waits on the steps of the same template only.
    for (const c of cards)
      expect(Object.keys(c).filter((k) => !['key', 'parent', 'title', 'description', 'labels', 'priority', 'custom', 'waits'].includes(k))).toEqual(
        [],
      )
    expect(cards[5]).toEqual({ key: 'c5', parent: 'c0', title: 'Deploy', waits: ['c2'] })
    expect(stepsOf({ cards })).toBe(6)
    // A card without subtasks is a template of one; a card that is gone, or far too big, isn't one.
    expect(cardsOf(data, 'B1')).toEqual([{ key: 'c0', parent: null, title: 'Send invites' }])
    expect(templateOf(data, 'nope')).toEqual({ error: 'That card no longer exists.' })
    const big = { ...data, tasks: { ...data.tasks } }
    for (let i = 0; i < TEMPLATE_CARDS_MAX; i++) big.tasks[`k${i}`] = { ...data.tasks.B1, id: `k${i}`, parentId: 'C' }
    expect(templateOf(big, 'C')).toEqual({
      error: `A template holds up to ${TEMPLATE_CARDS_MAX} cards: this one has ${TEMPLATE_CARDS_MAX + 3} with its subtasks.`,
    })
  })

  it('starts a card with its steps in a list, as one change with one undo, with nobody assigned and no dates', () => {
    const data = board()
    const cards = cardsOf(data, 'A')
    const { command, id, changes, after } = use(data, cards, { status: 'todo' })
    expect(CommandSchema.safeParse(command).success).toBe(true)
    const made = changes.flatMap((c) => (c.entity === 'task' && c.after ? [c.after] : []))
    expect(made).toHaveLength(7)
    const top = after.tasks[id]
    expect(top).toMatchObject({ title: 'Launch website', parentId: null, status: 'todo', priority: 'high', labels: ['marketing'] })
    expect(top.custom).toEqual({ 'f-client': 'Acme', 'f-hours': 40, 'f-paid': true, 'f-stage': ['o-new'] })
    for (const t of made) expect([t.assigneeId, t.start, t.due, t.reminders, t.status]).toEqual([undefined, undefined, undefined, undefined, 'todo'])
    // The shape comes back: steps under the card, steps under a step, and who waits on whom.
    const idx = indexFor(after)
    const titles = (ids: string[]) => ids.map((x) => after.tasks[x].title)
    expect(titles(idx.childrenOf.get(id)!)).toEqual(['Buy domain', 'Design', 'Deploy', 'Write the launch blog post'])
    const design = idx.childrenOf.get(id)![1]
    expect(titles(idx.childrenOf.get(design)!)).toEqual(['Homepage', 'Logo'])
    expect(after.tasks[idx.childrenOf.get(id)![2]].blockedBy).toEqual([design])
    // One line in the log, said as the card it is; one undo takes all of it back.
    expect(describeAllChanges(data, changes, command)).toEqual([
      { taskId: id, text: 'added “Launch website” from the template “Launch”, with 6 subtasks', own: 'added it from the template “Launch”' },
    ])
    const back = applyChanges(after, invertChanges(after, changes, NOW))
    expect(Object.keys(back.tasks).sort()).toEqual(Object.keys(data.tasks).sort())
    // Under a card, and with what the place it was put says (a person's row).
    const under = use(data, cardsOf(data, 'B1'), { status: 'doing', parentId: 'C', top: { assigneeId: 'ploy' } })
    expect(under.after.tasks[under.id]).toMatchObject({ title: 'Send invites', parentId: 'C', status: 'doing', assigneeId: 'ploy' })
    expect(describeAllChanges(data, under.changes, under.command)[0].text).toBe('added “Send invites” from the template “Launch”')
  })

  it('fits the board as it is now: a label, a field or an option that is gone is left out', () => {
    const data = board()
    const cards = cardsOf(data, 'A')
    const later: BoardData = {
      ...data,
      labels: data.labels.filter((l) => l.id !== 'marketing'),
      fields: [FIELDS[0], { ...FIELDS[4], options: [{ id: 'o-won', name: 'Won', color: 'green' }] }],
    }
    const { id, after } = use(later, cards, { status: 'backlog' })
    expect(after.tasks[id].labels).toEqual([])
    expect(after.tasks[id].custom).toEqual({ 'f-client': 'Acme' })
  })

  it('is read back only when it is in shape', () => {
    const cards = cardsOf(board(), 'A')
    expect(readTemplateCards(JSON.parse(JSON.stringify(cards)))).toEqual(cards)
    expect(readTemplateCards([])).toBeNull()
    expect(readTemplateCards('nonsense')).toBeNull()
    expect(readTemplateCards([{ ...cards[0], assigneeId: 'ton' }])).toBeNull()
    expect(readTemplateCards([{ ...cards[0], parent: 'c9' }])).toBeNull()
    expect(readTemplateCards([cards[0], { ...cards[1], parent: 'nope' }])).toBeNull()
    expect(readTemplateCards([cards[0], cards[1], cards[1]])).toBeNull()
    expect(readTemplateCards([cards[0], { ...cards[1], title: '' }])).toBeNull()
  })
})

describe('a board template', () => {
  it('keeps the board’s shape and its card templates, and none of its cards or people', () => {
    const data = { ...board(), board: { ...board().board, background: 'blue' as const, description: 'For launches' } }
    const kept = boardTemplateOf(data, [{ name: 'Launch', cards: cardsOf(data, 'A') }])
    expect(Object.keys(kept).sort()).toEqual(['board', 'cardTemplates', 'columns', 'fields', 'labels'])
    expect(kept.board).toEqual({ mode: 'derived', background: 'blue', description: 'For launches' })
    expect(kept.columns).toBe(data.columns)
    expect(kept.fields).toBe(data.fields)
    expect(kept.cardTemplates.map((t) => [t.name, t.cards.length])).toEqual([['Launch', 7]])
    expect(JSON.stringify(kept)).not.toContain('"tasks"')
    expect(JSON.stringify(kept)).not.toContain('"members"')
  })
})
