import { describe, expect, it } from 'vitest'
import { carryCustom, checkValue, nameKey, nameProblem, planAdoption, planStarter, type FieldDef, type FieldMap, type LibraryField } from './fields'
import { indexFor } from './indexer'
import { DEFAULT_DISPLAY, remapPreset, type PresetSettings } from './prefs'
import { BoardDataSchema, PresetSettingsSchema } from './schema'
import { STARTERS, STARTER_INFO, starterBoard, isStarter } from './starters'

const BOARD = '01900000-0000-7000-8000-00000000000a'
let n = 0
const newId = () => `lib-${++n}`
const defs = (kind: (typeof STARTERS)[number]): FieldDef[] => starterBoard(kind, BOARD).data.fields.map(({ front: _f, total: _t, ...def }) => def)

describe('a starter board', () => {
  it.each(STARTERS)('%s: is a whole board whose example cards fit its own fields', (kind) => {
    const { data, presets } = starterBoard(kind, BOARD)
    expect(BoardDataSchema.safeParse(data).success).toBe(true)
    expect(data.board).toMatchObject({ id: BOARD, mode: 'manual', name: STARTER_INFO[kind].name })
    // Fields a person could have made themselves: allowed names, no two alike, at most three on the card.
    for (const f of data.fields) expect(nameProblem(f.name)).toBeNull()
    expect(new Set(data.fields.map((f) => nameKey(f.name))).size).toBe(data.fields.length)
    expect(data.fields.filter((f) => f.front).length).toBeLessThanOrEqual(3)
    for (const f of data.fields) if (f.total) expect(f).toMatchObject({ type: 'number', sum: true })
    // Lists of its own (none is the hidden-by-default "backlog"), in order, with somewhere to start and to finish.
    const idx = indexFor(data)
    expect(idx.columns.map((c) => c.id)).toEqual(data.columns.map((c) => c.id))
    expect(data.columns.some((c) => c.id === 'backlog')).toBe(false)
    expect(data.columns[0].category).toBe('todo')
    expect(data.columns.some((c) => c.category === 'done')).toBe(true)
    const cards = Object.values(data.tasks)
    expect(cards.length).toBe(5)
    for (const t of cards) {
      expect(data.columns.some((c) => c.id === t.status)).toBe(true)
      for (const l of t.labels) expect(data.labels.some((x) => x.id === l)).toBe(true)
      for (const [id, v] of Object.entries(t.custom ?? {})) {
        const def = data.fields.find((f) => f.id === id)!
        expect(def, `${t.title}: ${id}`).toBeDefined()
        expect(checkValue(def, v), `${t.title}: ${def.name}`).toEqual({ value: v })
      }
    }
    // Saved filters: each is a preset as the app saves them, about the starter's own fields, one card per task.
    for (const p of presets) {
      expect(PresetSettingsSchema.safeParse(p.settings).success, p.name).toBe(true)
      expect(p.settings.display.board.filter).toBe('main')
      for (const id of Object.keys(p.settings.filter.fields ?? {})) expect(data.fields.some((f) => f.id === id)).toBe(true)
    }
    expect(isStarter(kind)).toBe(true)
    expect(isStarter('example')).toBe(false)
  })

  it('keeps the ids of its options for good: they end up in people’s libraries', () => {
    const ids = STARTERS.flatMap((kind) =>
      starterBoard(kind, BOARD).data.fields.flatMap((f) => (f.options ?? []).map((o) => `${f.name}: ${o.name} = ${o.id}`)),
    )
    expect(ids).toEqual([
      'Source: Referral = st-source-referral',
      'Source: Website = st-source-website',
      'Source: Outreach = st-source-outreach',
      'Source: Event = st-source-event',
      'Severity: Low = st-severity-low',
      'Severity: Normal = st-severity-normal',
      'Severity: High = st-severity-high',
      'Severity: Critical = st-severity-critical',
      'Channel: Email = st-channel-email',
      'Channel: Chat = st-channel-chat',
      'Channel: Phone = st-channel-phone',
    ])
  })

  it('once fitted to a library, nothing on the board names the starter’s own fields any more', () => {
    for (const kind of STARTERS) {
      const { data, presets } = starterBoard(kind, BOARD)
      const plan = planStarter([], defs(kind), { canAdd: true, room: 50, newId })
      const cards = Object.values(data.tasks).map((t) => carryCustom(t.custom, plan.map))
      const filters = presets.map((p) => remapPreset(p.settings, plan.map, 'drop'))
      expect(JSON.stringify([cards, filters])).not.toMatch(/st-(sales|support)-/)
      for (const [i, c] of cards.entries()) expect(Object.keys(c ?? {}).length).toBe(Object.keys(Object.values(data.tasks)[i].custom ?? {}).length)
      for (const f of filters) expect(PresetSettingsSchema.safeParse(f).success).toBe(true)
      // Every saved filter still says something.
      for (const f of filters) expect(Object.keys(f.filter.fields ?? {}).length + (f.outline.sort ? 1 : 0)).toBeGreaterThan(0)
    }
  })
})

