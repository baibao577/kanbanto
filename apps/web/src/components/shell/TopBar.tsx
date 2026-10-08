import { CaretDown, CloudSlash, Eye, MagnifyingGlass, PencilSimple, Plus, SquaresFour, Star, UsersThree, X } from '@phosphor-icons/react'
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
import { favoritesOf, useBoards } from '@/data/useBoards'
import type { BoardSummary } from '@kanbanto/model/api'
import { BoardDot, Kbd } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Connection } from '@/data/sync'
import { AccountMenu } from './AccountMenu'
import { NotificationBell } from './NotificationBell'
import { InboxButton } from '@/components/inbox/InboxButton'
import { MoreMenu, type MoreMenuProps } from './MoreMenu'
import { LogoMark, LogoTile } from '@/components/common/Logo'
import { backgroundOf } from '@kanbanto/model/colors'
import { VIEW_TABS } from '@/components/views'
import { TemplateMenu } from '@/components/templates/TemplateMenu'

/** An icon in the bar that says what it is when pointed at (the bell and the Inbox tray look the same). */
const ICON_BUTTON = 'grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'

interface Props extends MoreMenuProps {
  search: string
  onSearch: (q: string) => void
  onNewTask: () => void
  connection: Connection
  unsaved: number
}

export function TopBar({ search, onSearch, onNewTask, connection, unsaved, ...menu }: Props) {
  const { data, prefs, setPrefs, run, readOnly, access, openShare, templates, addFromTemplate } = useBoard()
  const { user } = useAuth()
  const tile = backgroundOf(data.board.background)
  // Visitors of a public board aren't on it, so there's nothing for them to share or see. Your Inbox is yours alone.
  const canShare = !!user && access.via !== 'public' && !access.inbox

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:gap-3 sm:px-4">
      {/* (On a phone the name has no room: it's cut off here rather than left to run under the tabs.) */}
      <div className="flex min-w-0 items-center gap-2 max-sm:overflow-hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={hrefFor({ page: 'home' })}
              aria-label="All boards"
              className="grid size-8 shrink-0 place-items-center rounded-md text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {tile ? <LogoTile background={tile} className="sm:size-6" title="All boards" /> : <LogoMark className="size-7" title="All boards" />}
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
        {/* This board's tools are quiet icons, named when pointed at: the one button with a word is the one used most. */}
        <div className="flex items-center gap-0.5">
          <SearchBox value={search} onChange={onSearch} />
          {/* (On a phone there's no room for it: there it's the first thing under More.) */}
          {canShare && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button aria-label="Share" onClick={openShare} className={cn(ICON_BUTTON, 'max-sm:hidden')}>
                  <UsersThree className="size-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Share: {data.members.length < 2 ? 'only you so far' : `${data.members.length} people`}</TooltipContent>
            </Tooltip>
          )}
          <MoreMenu {...menu} canShare={canShare} />
        </div>
        {!readOnly && (
          <span className="flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" onClick={onNewTask} className={cn('gap-1.5', templates.length > 0 && 'rounded-r-none')}>
                  <Plus weight="bold" />
                  <span className="hidden sm:inline">New task</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                New task <Kbd>N</Kbd>
              </TooltipContent>
            </Tooltip>
            {/* On a board with card templates: the arrow starts the new task from one, and opens it. */}
            <TemplateMenu templates={templates} align="end" onPick={(t) => addFromTemplate(t, undefined, { open: true })} />
          </span>
        )}
        {user ? (
          <>
            {/* What's yours, the same on every page, apart from what's this board's. */}
            <span aria-hidden className="h-5 w-px bg-border max-sm:hidden" />
            <div className="flex items-center gap-0.5">
              <InboxButton />
              <NotificationBell />
            </div>
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
  const { boards, setFavorite } = useBoards()
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const favorites = favoritesOf(boards).filter((b) => b.id !== currentId)
  const current = boards?.find((b) => b.id === currentId)
  // Most recently changed first (the server's order), after the favourites.
  const recent = (boards ?? []).filter((b) => b.id !== currentId && !b.archivedAt && !b.favoritedAt && !b.inbox).slice(0, 8)
  const item = (b: BoardSummary) => (
    <DropdownMenuItem key={b.id} onSelect={() => navigate({ page: 'board', id: b.id })}>
      <BoardDot background={b.background} />
      <span className="truncate">{b.name}</span>
    </DropdownMenuItem>
  )

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
          {favorites.length > 0 && (
            <>
              <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                <Star weight="fill" className="size-3 text-amber-500" /> Favourites
              </DropdownMenuLabel>
              {favorites.map(item)}
              <DropdownMenuSeparator />
            </>
          )}
          {recent.length > 0 && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{favorites.length ? 'Recent' : 'Switch to'}</DropdownMenuLabel>
              {recent.map(item)}
              <DropdownMenuSeparator />
            </>
          )}
          {current && (
            <DropdownMenuItem onSelect={() => void setFavorite(current.id, !current.favoritedAt)}>
              <Star weight={current.favoritedAt ? 'fill' : 'regular'} className={current.favoritedAt ? 'text-amber-500' : undefined} />
              {current.favoritedAt ? 'Remove from favourites' : 'Add to favourites'}
            </DropdownMenuItem>
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

function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [tip, setTip] = useState(false)
  // An icon until it's used: it opens into the box when clicked (or with "/"), and stays open while it holds words.
  const open = focused || !!value

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
    <Tooltip open={tip && !open} onOpenChange={setTip}>
      <TooltipTrigger asChild>
        <div className="group relative hidden sm:block">
          <MagnifyingGlass
            className={cn(
              'pointer-events-none absolute top-1/2 left-1.5 size-5 -translate-y-1/2 text-muted-foreground',
              !open && 'group-hover:text-foreground',
            )}
          />
          <input
            ref={input}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onChange('')
                e.currentTarget.blur()
              }
            }}
            placeholder={open ? 'Search tasks' : undefined}
            aria-label="Search tasks"
            className={cn(
              'h-8 rounded-md border border-transparent pl-8 text-sm transition-[width,background-color] outline-none placeholder:text-muted-foreground',
              open
                ? 'w-56 bg-muted pr-8 focus:border-input focus:bg-background focus-visible:ring-2 focus-visible:ring-ring/30'
                : 'w-8 cursor-pointer bg-transparent hover:bg-accent',
            )}
          />
          {value && (
            <button
              onClick={() => onChange('')}
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Search tasks <Kbd>/</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
