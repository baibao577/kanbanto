import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { stepsOf, TEMPLATE_NAME_MAX, TEMPLATES_MAX, type BoardTemplate, type CardTemplate } from '@kanbanto/model/templates'
import { descendantsOf } from '@kanbanto/model/indexer'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const NEW = 'new'

/** The two things every "save as template" asks: a new one under a name, or over one that is there. */
function Form({
  id,
  title,
  about,
  startName,
  existing,
  full,
  onSave,
  onClose,
}: {
  id: string
  title: string
  about: string
  startName: string
  /** The templates that can be saved over. */
  existing: { id: string; name: string }[]
  /** There is no room for another: only saving over one is offered. */
  full: boolean
  onSave: (input: { name?: string; replace?: string }) => Promise<string>
  onClose: () => void
}) {
  const [name, setName] = useState(startName)
  const [which, setWhich] = useState(full && existing.length ? existing[0].id : NEW)
  const [busy, setBusy] = useState(false)
  const over = existing.find((t) => t.id === which)
  const save = async () => {
    setBusy(true)
    try {
      toast(await onSave(over ? { replace: over.id } : { name: name.trim() }))
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{about}</DialogDescription>
        </DialogHeader>
        <form
          id={id}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy && (over || name.trim())) void save()
          }}
        >
          {existing.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor={`${id}-which`}>Save as</Label>
              <Select value={which} onValueChange={setWhich}>
                <SelectTrigger id={`${id}-which`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {!full && <SelectItem value={NEW}>A new template</SelectItem>}
                  {existing.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      Replace “{t.name}”
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {!over && (
            <div className="space-y-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input id={`${id}-name`} autoFocus value={name} maxLength={TEMPLATE_NAME_MAX} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          {over && (
            <p className="text-sm text-muted-foreground">“{over.name}” becomes what this is now. What was made from it before stays as it is.</p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={id} disabled={busy || (!over && !name.trim())}>
            {over ? 'Replace' : 'Save template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Saves a card, with everything under it, as one of the board's card templates (see model templates.ts): the next
 * card like it is started from there. What it keeps and leaves is said, since it isn't everything.
 */
export function SaveCardTemplateDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { data, idx, templates } = useBoard()
  const card = data.tasks[taskId]
  const steps = card ? descendantsOf(idx, taskId).length : 0
  if (!card) return null
  return (
    <Form
      id="save-card-template"
      title="Save as template"
      about={`A copy of this card${steps ? ` and its ${steps} ${steps === 1 ? 'subtask' : 'subtasks'}` : ''}: titles, descriptions, labels, priority and fields. Not who it is assigned to, dates, comments, files or logged time.`}
      startName={card.title.slice(0, TEMPLATE_NAME_MAX)}
      existing={templates}
      full={templates.length >= TEMPLATES_MAX}
      onClose={onClose}
      onSave={async (input) => {
        const { template } = await api<{ template: CardTemplate }>('POST', `/boards/${data.board.id}/templates`, { taskId, ...input })
        const n = stepsOf(template)
        return `Saved “${template.name}”${n ? ` with ${n} ${n === 1 ? 'step' : 'steps'}` : ''}. Start a card from it with the arrow on “Add card”.`
      }}
    />
  )
}

/**
 * Saves the board's shape as a board template, where the board lives (its workspace's, or your own): its lists,
 * labels, fields, rules and card templates. Never its cards or its people.
 */
export function SaveBoardTemplateDialog({ onClose }: { onClose: () => void }) {
  const { data, access } = useBoard()
  const workspaceId = access.workspace?.id
  const [existing, setExisting] = useState<BoardTemplate[] | null>(null)
  useEffect(() => {
    api<{ templates: BoardTemplate[] }>('GET', `/board-templates${workspaceId ? `?workspace=${workspaceId}` : ''}`).then(
      (r) => setExisting(r.templates),
      () => setExisting([]),
    )
  }, [workspaceId])
  if (!existing) return null
  const where = access.workspace ? `${access.workspace.name}’s templates, for everyone in it` : 'your own templates'
  return (
    <Form
      id="save-board-template"
      title="Save board as template"
      about={`This board’s lists, labels, fields, rules and card templates, to make the next board from. Not its cards or its people. It goes to ${where}.`}
      startName={data.board.name.slice(0, TEMPLATE_NAME_MAX)}
      existing={existing.filter((t) => t.canChange)}
      full={existing.length >= TEMPLATES_MAX}
      onClose={onClose}
      onSave={async (input) => {
        const { template } = await api<{ template: BoardTemplate }>('POST', `/boards/${data.board.id}/template`, input)
        return `Saved “${template.name}”. It is under “Start with” when a board is made${access.workspace ? ` in ${access.workspace.name}` : ''}.`
      }}
    />
  )
}
