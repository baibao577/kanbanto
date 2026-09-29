import { DotsThree, DownloadSimple, GearSix, PaintBucket } from '@phosphor-icons/react'
import { useBoard } from '@/app/board-context'
import { BackgroundSwatches } from '@/components/common/bits'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface MoreMenuProps {
  onOpenSettings: () => void
  onExport: () => void
}

/** The board's ⋯ menu: settings, background, export. */
export function MoreMenu({ onOpenSettings, onExport }: MoreMenuProps) {
  const { data, run, readOnly } = useBoard()

  return (
    <DropdownMenu>
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
        <DropdownMenuItem onSelect={onExport}>
          <DownloadSimple /> Export board
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
