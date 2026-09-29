import {
  ArrowsLeftRight,
  Buildings,
  DotsThree,
  LockSimple,
  Key,
  PencilSimple,
  Plus,
  SignOut,
  Trash,
  UploadSimple,
  UsersThree,
} from '@phosphor-icons/react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { BoardSummary, WorkspaceSummary } from '@kanbanto/model/api'
import { BOARD_BACKGROUNDS, type ColorName } from '@kanbanto/model/colors'
import { newId } from '@kanbanto/model/ids'
import { parseBoard } from '@kanbanto/model/transfer'
import { api, errorMessage } from '@/api/client'
import { hrefFor, navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { visibilityOf } from '@/components/share/visibility'
import { AccountMenu } from '@/components/shell/AccountMenu'
import { NotificationBell } from '@/components/shell/NotificationBell'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBoards } from '@/data/useBoards'
import { useWorkspaces } from '@/data/useWorkspaces'
import { cn } from '@/lib/utils'
import { CreateBoardDialog } from './CreateBoardDialog'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { JoinCodeDialog } from './JoinCodeDialog'
import { LogoMark } from '@/components/common/Logo'

/**
 * Your boards, and creating, joining and importing boards. Once you're in a workspace, they're grouped by where they
 * are: Personal, each workspace, and boards other people shared with you.
 */
