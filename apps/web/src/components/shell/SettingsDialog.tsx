import {
  Archive,
  Desktop,
  Gauge,
  type Icon,
  Info,
  Moon,
  PaintBrush,
  Sun,
  Tag,
  TelegramLogo,
  Trash,
  User,
  UsersThree,
  WebhooksLogo,
} from '@phosphor-icons/react'
import { toast } from 'sonner'
import { useState, type ReactNode } from 'react'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { navigate } from '@/app/router'
import { useTheme } from '@/app/use-theme'
import { TelegramBots, WebhookDetail, WebhookList } from '@/components/board/Webhooks'
import { BoardFields } from '@/components/fields/BoardFields'
import { Avatar, BackgroundSwatches } from '@/components/common/bits'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { RulesList } from '@/components/rules/RulesList'
import { cn } from '@/lib/utils'
import { formatDuration } from '@kanbanto/model/time'
import { backgroundOf, gradientCss } from '@kanbanto/model/colors'
import type { StatusMode } from '@kanbanto/model/types'

type Tab = 'general' | 'fields' | 'rules' | 'look' | 'people' | 'you' | 'delete'

/**
 * Board settings, in sections: the board itself (for everyone on it), its own fields, how it looks, who's on it and what's connected,
 * your own settings (only you), and deleting it (owners). A sidebar on wide screens, tabs on narrow ones.
 */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { access } = useBoard()
  const [tab, setTab] = useState<Tab>('general')
  const owner = access.role === 'owner'
  const tabs: { id: Tab; label: string; icon: Icon; danger?: boolean }[] = [
    { id: 'general', label: 'General', icon: Info },
    { id: 'fields', label: 'Fields', icon: Tag },
    { id: 'rules', label: 'Rules', icon: Gauge },
    { id: 'look', label: 'Background', icon: PaintBrush },
    { id: 'people', label: 'People & apps', icon: UsersThree },
    { id: 'you', label: 'Just for you', icon: User },
    // (Your Inbox stays: it can't be archived or deleted.)
    ...(owner && !access.inbox ? [{ id: 'delete' as const, label: 'Archive or delete', icon: Trash, danger: true }] : []),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(38rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl md:flex-row">
        <nav aria-label="Settings sections" className="shrink-0 border-b bg-muted/40 md:w-52 md:border-r md:border-b-0">
          <div className="px-5 pt-4 pr-12 pb-1 md:pt-5 md:pr-5 md:pb-3">
            <DialogTitle className="text-base">Board settings</DialogTitle>
            <DialogDescription className="mt-0.5 text-xs">Saved as you go.</DialogDescription>
          </div>
          <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col md:px-3 md:pt-0">
            {tabs.map(({ id, label, icon: I, danger }) => {
              const on = id === tab
              return (
                <li key={id} className={cn(danger && 'md:mt-2 md:border-t md:pt-2')}>
                  <button
                    type="button"
                    aria-current={on ? 'page' : undefined}
                    onClick={() => setTab(id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground',
                      on && 'bg-background font-medium text-foreground shadow-xs',
                      danger && 'text-destructive/80 hover:text-destructive',
                      danger && on && 'text-destructive',
                    )}
                  >
                    <I weight={on ? 'fill' : 'regular'} className="size-4" />
                    {label}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          {tab === 'general' && <General />}
          {tab === 'fields' && <BoardFields onLeave={() => onOpenChange(false)} />}
          {tab === 'rules' && <Rules />}
          {tab === 'look' && <Look />}
          {tab === 'people' && <People onClose={() => onOpenChange(false)} />}
          {tab === 'you' && <JustForYou />}
          {tab === 'delete' && owner && <DeleteBoard onDeleted={() => onOpenChange(false)} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** What the board says about its cards, the same to everyone on it (see model rules.ts): limits, and rules that tell people. */
function Rules() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Rules</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What this board says about its cards, and who it tells. Everyone on it sees the same; its owners change them.
        </p>
      </div>
      <RulesList />
    </div>
  )
}

function General() {
  const { data, run, access } = useBoard()
  return (
    <Section title="General" hint="What everyone on the board sees.">
      <Card>
        <Row label="Name" htmlFor="board-name">
          <Input
            id="board-name"
            key={data.board.name}
            defaultValue={data.board.name}
            onBlur={(e) => {
              const name = e.target.value.trim()
              if (name && name !== data.board.name) run({ type: 'board.update', fields: { name } })
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </Row>
        <Row
          label="What’s this board for?"
          htmlFor="board-about"
          hint="Shown on your boards page. Assistants like Claude read it to pick the right board."
        >
          <Textarea
            id="board-about"
            key={data.board.description ?? ''}
            defaultValue={data.board.description ?? ''}
            maxLength={1000}
            rows={2}
            placeholder="E.g. Home and family errands, or The Acme website launch"
            className="min-h-0 resize-none"
            onBlur={(e) => {
              const description = e.target.value.trim()
              if (description !== (data.board.description ?? '')) run({ type: 'board.update', fields: { description } })
            }}
          />
        </Row>
        {data.board.code && (
          <Letters boardId={data.board.id} code={data.board.code} canChange={access.role === 'owner' && !access.inbox} inbox={!!access.inbox} />
        )}
      </Card>

      <Card title="When a task has subtasks, its status…">
        <RadioGroup
          value={data.board.mode}
          onValueChange={(v) => run({ type: 'board.update', fields: { mode: v as StatusMode } })}
          className="gap-2 p-3"
        >
          <Choice value="derived" title="Follows its subtasks" recommended>
            It’s Done when all its subtasks are done, and In progress as soon as one of them starts.
          </Choice>
          <Choice value="manual" title="Is set by you">
            It stays wherever you put it, whatever its subtasks are doing.
          </Choice>
        </RadioGroup>
      </Card>
    </Section>
  )
}

function Look() {
  const { data, run } = useBoard()
  const bg = backgroundOf(data.board.background)
  return (
    <Section title="Background" hint="Behind the Board tab, for everyone on it.">
      <div
        aria-hidden
        className={cn('flex h-24 items-end gap-2 rounded-xl border p-3', !bg && 'bg-lane')}
        style={bg ? { background: gradientCss(bg) } : undefined}
      >
        {[0.9, 0.7, 0.8].map((w, i) => (
          <div key={i} className="h-14 flex-1 rounded-md bg-card/90 p-1.5 shadow-xs">
            <div className="h-1.5 rounded-full bg-foreground/15" style={{ width: `${w * 100}%` }} />
            <div className="mt-1.5 h-4 rounded bg-background shadow-xs" />
          </div>
        ))}
      </div>
      <BackgroundSwatches value={data.board.background} onChange={(color) => run({ type: 'board.update', fields: { background: color ?? null } })} />
    </Section>
  )
}

function People({ onClose }: { onClose: () => void }) {
  const { data, access, openShare } = useBoard()
  // A webhook's own page, or a Telegram bot's (its settings and delivery log), inside this tab.
  const [hook, setHook] = useState<string | null>(null)
  if (hook) return <WebhookDetail id={hook} onBack={() => setHook(null)} />
  return (
    <Section
      title="People & apps"
      hint={
        access.inbox
          ? 'Your Inbox is yours alone. It can still tell other apps what changes.'
          : 'Who can work on this board, and what it tells other apps.'
      }
    >
      {!access.inbox && (
        <Card>
          <Row
            label="People"
            icon={UsersThree}
            hint={
              data.members.length === 1
                ? 'Only you so far. Invite people and choose what they can do in Share.'
                : `${data.members.length} people can work on this board.`
            }
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onClose()
                  openShare()
                }}
              >
                Share…
              </Button>
            }
          >
            <div className="flex -space-x-1.5">
              {data.members.slice(0, 8).map((m) => (
                <Avatar key={m.id} name={m.name} picture={m.picture} className="ring-2 ring-card" />
              ))}
            </div>
          </Row>
        </Card>
      )}
      {/* What the board tells other apps, for its owners: each box as the People one is, with its icon and what it's for. */}
      {access.role === 'owner' && (
        <Card>
          <Row
            label="Webhooks"
            icon={WebhooksLogo}
            hint="Send changes, comments and reminders to another app (n8n, Zapier…), or to a channel in Slack, Google Chat, Microsoft Teams or Discord."
          />
          <WebhookList onOpen={setHook} />
        </Card>
      )}
      {access.role === 'owner' && (
        <Card>
          <Row
            label="Telegram"
            icon={TelegramLogo}
            hint="A bot of this board’s own. Its chat gets the board’s news, and what is sent there can become cards."
          />
          <TelegramBots onOpen={setHook} />
        </Card>
      )}
    </Section>
  )
}

function JustForYou() {
  const { theme, setTheme } = useTheme()
  return (
    <Section title="Just for you" hint="Only you see these. Nobody else’s board changes.">
      <Card>
        <Row label="Appearance" icon={theme === 'dark' ? Moon : theme === 'light' ? Sun : Desktop} hint="Light, dark, or the same as your computer.">
          <ToggleGroup type="single" variant="outline" value={theme} onValueChange={(v) => v && setTheme(v)} className="w-full">
            <ToggleGroupItem value="light" className="flex-1 gap-1.5">
              <Sun /> Light
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" className="flex-1 gap-1.5">
              <Moon /> Dark
            </ToggleGroupItem>
            <ToggleGroupItem value="system" className="flex-1 gap-1.5">
              <Desktop /> System
            </ToggleGroupItem>
          </ToggleGroup>
        </Row>
      </Card>
    </Section>
  )
}

function DeleteBoard({ onDeleted }: { onDeleted: () => void }) {
  const { data, counts } = useBoard()
  // Time logged on its cards, archived ones too, goes with it (and out of Planning's actual man-days).
  const logged = Object.values(counts.time).reduce((s, m) => s + m, 0)
  return (
    <Section title="Archive or delete" hint="For the board’s owners.">
      <div className="space-y-3 rounded-xl border bg-card p-4">
        <p className="text-sm">
          <span className="font-medium">Archive</span> to put it away: it leaves your boards page (it’s under “Archived boards” at the bottom),
          becomes read-only for everyone, and keeps everything. You can restore it any time.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() =>
            api('POST', `/boards/${data.board.id}/archive`, { archived: true }).then(
              () => {
                onDeleted()
                toast(`Archived “${data.board.name}”`)
              },
              (e) => toast.error(errorMessage(e)),
            )
          }
        >
          <Archive /> Archive board
        </Button>
      </div>
      <div className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
        <p className="text-sm">
          Deletes “{data.board.name}” and its {Object.keys(data.tasks).length.toLocaleString()} tasks for everyone, with their comments and files.
          This can’t be undone.
        </p>
        <p className="text-xs text-muted-foreground">Want a copy first? ⋯ → Export board…</p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash /> Delete board…
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{data.board.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Its {Object.keys(data.tasks).length.toLocaleString()} tasks will be deleted too
                {logged > 0 && <>, with the {formatDuration(logged)} of time logged on them (it stops counting in Planning)</>}. This can’t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  api('DELETE', `/boards/${data.board.id}`).then(
                    () => {
                      onDeleted()
                      navigate({ page: 'home' }, { replace: true })
                      toast(`Deleted “${data.board.name}”`)
                    },
                    (e) => toast.error(errorMessage(e)),
                  )
                }}
              >
                Delete board
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Section>
  )
}

// ── Layout pieces ──────────────────────────────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </header>
      {children}
    </section>
  )
}

