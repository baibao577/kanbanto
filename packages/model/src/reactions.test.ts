import { describe, expect, it } from 'vitest'
import { isReaction, reactedBy, REACTION_NAMES, REACTIONS } from './reactions'

const p = (name: string) => ({ id: name.toLowerCase(), name })

describe('reactions', () => {
  it('are a short set, each with a name', () => {
    expect(REACTIONS).toHaveLength(6)
    for (const emoji of REACTIONS) expect(REACTION_NAMES[emoji]).toBeTruthy()
    expect(isReaction('👍')).toBe(true)
    expect(isReaction('👎')).toBe(false)
    expect(isReaction('')).toBe(false)
  })

  it('say who added one, with the person looking as "you"', () => {
    expect(reactedBy([p('Dana Reyes')], 'dana reyes')).toBe('You')
    expect(reactedBy([p('Dana Reyes')])).toBe('Dana')
    expect(reactedBy([p('Dana'), p('Marco')], 'marco')).toBe('Dana and you')
    expect(reactedBy([p('Dana'), p('Priya'), p('Tom')])).toBe('Dana, Priya and Tom')
    expect(reactedBy([p('Dana'), p('Priya'), p('Tom'), p('Marco')], 'marco')).toBe('Dana, Priya, Tom and you')
    expect(reactedBy([p('Dana'), p('Priya'), p('Tom'), p('Ann')])).toBe('Dana, Priya, Tom and 1 other')
    expect(reactedBy([p('Dana'), p('Priya'), p('Tom'), p('Ann'), p('Ben'), p('Marco')], 'marco')).toBe('Dana, Priya, Tom and 3 others')
    expect(reactedBy([])).toBe('')
  })
})
