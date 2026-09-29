import { Desktop, Moon, Sun, Trash } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { useState, type ReactNode } from 'react'
import { WebhooksDialog } from '@/components/board/WebhooksDialog'
import { useBoard } from '@/app/board-context'
import { Avatar, BackgroundSwatches } from '@/components/common/bits'
import { navigate } from '@/app/router'
import { useTheme } from '@/app/use-theme'
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, errorMessage } from '@/api/client'
import type { StatusMode } from '@kanbanto/model/types'

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, run, access, openShare } = useBoard()
  const { theme, setTheme } = useTheme()
  const [webhooks, setWebhooks] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Board settings</DialogTitle>
          <DialogDescription>Changes are saved as you make them.</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="board-name">Board name</Label>
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
          </div>

          <div className="space-y-2">
            <Label>When a task has subtasks, its status…</Label>
            <RadioGroup
              value={data.board.mode}
              onValueChange={(v) => run({ type: 'board.update', fields: { mode: v as StatusMode } })}
              className="gap-2"
            >
              <Choice value="derived" title="Follows its subtasks" recommended>
                It’s Done when all its subtasks are done, and In progress as soon as one of them starts.
              </Choice>
              <Choice value="manual" title="Is set by you">
                It stays wherever you put it, whatever its subtasks are doing.
              </Choice>
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label>People</Label>
            <div className="flex items-center gap-3">
              <div className="flex -space-x-1.5">
                {data.members.slice(0, 6).map((m) => (
                  <Avatar key={m.id} name={m.name} className="ring-2 ring-background" />
                ))}
              </div>
              <p className="flex-1 text-xs text-muted-foreground">
                {data.members.length === 1 ? 'Only you so far.' : `${data.members.length} people can work on this board.`} Invite people and choose
                what they can do in Share.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false)
                  openShare()
                }}
              >
                Share…
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Board background</Label>
            <BackgroundSwatches
              value={data.board.background}
              onChange={(color) => run({ type: 'board.update', fields: { background: color ?? null } })}
            />
          </div>

          <div className="space-y-2">
            <Label>Appearance</Label>
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
          </div>

          {access.role === 'owner' && (
            <div className="space-y-2">
              <Label>Webhooks</Label>
              <div className="flex items-center gap-3">
                <p className="flex-1 text-xs text-muted-foreground">Send this board’s changes to another app as they happen (Slack, n8n, Zapier…).</p>
                <Button variant="outline" size="sm" onClick={() => setWebhooks(true)}>
                  Manage…
                </Button>
              </div>
              <WebhooksDialog open={webhooks} onOpenChange={setWebhooks} />
            </div>
          )}

          {access.role === 'owner' && (
            <div className="space-y-2 border-t pt-5">
              <Label>Delete this board</Label>
              <p className="text-xs text-muted-foreground">
                Deletes the board and all its tasks for everyone. Export it first (⋯ → Export board) if you want a copy.
              </p>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive">
                    <Trash /> Delete board…
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete “{data.board.name}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Its {Object.keys(data.tasks).length.toLocaleString()} tasks will be deleted too. This can’t be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-white hover:bg-destructive/90"
                      onClick={() => {
                        api('DELETE', `/boards/${data.board.id}`).then(
                          () => {
                            onOpenChange(false)
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
          )}
        </div>
      </DialogContent>
    </Dialog>
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