export function HomeView() {
  const { user } = useAuth()
  const { boards, error, reload } = useBoards()
  const { workspaces, reload: reloadWorkspaces } = useWorkspaces()
  // Creating a board, and where to suggest putting it (a workspace's id, or null for Personal).
  const [creating, setCreating] = useState<{ where: string | null } | null>(null)
  const [newWorkspace, setNewWorkspace] = useState(false)
  const [joining, setJoining] = useState(false)
  const [renaming, setRenaming] = useState<BoardSummary | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = 'Boards · Kanbanto'
  }, [])

  const importAsNew = async (f: File) => {
    try {
      // Read and check it here first, for a clear message; the server checks it again.
      const data = parseBoard(await f.text(), newId())
      const { id } = await api<{ id: string }>('POST', '/boards/import', { file: JSON.parse(await f.text()) })
      toast(`Imported “${data.board.name}”`)
      navigate({ page: 'board', id })
    } catch (e) {
      toast.error('Couldn’t import that file.', { description: errorMessage(e) })
    }
  }

  const askDelete = (b: BoardSummary) =>
    setConfirm({
      title: `Delete “${b.name}”?`,
      description: `The board and its ${b.taskCount.toLocaleString()} ${b.taskCount === 1 ? 'task' : 'tasks'} will be deleted for everyone. This can’t be undone — export it first if you want a copy.`,
      confirmLabel: 'Delete board',
      destructive: true,
      onConfirm: () =>
        api('DELETE', `/boards/${b.id}`).then(
          () => {
            toast(`Deleted “${b.name}”`)
            void reload()
          },
          (e) => toast.error(errorMessage(e)),
        ),
    })

  const askLeave = (b: BoardSummary) =>
    setConfirm({
      title: `Leave “${b.name}”?`,
      description: 'You won’t be able to open it again unless someone invites you back. Cards assigned to you will be unassigned.',
      confirmLabel: 'Leave board',
      destructive: true,
      onConfirm: () =>
        api('DELETE', `/boards/${b.id}/members/${user!.id}`).then(
          () => void reload(),
          (e) => toast.error(errorMessage(e)),
        ),
    })

  const moveTo = async (b: BoardSummary, to: WorkspaceSummary | null) => {
    try {
      const { visibility } = await api<{ visibility: string }>('PUT', `/boards/${b.id}/workspace`, { workspaceId: to?.id ?? null })
      toast(`Moved “${b.name}” to ${to ? to.name : 'Personal'}`, {
        description:
          to && visibility !== 'workspace'
            ? `Only people added can open it. To share it with everyone in ${to.name}, use Share on the board.`
            : undefined,
      })
      void reload()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const all = boards ?? []
  const spaces = workspaces ?? []
  const tile = (b: BoardSummary) => {
    const from = spaces.find((w) => w.id === b.workspaceId)
    return (
      <BoardTile
        key={b.id}
        board={b}
        onRename={b.role === 'owner' || b.role === 'editor' ? () => setRenaming(b) : undefined}
        onDelete={b.role === 'owner' ? () => askDelete(b) : undefined}
        onLeave={b.role !== 'owner' && b.via === 'member' ? () => askLeave(b) : undefined}
        move={
          b.role === 'owner' && (spaces.length > 0 || b.workspaceId)
            ? {
                places: [null, ...spaces].filter((w) => (w?.id ?? null) !== b.workspaceId),
                // Taking a board out of a workspace is for its admins.
                blocked: b.workspaceId && from?.role !== 'admin' ? `Only ${from?.name ?? 'the workspace'}’s admins can move it` : null,
                onMove: (to) => void moveTo(b, to),
              }
            : undefined
        }
      />
    )
  }
  const createTile = (where: string | null) =>
    boards && (
      <button
        onClick={() => setCreating({ where })}
        className="flex h-[9.5rem] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"
      >
        <Plus className="size-5" />
        Create board
      </button>
    )
  const inMine = new Set(spaces.map((w) => w.id))
  const personal = all.filter((b) => !b.workspaceId && b.role === 'owner')
  // Boards someone else shared with you: from their Personal space, or a workspace you're not in.
  const shared = all.filter((b) => (b.workspaceId ? !inMine.has(b.workspaceId) : b.role !== 'owner'))

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
        <LogoMark className="size-7" />
        <span className="text-sm font-semibold">Kanbanto</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setJoining(true)}>
            <Key /> <span className="hidden sm:inline">Join with a code</span>
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setCreating({ where: null })}>
            <Plus weight="bold" /> <span className="hidden sm:inline">Create board</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="More">
                <DotsThree weight="bold" className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => setNewWorkspace(true)}>
                <Buildings /> New workspace…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => file.current?.click()}>
                <UploadSimple /> Import a board…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <NotificationBell />
          <AccountMenu />
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importAsNew(f)
              e.target.value = ''
            }}
          />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl space-y-10 px-4 py-8">
          {error && !boards && <p className="text-sm text-destructive">{error}</p>}
          {spaces.length === 0 ? (
            <BoardSection title="Your boards" count={boards ? all.length : undefined}>
              {all.map(tile)}
              {createTile(null)}
            </BoardSection>
          ) : (
            <>
              <BoardSection title="Personal" count={personal.length}>
                {personal.map(tile)}
                {createTile(null)}
              </BoardSection>
              {spaces.map((w) => (
                <BoardSection
                  key={w.id}
                  title={w.name}
                  icon={<Buildings className="size-4 text-muted-foreground" />}
                  count={all.filter((b) => b.workspaceId === w.id).length}
                  action={
                    <Button asChild size="sm" variant="ghost" className="h-7 gap-1.5 text-muted-foreground">
                      <a href={hrefFor({ page: 'workspace', id: w.id })}>
                        <UsersThree /> {w.memberCount} {w.memberCount === 1 ? 'person' : 'people'}
                      </a>
                    </Button>
                  }
                >
                  {all.filter((b) => b.workspaceId === w.id).map(tile)}
                  {createTile(w.id)}
                </BoardSection>
              ))}
              {shared.length > 0 && (
                <BoardSection title="Shared with you" count={shared.length}>
                  {shared.map(tile)}
                </BoardSection>
              )}
            </>
          )}
          {workspaces && (
            <div className="border-t pt-6">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setNewWorkspace(true)}>
                <Buildings /> New workspace
              </Button>
              {spaces.length === 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  A place for a team’s boards: everyone in it can open them, without being invited to each one.
                </p>
              )}
            </div>
          )}
        </div>
      </main>

      <CreateBoardDialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)} workspaces={spaces} where={creating?.where} />
      <CreateWorkspaceDialog
        open={newWorkspace}
        onOpenChange={(o) => {
          setNewWorkspace(o)
          if (!o) void reloadWorkspaces()
        }}
      />
      <JoinCodeDialog open={joining} onOpenChange={setJoining} />
      <RenameBoardDialog key={renaming?.id} board={renaming} onClose={() => setRenaming(null)} onSaved={() => void reload()} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

const ROLE_LABEL = { owner: null, editor: 'Editor', viewer: 'Viewer' } as const

