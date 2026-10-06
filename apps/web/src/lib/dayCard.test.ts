import { describe, expect, it } from 'vitest'
import { toDay } from '@kanbanto/model/dates'
import { cardOnDay } from './dayCard'

const DAY = toDay('2026-10-08')
/** The moment a time is on that day, on this computer's clock, as a card's date keeps it. */
const at = (time: string) => new Date(`2026-10-08T${time}:00`).toISOString().replace('.000Z', 'Z')

describe('a card added on a day of the calendar', () => {
  it('takes a time of day from its title, and leaves the rest as the title', () => {
    expect(cardOnDay('Call Sam 3pm', DAY)).toEqual({ title: 'Call Sam', due: at('15:00') })
    expect(cardOnDay('  Delivery at 14:30 ', DAY)).toEqual({ title: 'Delivery', due: at('14:30') })
    expect(cardOnDay('9am Mai haircut', DAY)).toEqual({ title: 'Mai haircut', due: at('09:00') })
  })

  it('is on that whole day when no time is written', () => {
    expect(cardOnDay('Buy flowers', DAY)).toEqual({ title: 'Buy flowers', due: '2026-10-08' })
  })

  it('doesn’t move to another day because of words in its title', () => {
    // (Read anywhere else, these would be dates. Here the day is where the card was added.)
    expect(cardOnDay('Trip in May', DAY)).toEqual({ title: 'Trip in May', due: '2026-10-08' })
    expect(cardOnDay('Plan for tomorrow 3pm', DAY)).toEqual({ title: 'Plan for tomorrow 3pm', due: '2026-10-08' })
    expect(cardOnDay('Friday review', DAY)).toEqual({ title: 'Friday review', due: '2026-10-08' })
  })

  it('a title that is only a time stays a title', () => {
    expect(cardOnDay('3pm', DAY)).toEqual({ title: '3pm', due: '2026-10-08' })
  })
})
