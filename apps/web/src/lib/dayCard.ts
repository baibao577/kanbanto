import { localDay, moment } from '@/components/text/useTitleDate'
import { parseWhen } from '@/lib/when'
import { dayParts, fromDay, toDay } from '@kanbanto/model/dates'
import { stripWords } from '@kanbanto/model/when'

/**
 * A card added on a day of the calendar: its title and its due date. The day is known, so only a time of day
 * written in the title is read ("Call Sam 3pm": 15:00 that day, and the words leave the title). Anything else that
 * could be read as a date ("Trip in May", "tomorrow 3pm") stays in the title as typed: nobody is shown a guess to
 * say no to, and the day was chosen by where the card was added.
 */
export function cardOnDay(text: string, day: number): { title: string; due: string } {
  const typed = text.trim()
  const p = dayParts(day)
  const when = parseWhen(typed, new Date(p.year, p.month, p.date))
  const left = when?.timed && toDay(localDay(when.date)) === day ? stripWords(typed, when) : ''
  return left && when ? { title: left, due: moment(when.date) } : { title: typed, due: fromDay(day) }
}