/** A group of settings in a bordered card, rows divided. */
function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {title && <p className="border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">{title}</p>}
      <div className="divide-y">{children}</div>
    </div>
  )
}

/**
 * The board's letters: what its cards' names start with (WEB in WEB-12). Its owners change them; the server says no
 * when another board in the same place has them, and that's shown here. Saved when the field is left, like the
 * others. (No command carries this change: the board is read again once it's made, and shows the new letters.)
 */
function Letters({ boardId, code, canChange, inbox }: { boardId: string; code: string; canChange: boolean; inbox: boolean }) {
  const [busy, setBusy] = useState(false)
  // (Counted up to put the field back to the board's letters when a change is refused.)
  const [round, setRound] = useState(0)
  const save = async (typed: string) => {
    const next = typed.trim().toUpperCase()
    if (!next || next === code) return setRound((n) => n + 1)
    setBusy(true)
    try {
      await api('PUT', `/boards/${encodeURIComponent(boardId)}/code`, { code: next })
      toast(`This board’s cards are now ${next}-1, ${next}-2…`)
    } catch (e) {
      toast.error(errorMessage(e))
      setRound((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Row
      label="Letters for card numbers"
      htmlFor="board-letters"
      hint={
        inbox
          ? `Cards in your Inbox are ${code}-1, ${code}-2…`
          : canChange
            ? `This board’s cards are ${code}-1, ${code}-2… Change the letters and every card is renamed at once. A number written with the old letters still finds its card.`
            : `This board’s cards are ${code}-1, ${code}-2… Only the board’s owners can change the letters.`
      }
    >
      <Input
        id="board-letters"
        key={`${code}:${round}`}
        defaultValue={code}
        maxLength={5}
        disabled={!canChange || busy}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        aria-describedby="board-letters-rule"
        className="w-28 font-mono uppercase"
        onBlur={(e) => void save(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {canChange && (
        <p id="board-letters-rule" className="text-xs text-muted-foreground">
          2 to 5 letters or digits, starting with a letter.
        </p>
      )}
    </Row>
  )
}

/** One setting: its name (and icon), a hint, and the control — beside it (`action`) or below it (`children`). */
function Row({
  label,
  htmlFor,
  hint,
  icon: I,
  action,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  icon?: Icon
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="space-y-2.5 p-4">
      <div className="flex items-start gap-3">
        {I && (
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <I className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          <label htmlFor={htmlFor} className="block text-sm font-medium">
            {label}
          </label>
          {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  )
}

function Choice({ value, title, recommended, children }: { value: string; title: string; recommended?: boolean; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="space-y-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {recommended && <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Recommended</span>}
        </span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </label>
  )
}
