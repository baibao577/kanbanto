import { CaretLeft, CaretRight, Timer, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TimeMine } from '@kanbanto/model/api'
import { fromDay, isWeekend, mondayOf, todayDay } from '@kanbanto/model/dates'
import { ancestorsOf } from '@kanbanto/model/indexer'
import { formatDuration, LONG_DAY, parseLog, QUICK } from '@kanbanto/model/time'
import { api } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { hrefFor } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { Kbd } from '@/components/common/bits'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { dayWords, logTime, zone } from './logging'

const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const SHOWN = 8

/**
 * The log box: pick a card by typing its name (the cards you worked on that day first), then type the time and, if you
 * like, what it was ("1:30 review"); Enter logs it and the box stays open for the next card. The day switches with
 * the day buttons or [ and ], and stands out when it isn't today. Nothing is filled in for you: every time is typed.
 */
export default function LogBox({ initialTask, onClose }: { initialTask?: string; onClose: () => void }) {
  const { data, idx } = useBoard()
  const { user } = useAuth()
  const boardId = data.board.id
  const today = todayDay()
  const [day, setDay] = useState(today)
  const [task, setTask] = useState<string | null>(initialTask && idx.tasks[initialTask] ? initialTask : null)
  const [text, setText] = useState('')
  const [hi, setHi] = useState(0)
  const [mine, setMine] = useState<TimeMine | null>(null)
  // Cards logged on in this box, latest first: offered first again.
  const [logged, setLogged] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    api<TimeMine>('GET', `/boards/${boardId}/time/mine?day=${fromDay(day)}&timeZone=${encodeURIComponent(zone())}`).then(setMine, () => setMine(null))
  }, [boardId, day])
  useEffect(load, [load])

  const title = (id: string) => idx.tasks[id]?.title ?? ''
  const parentPath = (id: string) =>
    ancestorsOf(idx.tasks, id)
      .map((a) => idx.tasks[a].title)
      .join(' › ')

  // Suggestions: what you just logged, what you touched that day, what's yours, what you logged on lately.
  const why = useMemo(() => {
    const m = new Map<string, { rank: number; hint: string }>()
    const add = (ids: readonly string[], base: number, hint: string) =>
      ids.forEach((id, i) => {
        if (id in idx.tasks && !m.has(id)) m.set(id, { rank: base + i, hint })
      })
    add(logged, 0, 'just logged')
    add(mine?.touched ?? [], 100, `worked on ${day === today ? 'today' : dayWords(day).split(' ')[0]}`)
    add(
      Object.keys(idx.tasks).filter((id) => idx.tasks[id].assigneeId === user?.id && idx.category.get(id) !== 'done'),
      1000,
      'yours',
    )
    add(mine?.recent ?? [], 2000, 'logged lately')
    return m
  }, [idx, mine, logged, user?.id, day, today])
  const words = task ? [] : text.toLowerCase().split(/\s+/).filter(Boolean)
  const list = useMemo(() => {
    const rankOf = (id: string) => why.get(id)?.rank ?? 5000
    const ids = words.length
      ? Object.keys(idx.tasks).filter((id) => {
          const hay = `${parentPath(id)} ${title(id)}`.toLowerCase()
          return words.every((w) => hay.includes(w))
        })
      : [...why.keys()]
    return ids.sort((a, b) => rankOf(a) - rankOf(b) || title(a).localeCompare(title(b))).slice(0, SHOWN)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [why, words.join(' '), idx])
  const pickAt = Math.min(hi, Math.max(0, list.length - 1))

  const pick = (id: string) => {
    setTask(id)
    setText('')
    setHi(0)
    input.current?.focus()
  }
  const parsed = task && text.trim() ? parseLog(text) : null
  const hoursPerDay = mine?.hoursPerDay ?? 8
  const dayLogged = mine?.logged ?? 0
  // A working day has your hours a day to fill; a weekend day doesn't.
  const workday = !isWeekend(day)
  const rest = workday ? hoursPerDay * 60 - dayLogged : 0
  const notToday = day !== today

  const save = (minutes: number, note: string) => {
    if (!task) return
    const id = task
    setTask(null)
    setText('')
    setLogged((l) => [id, ...l.filter((x) => x !== id)])
    input.current?.focus()
    void logTime(boardId, id, title(id), { minutes, day: fromDay(day), note }, load).then((entry) => {
      // Refused: back to that card, so nothing's lost.
      if (!entry) setTask(id)
    })
  }
  // A chip: its time, and whatever's typed as the note.
  const chip = (minutes: number) => save(minutes, parsed?.ok ? parsed.note : text.trim())

  const step = (by: number) => setDay((d) => Math.min(today, d + by))
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      return step(e.key === '[' ? -1 : 1)
    }
    if (!task) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setHi(Math.max(0, Math.min(list.length - 1, pickAt + (e.key === 'ArrowDown' ? 1 : -1))))
      } else if ((e.key === 'Enter' || (e.key === 'Tab' && text)) && list[pickAt]) {
        e.preventDefault()
        pick(list[pickAt])
      }
      return
    }
    if (e.key === 'Backspace' && !text) {
      e.preventDefault()
      setTask(null)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (parsed?.ok) save(parsed.minutes, parsed.note)
    }
  }

  const monday = mondayOf(day)
  const week = Array.from({ length: 7 }, (_, i) => monday + i).filter((d, i) => i < 5 || d === day)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:rounded-b-none"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          input.current?.focus()
        }}
      >
        <DialogTitle className="sr-only">Log time</DialogTitle>
        <DialogDescription className="sr-only">Pick a card, then type the time you spent on it.</DialogDescription>

        {/* The day: buttons for the week, [ and ] to step. Not today: it stands out. */}
        <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
          <button
            type="button"
            className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent"
            aria-label="Week before"
            onClick={() => setDay(day - 7)}
          >
            <CaretLeft className="size-3.5" />
          </button>
          {week.map((d) => (
            <button
              key={d}
              type="button"
              disabled={d > today}
              onClick={() => {
                setDay(d)
                input.current?.focus()
              }}
              aria-pressed={d === day}
              title={dayWords(d)}
              className={cn(
                'flex h-7 min-w-9 items-center justify-center gap-1 rounded px-1.5 text-xs tabular-nums disabled:opacity-35',
                d === day
                  ? notToday
                    ? 'bg-(--c-amber)/20 font-semibold text-[color-mix(in_oklab,var(--c-amber)_70%,var(--foreground))]'
                    : 'bg-primary/12 font-semibold text-primary'
                  : 'text-muted-foreground hover:bg-accent',
                d === today && d !== day && 'underline underline-offset-4',
              )}
            >
              {LETTERS[new Date(d * 86_400_000).getUTCDay()]}
              <span className="text-[11px] opacity-70">{new Date(d * 86_400_000).getUTCDate()}</span>
            </button>
          ))}
          <button
            type="button"
            className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent disabled:opacity-35"
            aria-label="Week after"
            disabled={monday + 7 > today}
            onClick={() => step(7)}
          >
            <CaretRight className="size-3.5" />
          </button>
          <span className={cn('ml-auto text-xs tabular-nums', notToday ? 'font-medium' : 'text-muted-foreground')}>
            {dayWords(day)}: {dayLogged ? `${formatDuration(dayLogged)}${workday ? ` of ${hoursPerDay}h` : ''} logged` : 'nothing logged yet'}
          </span>
        </div>

        {/* The one input: a card (as a pill once picked), then the time and a note. */}
        <div className="flex items-center gap-2 px-3 py-2.5 max-sm:order-2">
          <Timer className="size-4 shrink-0 text-muted-foreground" />
          {task && (
            <span className="inline-flex max-w-[55%] shrink-0 items-center gap-1 rounded-md bg-primary/10 py-0.5 pr-0.5 pl-2 text-sm font-medium text-primary">
              <span className="truncate" title={title(task)}>
                {title(task)}
              </span>
              <button
                type="button"
                aria-label="Pick another card"
                className="grid size-5 place-items-center rounded hover:bg-primary/15"
                onClick={() => {
                  setTask(null)
                  input.current?.focus()
                }}
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          <input
            ref={input}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setHi(0)
            }}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded={!task}
            aria-controls="log-cards"
            aria-label={task ? 'Time and note' : 'Card'}
            placeholder={task ? 'Time, and what it was: 1h 30m review' : 'Which card? Type its name'}
            className="h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {task ? (
          <div className="space-y-2 border-t px-3 py-2.5 max-sm:order-3">
            <p className={cn('min-h-5 text-sm', parsed && !parsed.ok && 'text-destructive')} role="status">
              {parsed?.ok ? (
                <>
                  Logs <b>{formatDuration(parsed.minutes)}</b> on {title(task)} ·{' '}
                  <b className={cn(notToday && 'text-[color-mix(in_oklab,var(--c-amber)_70%,var(--foreground))]')}>{dayWords(day)}</b>
                  {parsed.note && <> · ‘{parsed.note}’</>}
                  {(parsed.warning || dayLogged + parsed.minutes > LONG_DAY) && (
                    <span className="block text-xs text-[color-mix(in_oklab,var(--c-amber)_70%,var(--foreground))]">
                      {parsed.warning ?? `That makes ${formatDuration(dayLogged + parsed.minutes)} on ${dayWords(day)}.`}
                    </span>
                  )}
                </>
              ) : parsed ? (
                parsed.error
              ) : (
                <span className="text-muted-foreground">Type the time (1:30, 45m, 2) and press Enter, or pick one:</span>
              )}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => chip(m)}
                  className="h-8 rounded-md border px-3 text-sm tabular-nums hover:bg-accent max-sm:h-10 max-sm:px-4"
                >
                  {formatDuration(m)}
                </button>
              ))}
              {rest > 0 && (
                <button
                  type="button"
                  onClick={() => chip(rest)}
                  className="h-8 rounded-md border border-dashed px-3 text-sm tabular-nums hover:bg-accent max-sm:h-10"
                  title={`What's left of your ${hoursPerDay}-hour day`}
                >
                  Rest · {formatDuration(rest)}
                </button>
              )}
            </div>
          </div>
        ) : (
          <ul
            id="log-cards"
            role="listbox"
            aria-label="Cards"
            className="max-h-80 overflow-y-auto border-t py-1 max-sm:order-1 max-sm:border-t-0 max-sm:border-b"
          >
            {list.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted-foreground">{words.length ? 'No card by that name here.' : 'Type a card’s name.'}</li>
            )}
            {list.map((id, i) => {
              const path = parentPath(id)
              const hint = why.get(id)?.hint
              return (
                <li
                  key={id}
                  role="option"
                  aria-selected={i === pickAt}
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(id)}
                  className={cn('flex cursor-pointer items-center gap-2 px-4 py-1.5 text-sm', i === pickAt && 'bg-accent')}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {path && <span className="text-muted-foreground">{path} › </span>}
                    {title(id)}
                  </span>
                  {idx.category.get(id) === 'done' && <span className="shrink-0 text-xs text-muted-foreground">done</span>}
                  {hint && <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>}
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex items-center gap-3 border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground max-sm:order-4">
          <span className="flex items-center gap-1 max-sm:hidden">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> pick <Kbd>Enter</Kbd> log <Kbd>[</Kbd>
            <Kbd>]</Kbd> day <Kbd>Esc</Kbd> close
          </span>
          <a href={hrefFor({ page: 'time' })} className="ml-auto font-medium text-foreground hover:underline" onClick={onClose}>
            Open my week
          </a>
        </div>
      </DialogContent>
    </Dialog>
  )
}
