import { describe, expect, it } from 'vitest'
import type { BoardField } from './fields'
import { indexFor } from './indexer'
import { groupCards, groupFields, groupKeep, groupKeyOf, groupKeys, groupLabel, groupName, type GroupKey } from './outlineGroups'
import { cleanPrefs, defaultPrefs, remapPreset, type PresetSettings } from './prefs'
import { exampleData } from './sample'
import { PresetSettingsSchema } from './schema'
import { flattenTree } from './tree'
import type { BoardData } from './types'

const stage: BoardField = {
  id: 'stage',
  name: 'Stage',
  type: 'choice',
  options: [
    { id: 'o-new', name: 'New', color: 'blue' },
    { id: 'o-won', name: 'Won', color: 'green' },
  ],
}
const reviewer: BoardField = { id: 'who', name: 'Reviewer', type: 'person' }
const paid: BoardField = { id: 'paid', name: 'Paid', type: 'checkbox' }
const hours: BoardField = { id: 'hours', name: 'Estimate', type: 'number' }
const note: BoardField = { id: 'note', name: 'Note', type: 'text' }

/**
 * The example board: Launch website (A, Mai) with Buy domain (A1, Mai, done), Design (A2, Ton) with Homepage (A2a)
 * and Logo (A2b), Deploy (A3, Mai) and a blog post (A4, Mai, backlog); Event (B, Ploy) with B1 and B2; Newsletter
 * redesign (C, nobody) with C1 and C2. A parent's list follows its subtasks.
 */
function board(custom: Record<string, Record<string, unknown>> = {}, change: Record<string, object> = {}): BoardData {
  const data = exampleData('b1')
  return {
    ...data,
    fields: [stage, reviewer, paid, hours, note],
    tasks: Object.fromEntries(
      Object.values(data.tasks).map((t) => [t.id, { ...t, ...change[t.id], ...(custom[t.id] && { custom: custom[t.id] as never }) }]),
    ),
  }
}
/** The headings and their cards, in words: "Ton: A2 A2a A2b". */
const grouped = (data: BoardData, key: GroupKey, ids?: string[]) => {
  const idx = indexFor(data)
  return groupCards(idx, data.labels, key, ids ?? idx.preorder).map((g) => `${groupName(idx, data.labels, key, g.value)}: ${g.cards.join(' ')}`)
}