function BoardSection({
  title,
  icon,
  count,
  action,
  children,
}: {
  title: string
  icon?: ReactNode
  count?: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        {icon}
        <h2 className="text-lg font-semibold">{title}</h2>
        {count !== undefined && <span className="text-sm text-muted-foreground">{count}</span>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>
    </section>
  )
}

function BoardTile({
  board,
  onRename,
  onDelete,
  onLeave,
  move,
}: {
  board: BoardSummary
  onRename?: () => void
  onDelete?: () => void
  onLeave?: () => void
  /** Moving it to Personal (null) or another workspace; `blocked` says why it can't be. */
  move?: { places: (WorkspaceSummary | null)[]; blocked: string | null; onMove: (to: WorkspaceSummary | null) => void }
}) {
  const bg = board.background ? BOARD_BACKGROUNDS[board.background as ColorName] : null
  const pct = board.taskCount ? Math.round((board.doneCount / board.taskCount) * 100) : 0
  const vis = visibilityOf(board.visibility)
  const role = ROLE_LABEL[board.role]
  const hasMenu = onRename || onDelete || onLeave || move
  return (
    <div className="group relative overflow-hidden rounded-xl border bg-card shadow-xs transition-shadow hover:shadow-md">
      <a href={hrefFor({ page: 'board', id: board.id })} className="block outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div
          className={cn('flex h-20 items-end px-4 pb-3', !bg && 'bg-lane')}
          style={bg ? { background: `linear-gradient(135deg, ${bg.from}, ${bg.to})` } : undefined}
        >
          <span
            className={cn(
              'line-clamp-2 text-[15px] leading-snug font-semibold',
              bg ? (bg.text === 'light' ? 'text-white drop-shadow-sm' : 'text-black/80') : 'text-foreground',
            )}
          >
            {board.name}
          </span>
        </div>
        <div className="space-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/8">
              <div className="h-full rounded-full bg-status-done" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[11px] text-muted-foreground tabular-nums">{pct}%</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger asChild>
                <vis.icon className="size-3.5 shrink-0" aria-label={vis.label} />
              </TooltipTrigger>
              <TooltipContent>{vis.label}</TooltipContent>
            </Tooltip>
            <span className="truncate">
              {board.taskCount.toLocaleString()} {board.taskCount === 1 ? 'task' : 'tasks'} · updated{' '}
              {formatDistanceToNow(parseISO(board.updatedAt), { addSuffix: true })}
            </span>
            {role && <span className="ml-auto shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium">{role}</span>}
          </div>
        </div>
      </a>
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`${board.name} options`}
              className="absolute top-2 right-2 grid size-7 place-items-center rounded-md bg-black/20 text-white opacity-0 backdrop-blur-sm group-hover:opacity-100 hover:bg-black/35 focus-visible:opacity-100 data-[state=open]:opacity-100"
            >
              <DotsThree weight="bold" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onRename && (
              <DropdownMenuItem onSelect={onRename}>
                <PencilSimple /> Rename
              </DropdownMenuItem>
            )}
            {move && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ArrowsLeftRight /> Move to
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  {move.blocked ? (
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{move.blocked}</DropdownMenuLabel>
                  ) : (
                    move.places.map((w) => (
                      <DropdownMenuItem key={w?.id ?? 'personal'} onSelect={() => move.onMove(w)}>
                        {w ? <Buildings /> : <LockSimple />} {w ? w.name : 'Personal'}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {onLeave && (
              <DropdownMenuItem onSelect={onLeave}>
                <SignOut /> Leave board…
              </DropdownMenuItem>
            )}
            {onDelete && (
              <>
                {(onRename || onLeave || move) && <DropdownMenuSeparator />}
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash /> Delete board…
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

function RenameBoardDialog({ board, onClose, onSaved }: { board: BoardSummary | null; onClose: () => void; onSaved: () => void }) {
  // Remounted per board (see `key` above), so the field starts with that board's name.
  const [name, setName] = useState(board?.name ?? '')
  const save = async () => {
    if (!board) return
    try {
      await api('POST', `/boards/${board.id}/mutations`, { mutationId: newId(), command: { type: 'board.update', fields: { name } } })
      onSaved()
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Dialog open={!!board} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename board</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          className="space-y-4"
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Board name" />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
