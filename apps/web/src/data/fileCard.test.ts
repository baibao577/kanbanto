import { describe, expect, it } from 'vitest'
import { lostInMove } from './fileCard'

const none = { title: 'Call the bank', subtasks: 0, unassigned: [], newLabels: [], droppedLinks: 0, droppedFields: [], leftBehind: [] }

describe('what a move left behind', () => {
  it('says nothing when everything came along', () => {
    expect(lostInMove(none)).toBeUndefined()
    expect(lostInMove({ ...none, linksRemoved: 0 })).toBeUndefined()
  })

  it('names the fields, links and people that stayed, and the labels that were added', () => {
    expect(lostInMove({ ...none, droppedFields: ['Stage'] })).toBe('Left behind: the field “Stage”.')
    expect(lostInMove({ ...none, droppedFields: ['Stage', 'Amount'], droppedLinks: 1 })).toBe(
      'Left behind: the fields “Stage” and “Amount” and a “waiting on” link.',
    )
    expect(lostInMove({ ...none, droppedLinks: 3, linksRemoved: 2, unassigned: ['Bob'] })).toBe(
      'Left behind: 3 “waiting on” links, links to it from 2 other cards and Bob as assignee.',
    )
    expect(lostInMove({ ...none, newLabels: ['home'] })).toBe('Added the label “home” there.')
    expect(lostInMove({ ...none, leftBehind: ['Ann'], newLabels: ['a', 'b'] })).toBe(
      'Left behind: Ann in its people fields. Added the labels “a” and “b” there.',
    )
  })
})