describe('grouping the Outline', () => {
  it('by list: every list in the board’s order, empty ones too, each card under the list the board shows it in', () => {
    const data = board()
    expect(grouped(data, 'status')).toEqual(['Backlog: A4 B2 C C1 C2', 'To Do: A2b A3', 'Doing: A A2 A2a B B1', 'Done: A1'])
    // Only some of the cards (a filter): the lists are all still there.
    expect(grouped(data, 'status', ['A3'])).toEqual(['Backlog: ', 'To Do: A3', 'Doing: ', 'Done: '])
  })

  it('by person: the people who have cards, by name, and the cards of nobody last', () => {
    const data = board()
    expect(grouped(data, 'assignee')).toEqual(['Mai: A A1 A3 A4', 'Ploy: B B1 B2', 'Ton: A2 A2a A2b', 'No assignee: C C1 C2'])
    // Someone with no cards has no heading, and a card of someone who left is nobody's.
    expect(grouped(data, 'assignee', ['A2', 'C'])).toEqual(['Ton: A2', 'No assignee: C'])
    const left = { ...data, members: data.members.filter((m) => m.id !== 'ton') }
    expect(grouped(left, 'assignee', ['A2', 'A3'])).toEqual(['Mai: A3', 'No assignee: A2'])
  })

  it('by priority: from Urgent down, and the cards without one last', () => {
    const data = board({}, { A3: { priority: 'low' }, B1: { priority: 'urgent' }, C1: { priority: 'high' }, A1: { priority: 'urgent' } })
    expect(grouped(data, 'priority', ['A1', 'A3', 'B1', 'C1', 'C2'])).toEqual(['Urgent: A1 B1', 'High: C1', 'Low: A3', 'No priority: C2'])
  })

  it('by label: in the labels’ order, a card with two labels under each, a label that is gone not counted', () => {
    const data = board({}, { A2a: { labels: ['brand', 'ui', 'gone'] }, A3: { labels: ['gone'] } })
    expect(grouped(data, 'labels', ['A2a', 'A2b', 'A3', 'A4', 'B'])).toEqual(['ui: A2a', 'brand: A2a A2b', 'marketing: A4', 'No label: A3 B'])
  })

  it('by one of the board’s fields: a choice, a person, a tick', () => {
    const data = board({
      A1: { stage: ['o-won'], paid: true, who: ['ploy'] },
      A3: { stage: ['o-new'], who: ['mai', 'ploy'] },
      B1: { stage: ['o-new', 'o-won'], paid: false },
      C1: { stage: ['o-gone'], who: ['someone-who-left'] },
    })
    const ids = ['A1', 'A3', 'B1', 'C1']
    expect(grouped(data, 'f:stage', ids)).toEqual(['New: A3 B1', 'Won: A1 B1', 'No stage: C1'])
    expect(grouped(data, 'f:who', ids)).toEqual(['Mai: A3', 'Ploy: A1 A3', 'No reviewer: B1 C1'])
    expect(grouped(data, 'f:paid', ids)).toEqual(['Paid: ticked: A1', 'Paid: not ticked: A3 B1 C1'])
  })

  it('what can be grouped by: lists, people, priorities, labels, and fields with a short set of values', () => {
    const data = board()
    const fields = indexFor(data).fields
    expect(groupKeys(data.fields)).toEqual(['status', 'assignee', 'priority', 'labels', 'f:stage', 'f:who', 'f:paid'])
    expect(groupKeyOf('assignee', fields)).toBe('assignee')
    expect(groupKeyOf('f:stage', fields)).toBe('f:stage')
    // A number, a text, a field that is gone, a column that isn't one: not grouped.
    for (const k of ['f:hours', 'f:note', 'f:gone', 'due', 'title', undefined]) expect(groupKeyOf(k, fields)).toBeUndefined()
    expect(groupLabel('status', fields)).toBe('List')
    expect(groupLabel('f:who', fields)).toBe('Reviewer')
  })

  it('under a heading: its own cards with the cards above them for context, in the tree’s order', () => {
    const data = board()
    const idx = indexFor(data)
    const rows = (key: GroupKey, name: string) => {
      const g = groupCards(idx, data.labels, key, idx.preorder).find((x) => groupName(idx, data.labels, key, x.value) === name)!
      return flattenTree(idx, idx.roots, new Set(), 100, groupKeep(idx, g.cards)).rows
    }
    // Ton's steps sit inside Mai's project, which comes along; Mai's own cards under it don't.
    expect(rows('assignee', 'Ton')).toEqual(['A', 'A2', 'A2a', 'A2b'])
    expect(rows('assignee', 'Mai')).toEqual(['A', 'A1', 'A3', 'A4'])
    expect(rows('status', 'To Do')).toEqual(['A', 'A2', 'A2b', 'A3'])
    expect(rows('status', 'Done')).toEqual(['A', 'A1'])
  })

  it('a card added under a heading starts with that heading’s value', () => {
    const data = board()
    const idx = indexFor(data)
    expect(groupFields(idx, 'status', 'doing')).toEqual({ status: 'doing' })
    expect(groupFields(idx, 'assignee', 'ton')).toEqual({ assigneeId: 'ton' })
    expect(groupFields(idx, 'priority', 'high')).toEqual({ priority: 'high' })
    expect(groupFields(idx, 'labels', 'ui')).toEqual({ labels: ['ui'] })
    expect(groupFields(idx, 'f:stage', 'o-won')).toEqual({ custom: { stage: ['o-won'] } })
    expect(groupFields(idx, 'f:who', 'ploy')).toEqual({ custom: { who: ['ploy'] } })
    expect(groupFields(idx, 'f:paid', 'yes')).toEqual({ custom: { paid: true } })
    // Under "none", and under "not ticked": nothing to set.
    for (const [k, v] of [
      ['assignee', ''],
      ['labels', ''],
      ['f:stage', ''],
      ['f:paid', 'no'],
    ] as [GroupKey, string][])
      expect(groupFields(idx, k, v)).toEqual({})
  })

  it('is kept with the Outline’s settings, follows a field that changes its id and goes with a field that is gone', () => {
    const settings: PresetSettings = { ...presetBase, outline: { group: 'f:stage', density: 'compact' } }
    expect(PresetSettingsSchema.parse(settings).outline.group).toBe('f:stage')
    expect(PresetSettingsSchema.parse({ ...settings, outline: { group: 'assignee' } }).outline.group).toBe('assignee')
    // A grouping a later version might add reads as not grouped, and the rest is kept.
    expect(PresetSettingsSchema.parse({ ...settings, outline: { group: 'due', density: 'compact' } }).outline).toEqual({ density: 'compact' })
    expect(remapPreset(settings, new Map([['stage', { id: 'phase' }]]), 'keep').outline).toEqual({ group: 'f:phase', density: 'compact' })
    expect(remapPreset(settings, new Map(), 'drop').outline).toEqual({ density: 'compact' })
    expect(remapPreset({ ...settings, outline: { group: 'labels' } }, new Map(), 'drop').outline).toEqual({ group: 'labels' })
    const data = board()
    const prefs = { ...defaultPrefs(), outline: { group: 'f:stage' as const } }
    expect(cleanPrefs(prefs, data)).toBe(prefs)
    expect(cleanPrefs(prefs, { ...data, fields: [paid] }).outline.group).toBeUndefined()
  })
})

const presetBase: PresetSettings = { display: defaultPrefs().display, outline: {}, filter: {} }
