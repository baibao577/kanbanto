import { CaretDown, CloudSlash, Eye, MagnifyingGlass, PencilSimple, Plus, SquaresFour, UsersThree, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { useBoard } from '@/app/board-context'
import { hrefFor, navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { CreateBoardDialog } from '@/components/home/CreateBoardDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useBoards } from '@/data/useBoards'
import { BOARD_BACKGROUNDS, type ColorName } from '@kanbanto/model/colors'
import { Kbd } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Connection } from '@/data/sync'
import { AccountMenu } from './AccountMenu'
import { NotificationBell } from './NotificationBell'
import { MoreMenu, type MoreMenuProps } from './MoreMenu'
import { LogoMark } from '@/components/common/Logo'
import { VIEW_TABS } from '@/components/views'

interface Props extends MoreMenuProps {
  search: string
  onSearch: (q: string) => void
  onNewTask: () => void
  connection: Connection
  unsaved: number
}

export function TopBar({ search, onSearch, onNewTask, connection, unsaved, ...menu }: Props) {
  const { data, prefs, setPrefs, run, readOnly, access, openShare } = useBoard()
  const { user } = useAuth()

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={hrefFor({ page: 'home' })}
              aria-label="All boards"
              className="grid size-8 shrink-0 place-items-center rounded-md text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <LogoMark className="size-7" title="All boards" />
            </a>
          </TooltipTrigger>
          <TooltipContent>All boards</TooltipContent>
        </Tooltip>
        {user ? (
          <BoardSwitcher
            name={data.board.name}
            currentId={data.board.id}
            onRename={readOnly ? undefined : (name) => run({ type: 'board.update', fields: { name } })}
          />
        ) : (
          <span className="truncate px-2 text-sm font-semibold">{data.board.name}</span>
        )}
        {readOnly && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs font-medium text-muted-foreground">
                <Eye className="size-3.5" /> View only
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {access.via === 'public'
                ? 'This board is public. Ask its owner to invite you to make changes.'
                : 'Ask an owner if you need to make changes.'}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <nav role="tablist" aria-label="Views" className="ml-1 flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
        {VIEW_TABS.map(({ id, label, icon: Icon, hint }) => {
          const on = prefs.layout === id
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  role="tab"
                  aria-selected={on}
                  onClick={() => setPrefs({ type: 'setLayout', layout: id })}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground',
                    on && 'bg-background text-foreground shadow-xs',
                  )}
                >
                  <Icon weight={on ? 'fill' : 'regular'} className="size-4" />
                  <span className="hidden md:inline">{label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <span className="md:hidden">{label} · </span>
                {hint}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <SaveState connection={connection} unsaved={unsaved} />
        <SearchBox value={search} onChange={onSearch} />
        {!readOnly && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" onClick={onNewTask} className="gap-1.5">
                <Plus weight="bold" />
                <span className="hidden sm:inline">New task</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              New task <Kbd>N</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
        {/* Visitors of a public board aren't on it, so there's nothing for them to share or see. */}
        {user && access.via === 'member' && (
          <Button size="sm" variant="outline" onClick={openShare} className="gap-1.5">
            <UsersThree />
            <span className="hidden sm:inline">Share</span>
          </Button>
        )}
        <MoreMenu {...menu} />
        {user ? (
          <>
            <NotificationBell />
            <AccountMenu />
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => navigate({ page: 'signin', next: location.hash })}>
            Sign in
          </Button>
        )}
      </div>
    </header>
  )
}

/** The board's name; opens a menu to switch boards, rename this one, go to all boards or create one. */
function BoardSwitcher({ name, currentId, onRename }: { name: string; currentId: string; onRename?: (name: string) => void }) {
  const { boards } = useBoards()
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  // Most recently changed first (the server's order).
  const recent = (boards ?? []).filter((b) => b.id !== currentId).slice(0, 8)

  if (editing)
    return (
      <input
        autoFocus
        defaultValue={name}
        aria-label="Board name"
        onFocus={(e) => e.target.select()}
        onBlur={(e) => {
          setEditing(false)
          if (e.target.value.trim() && e.target.value.trim() !== name) onRename?.(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="h-8 w-44 rounded-md border border-input bg-background px-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
    )
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex h-8 max-w-56 items-center gap-1 rounded-md px-2 text-sm font-semibold hover:bg-accent data-[state=open]:bg-accent">
            <span className="truncate">{name}</span>
            <CaretDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {recent.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Switch to</DropdownMenuLabel>
              {recent.map((b) => (
                <DropdownMenuItem key={b.id} onSelect={() => navigate({ page: 'board', id: b.id })}>
                  <BoardDot background={(b.background as ColorName | null) ?? undefined} />
                  <span className="truncate">{b.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          {onRename && (
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <PencilSimple /> Rename this board
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <Plus /> Create board…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate({ page: 'home' })}>
            <SquaresFour /> All boards
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateBoardDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

/** Only shows when something needs attention: changes still on their way, or no connection. */
function SaveState({ connection, unsaved }: { connection: Connection; unsaved: number }) {
  if (connection !== 'offline') return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          className="flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
        >
          <CloudSlash className="size-3.5" />
          <span className="hidden lg:inline">{unsaved ? `Offline · ${unsaved} unsaved` : 'Offline'}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {unsaved
          ? 'Can’t reach the server. Your changes are kept here and will be saved when the connection is back — keep this tab open.'
          : 'Can’t reach the server. Reconnecting…'}
      </TooltipContent>
    </Tooltip>
  )
}

/** A small swatch of a board's background (or the plain canvas). */
function BoardDot({ background }: { background?: ColorName }) {
  const bg = background ? BOARD_BACKGROUNDS[background] : null
  return (
    <span
      className="size-4 shrink-0 rounded border"
      style={bg ? { background: `linear-gradient(135deg, ${bg.from}, ${bg.to})`, borderColor: 'transparent' } : undefined}
    />
  )
}

function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const input = useRef<HTMLInputElement>(null)

  // "/" jumps to search from anywhere that isn't a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key !== '/' || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      e.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="relative hidden sm:block">
      <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('')
            e.currentTarget.blur()
          }
        }}
        placeholder="Search tasks"
        aria-label="Search tasks"
        className="h-8 w-40 rounded-md border border-transparent bg-muted pr-8 pl-8 text-sm transition-[width,background-color] outline-none placeholder:text-muted-foreground focus:w-60 focus:border-input focus:bg-background focus-visible:ring-2 focus-visible:ring-ring/30 lg:w-52"
      />
      {value ? (
        <button
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <span className="absolute top-1/2 right-1.5 -translate-y-1/2">
          <Kbd>/</Kbd>
        </span>
      )}
    </div>
  )
}
