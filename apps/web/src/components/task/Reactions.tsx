import { Plus, Smiley } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { isReaction, reactedBy, REACTION_NAMES, REACTIONS, type ReactionView } from '@kanbanto/model/reactions'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** What an emoji means, where the set gives it a name ("Agreed"). */
const nameOf = (emoji: string) => (isReaction(emoji) ? REACTION_NAMES[emoji] : '')

/**
 * The button that offers the emoji to answer a comment with: a small smiley with a plus, opening the six to choose
 * from. The ones this person already used are marked; choosing one of those takes it back.
 */
export function AddReaction({
  mine,
  onPick,
  className,
}: {
  mine: readonly string[]
  onPick: (emoji: string, on: boolean) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="React to this comment"
          title="React"
          className={cn(
            'inline-flex h-6 items-center gap-0.5 rounded-full border border-dashed px-1.5 text-muted-foreground hover:border-solid hover:bg-accent hover:text-foreground data-[state=open]:border-solid data-[state=open]:bg-accent data-[state=open]:text-foreground',
            className,
          )}
        >
          <Smiley className="size-3.5" />
          <Plus className="size-2.5" weight="bold" />
        </button>
      </PopoverTrigger>
      {/* (Under the row, so the comment being answered stays readable; it goes above when there is no room below.) */}
      <PopoverContent align="start" side="bottom" className="flex w-auto gap-0.5 rounded-full p-1" aria-label="Reactions">
        {REACTIONS.map((emoji) => {
          const on = mine.includes(emoji)
          return (
            <button
              key={emoji}
              type="button"
              aria-label={REACTION_NAMES[emoji]}
              aria-pressed={on}
              title={REACTION_NAMES[emoji]}
              onClick={() => {
                setOpen(false)
                onPick(emoji, !on)
              }}
              className={cn('grid size-8 place-items-center rounded-full text-lg leading-none hover:bg-accent', on && 'bg-primary/10')}
            >
              {emoji}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The emoji a comment was answered with, as small counts under it: this person's own are tinted, and clicking one
 * adds theirs or takes it back. Pointing at one says who; so does a long press where there is no pointer. For
 * someone who can't react (a visitor with the public link) they are only shown.
 */
export function ReactionRow({
  reactions,
  me,
  onPick,
}: {
  reactions: readonly ReactionView[]
  /** Who is looking (to tint theirs and say "you"). */
  me?: string
  /** Adds this person's reaction or takes it back; left out: they can only look. */
  onPick?: (emoji: string, on: boolean) => void
}) {
  // A long press says who reacted, and isn't also a click.
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null)
  const release = () => {
    if (hold.current) clearTimeout(hold.current.timer)
  }
  if (!reactions.length) return null
  const mine = reactions.filter((r) => r.by.some((p) => p.id === me)).map((r) => r.emoji)
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1" role="group" aria-label="Reactions">
      {reactions.map((r) => {
        const on = mine.includes(r.emoji)
        const who = reactedBy(r.by, me)
        const said = [nameOf(r.emoji), who].filter(Boolean).join(': ')
        const chip = cn(
          'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums select-none',
          on ? 'border-primary/60 bg-primary/10 font-semibold text-primary' : 'bg-muted/60 text-muted-foreground',
        )
        const inside = (
          <>
            <span className="text-sm leading-none">{r.emoji}</span>
            {r.by.length}
          </>
        )
        if (!onPick)
          return (
            <span key={r.emoji} className={chip} title={said} aria-label={`${said} (${r.by.length})`}>
              {inside}
            </span>
          )
        return (
          <button
            key={r.emoji}
            type="button"
            aria-pressed={on}
            aria-label={`${said} (${r.by.length})`}
            title={said}
            className={cn(chip, 'hover:border-primary/60')}
            onPointerDown={(e) => {
              if (e.pointerType === 'mouse') return
              const state = { fired: false, timer: setTimeout(() => ((state.fired = true), toast(`${r.emoji} ${who}`)), 450) }
              hold.current = state
            }}
            onPointerUp={release}
            onPointerLeave={release}
            onPointerCancel={release}
            onContextMenu={(e) => hold.current && e.preventDefault()}
            onClick={() => {
              const held = hold.current?.fired
              hold.current = null
              if (!held) onPick(r.emoji, !on)
            }}
          >
            {inside}
          </button>
        )
      })}
      {onPick && <AddReaction mine={mine} onPick={onPick} />}
    </div>
  )
}
