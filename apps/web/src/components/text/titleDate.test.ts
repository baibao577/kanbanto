// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/app/use-auth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }))
const { useTitleDate } = await import('./useTitleDate')

/** Runs the hook for a title, optionally with the reminder toggled on, and applies it. */
function applyTo(value: string, remind = false) {
  const box: { state?: ReturnType<typeof useTitleDate> } = {}
  const report = (s: ReturnType<typeof useTitleDate>) => (box.state = s)
  const Probe = () => {
    const s = useTitleDate(value)
    useLayoutEffect(() => {
      report(s)
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(createElement(Probe)))
  if (remind) act(() => box.state!.setRemind(true))
  const out = box.state!.apply(value)
  act(() => root.unmount())
  return out
}

describe('a time in a new card’s title', () => {
  it('comes out of the title as the due date (a moment with a time, a whole day without)', () => {
    const timed = applyTo('buy cat on next monday 1pm')
    expect(timed.title).toBe('buy cat')
    expect(timed.fields.due).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/)
    const day = applyTo('call the bank tomorrow')
    expect(day.title).toBe('call the bank')
    expect(day.fields.due).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('adds a reminder when asked; leaves titles without a time (or only a time) alone', () => {
    expect(applyTo('buy cat tmr10:00', true).fields.reminders).toEqual([expect.objectContaining({ at: expect.any(String), by: 'me' })])
    expect(applyTo('write the report')).toEqual({ title: 'write the report', fields: {} })
    expect(applyTo('tomorrow')).toEqual({ title: 'tomorrow', fields: {} })
  })
})