describe('fitting a starter to a library', () => {
  const wanted = defs('sales')
  const names = wanted.map((f) => f.name)

  it('adds what the library lacks, once: the second board uses the same fields', () => {
    const first = planStarter([], wanted, { canAdd: true, room: 50, newId })
    expect(first.add.map((f) => f.name)).toEqual(names)
    expect(first).toMatchObject({ leftOut: [], cant: [] })
    expect(first.add.every((f) => f.id.startsWith('lib-'))).toBe(true)
    // (The options keep their ids: a value for one needs no translating.)
    expect(first.add.find((f) => f.name === 'Source')!.options!.map((o) => o.id)).toContain('st-source-event')
    const second = planStarter(first.add, wanted, { canAdd: false, room: 0, newId })
    expect(second).toMatchObject({ add: [], leftOut: [], cant: [] })
    expect([...second.map.values()].map((m) => m.id)).toEqual(first.add.map((f) => f.id))
  })

  it('can’t be made when a field has to be added and the person may not, or there’s no room', () => {
    const guest = planStarter([], wanted, { canAdd: false, room: 50, newId })
    expect(guest).toMatchObject({ add: [], cant: names, why: 'manage' })
    const full = planStarter([], wanted, { canAdd: true, room: 2, newId })
    expect(full.add.map((f) => f.name)).toEqual(names.slice(0, 2))
    expect(full).toMatchObject({ cant: names.slice(2), why: 'room' })
  })

  it('uses a field the library has as it is, and never changes it', () => {
    const source: LibraryField = {
      id: 'mine',
      name: 'source',
      type: 'choice',
      options: [
        { id: 'o1', name: 'Website', color: 'red' },
        { id: 'o2', name: 'Partner', color: 'blue' },
        { id: 'o3', name: 'Event', color: 'gray', archived: true },
      ],
    }
    const plan = planStarter([source], wanted, { canAdd: true, room: 50, newId })
    expect(plan.add.map((f) => f.name)).not.toContain('Source')
    const to = plan.map.get('st-sales-source')!
    expect(to.id).toBe('mine')
    // Website is theirs under another id; Referral and Outreach they don't have; Event they put away.
    expect([...to.options!]).toEqual([['st-source-website', 'o1']])
    const { data } = starterBoard('sales', BOARD)
    const carried = Object.values(data.tasks).map((t) => carryCustom(t.custom, plan.map)?.mine)
    expect(carried).toEqual([['o1'], undefined, undefined, undefined, undefined])
    // A saved filter that asked for options that aren't there loses them.
    const asks: PresetSettings = {
      display: { board: DEFAULT_DISPLAY.board },
      outline: {},
      filter: { fields: { 'st-sales-source': { in: ['st-source-event'] } } },
    }
    expect(remapPreset(asks, plan.map, 'drop').filter.fields).toBeUndefined()
  })

  it('leaves out a field the library archived, and numbers one whose name another kind has', () => {
    const library: LibraryField[] = [
      { id: 'a', name: 'Company', type: 'text', archived: true },
      { id: 'b', name: 'Close date', type: 'text' },
    ]
    const plan = planStarter(library, wanted, { canAdd: true, room: 50, newId })
    expect(plan.leftOut).toEqual(['Company'])
    expect(plan.map.has('st-sales-company')).toBe(false)
    expect(plan.add.map((f) => f.name)).toEqual(['Deal value', 'Contact email', 'Close date (2)', 'Source'])
    // Next time the numbered one is found again.
    const again = planStarter([...library, ...plan.add], wanted, { canAdd: false, room: 0, newId })
    expect(again).toMatchObject({ add: [], cant: [], leftOut: ['Company'] })
    expect(again.map.get('st-sales-close')!.id).toBe(plan.add.find((f) => f.name === 'Close date (2)')!.id)
  })
})

