import { Archive, ArrowsLeftRight, Buildings, ChartBar, DotsThree, DownloadSimple, GearSix, LockSimple, PaintBucket } from '@phosphor-icons/react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { CardsPage, WorkspaceSummary } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { navigate } from '@/app/router'
import { BackgroundSwatches } from '@/components/common/bits'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { moveBoardTo } from '@/data/moveBoard'
import { Button } from '@/components/ui/button'
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

export interface MoreMenuProps {
  onOpenSettings: () => void
  onOpenStats: () => void
  onExport: () => void
}

/** The board's ⋯ menu: settings, background, stats, moving it (owners), export. */
export function MoreMenu({ onOpenSettings, onOpenStats, onExport }: MoreMenuProps) {
  const { data, run, readOnly, access } = useBoard()
  const owner = access.role === 'owner'
  // How many archived cards it has: asked when the menu opens (they aren't sent with the board).
  const [archived, setArchived] = useState(0)
  const countArchived = () =>
    access.via !== 'public' &&
    api<CardsPage>('GET', `/cards?state=archived&board=${encodeURIComponent(data.board.id)}&limit=1`).then(
      (r) => setArchived(r.total),
      () => {},
    )
  // Where it can move: loaded when the menu opens (owners only).
  const [spaces, setSpaces] = useState<WorkspaceSummary[] | null>(null)
  const from = access.workspace
  // Asked before a move that would add fields to the other place, or lose some (see moveBoardTo).
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const fromAdmin = !from || spaces?.find((w) => w.id === from.id)?.role === 'admin'

  const moveTo = async (to: WorkspaceSummary | null) => {
    try {
      const { visibility } = await moveBoardTo(data.board.id, to, setConfirm)
      toast(`Moved to ${to ? to.name : 'Personal'}`, {
        description:
          to && visibility !== 'workspace' ? `Only people added can open it. To share it with everyone in ${to.name}, use Share.` : undefined,
      })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <DropdownMenu
        onOpenChange={(o) => {
          if (!o) return
          void countArchived()
          if (owner)
            void api<{ workspaces: WorkspaceSummary[] }>('GET', '/workspaces').then(
              (r) => setSpaces(r.workspaces),
              () => setSpaces([]),
            )
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="More">
            <DotsThree weight="bold" className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {!readOnly && (
            <>
              <DropdownMenuItem onSelect={onOpenSettings}>
                <GearSix /> Board settings
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <PaintBucket /> Board background
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-60 p-2">
                  <BackgroundSwatches
                    value={data.board.background}
                    onChange={(color) => run({ type: 'board.update', fields: { background: color ?? null } })}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={onOpenStats}>
            <ChartBar /> Board stats
          </DropdownMenuItem>
          {owner && (from || !!spaces?.length) && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ArrowsLeftRight /> Move to
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                {!spaces ? (
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Loading…</DropdownMenuLabel>
                ) : !fromAdmin ? (
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Only {from!.name}’s admins can move it</DropdownMenuLabel>
                ) : (
                  [null, ...spaces]
                    .filter((w) => (w?.id ?? null) !== (from?.id ?? null))
                    .map((w) => (
                      <DropdownMenuItem key={w?.id ?? 'personal'} onSelect={() => void moveTo(w)}>
                        {w ? <Buildings /> : <LockSimple />} {w ? w.name : 'Personal'}
                      </DropdownMenuItem>
                    ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {archived > 0 && (
            <DropdownMenuItem onSelect={() => navigate({ page: 'cards', state: 'archived', board: data.board.id })}>
              <Archive /> Archived cards
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">{archived}</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onExport}>
            <DownloadSimple /> Export board
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