describe('fields arriving in a library (an import, a board changing space)', () => {
  const stage = (options: NonNullable<FieldDef['options']>): FieldDef => ({ id: 'f-stage', name: 'Stage', type: 'choice', options })

  it('an option the library archived is the one a value goes to: no second option of that name', () => {
    const library: LibraryField[] = [
      {
        ...stage([
          { id: 'x-lead', name: 'Lead', color: 'gray' },
          { id: 'x-won', name: 'Won', color: 'green', archived: true },
        ]),
        id: 'theirs',
      },
    ]
    const incoming = stage([
      { id: 'lead', name: 'Lead', color: 'gray' },
      { id: 'won', name: 'Won', color: 'green' },
      { id: 'lost', name: 'Lost', color: 'red' },
    ])
    const plan = planAdoption(library, [incoming], { canAdd: true, room: 10, newId })
    expect(plan.addOptions.get('theirs')!.map((o) => o.name)).toEqual(['Lost'])
    expect(plan.lose).toEqual([])
    expect(carryCustom({ 'f-stage': ['won'] }, plan.map)).toEqual({ theirs: ['x-won'] })
  })

  it('the very same option is found by its id, whatever it’s called now; an unrelated one that shares the id isn’t', () => {
    const library: LibraryField[] = [{ ...stage([{ id: 'won', name: 'Closed', color: 'green' }]), id: 'theirs' }]
    const plan = planAdoption(library, [stage([{ id: 'won', name: 'Won', color: 'green' }])], { canAdd: true, room: 10, newId })
    expect(plan.addOptions.size).toBe(0)
    expect(carryCustom({ 'f-stage': ['won'] }, plan.map)).toEqual({ theirs: ['won'] })
    // Here "won" in the library is their Lead: it goes to the option called Lead, and Won is added beside it.
    const clash: LibraryField[] = [{ ...stage([{ id: 'won', name: 'Lead', color: 'gray' }]), id: 'theirs' }]
    const both = stage([
      { id: 'lead', name: 'Lead', color: 'gray' },
      { id: 'won', name: 'Won', color: 'green' },
    ])
    const mixed = planAdoption(clash, [both], { canAdd: true, room: 10, newId })
    expect(mixed.addOptions.get('theirs')!.map((o) => o.name)).toEqual(['Won'])
    expect(carryCustom({ 'f-stage': ['lead'] }, mixed.map)).toEqual({ theirs: ['won'] })
    // A field nobody could name by hand isn't made by arriving.
    expect(planAdoption([], [{ id: 'f-p', name: 'Priority', type: 'text' }], { canAdd: true, room: 10, newId }).lose).toEqual(['Priority'])
  })
})

describe('carrying a saved filter to other fields', () => {
  const base: PresetSettings = {
    display: { board: DEFAULT_DISPLAY.board },
    outline: { sort: { key: 'f:old', dir: 'asc' }, hidden: ['due', 'f:old', 'f:kept', 'f:other'], density: 'compact' },
    filter: {
      statuses: ['todo'],
      fields: { old: { in: ['a', 'b', ''], has: true }, kept: { in: ['z'] }, other: { min: 3 } },
    },
  }
  const map: FieldMap = new Map([['old', { id: 'kept', options: new Map([['a', 'z2']]) }]])

  it('two fields becoming one: the filter that was on the one that stays wins, the rest follows', () => {
    const out = remapPreset(base, map, 'keep')
    expect(out.filter).toEqual({ statuses: ['todo'], fields: { kept: { in: ['z'] }, other: { min: 3 } } })
    expect(out.outline).toEqual({ sort: { key: 'f:kept', dir: 'asc' }, hidden: ['due', 'f:kept', 'f:other'], density: 'compact' })
    expect(out.display).toBe(base.display)
    // With no filter on the one that stays, the other's is carried, options and all.
    const alone = remapPreset({ ...base, filter: { fields: { old: { in: ['a', 'b', ''], has: true } } } }, map, 'keep')
    expect(alone.filter.fields).toEqual({ kept: { in: ['z2', ''], has: true } })
  })

  it('a starter: what isn’t carried is dropped', () => {
    const out = remapPreset(base, map, 'drop')
    expect(out.filter.fields).toEqual({ kept: { in: ['z2', ''], has: true } })
    expect(out.outline).toEqual({ sort: { key: 'f:kept', dir: 'asc' }, hidden: ['due', 'f:kept'], density: 'compact' })
    expect(remapPreset(base, new Map(), 'drop')).toEqual({
      display: base.display,
      filter: { statuses: ['todo'] },
      outline: { hidden: ['due'], density: 'compact' },
    })
    expect(PresetSettingsSchema.safeParse(remapPreset(base, new Map(), 'drop')).success).toBe(true)
  })
})
