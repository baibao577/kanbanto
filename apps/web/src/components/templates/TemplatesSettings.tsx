import { PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import { toast } from 'sonner'
import { stepsOf, TEMPLATE_NAME_MAX, type CardTemplate } from '@kanbanto/model/templates'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SaveBoardTemplateDialog } from './SaveTemplateDialog'

/** One card template: its name and what it holds; for the people who can edit, a way to rename and remove it. */
function Row({ template, canChange }: { template: CardTemplate; canChange: boolean }) {
  const { data } = useBoard()
  const [name, setName] = useState<string | null>(null)
  const steps = stepsOf(template)
  const at = `/boards/${data.board.id}/templates/${template.id}`
  const rename = () => {
    const next = name?.trim()
    setName(null)
    if (next && next !== template.name) api('PATCH', at, { name: next }).catch((e) => toast.error(errorMessage(e)))
  }
  const remove = () => {
    if (!confirm(`Remove the template “${template.name}”? The cards made from it stay as they are.`)) return
    api('DELETE', at).then(
      () => toast(`Removed the template “${template.name}”`),
      (e) => toast.error(errorMessage(e)),
    )
  }
  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        {name === null ? (
          <p className="truncate text-sm font-medium">{template.name}</p>
        ) : (
          <Input
            autoFocus
            aria-label="Template name"
            value={name}
            maxLength={TEMPLATE_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename()
              if (e.key === 'Escape') setName(null)
            }}
            className="h-8"
          />
        )}
        <p className="truncate text-xs text-muted-foreground">
          “{template.cards[0].title}”{steps > 0 && ` with ${steps} ${steps === 1 ? 'subtask' : 'subtasks'}`}
          {template.by && ` · saved by ${template.by}`}
        </p>
      </div>
      {canChange && name === null && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground"
            aria-label={`Rename ${template.name}`}
            onClick={() => setName(template.name)}
          >
            <PencilSimple />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${template.name}`}
            onClick={remove}
          >
            <Trash />
          </Button>
        </>
      )}
    </li>
  )
}

/**
 * Board settings → Templates. The board's card templates (a card with its subtasks, saved to start the next one
 * from: listed here to rename and remove; saved from a card's own menu), and for its owners, saving the board's
 * shape as a board template.
 */
export function TemplatesSettings() {
  const { templates, readOnly, access } = useBoard()
  const [saving, setSaving] = useState(false)
  const owner = access.role === 'owner' && !access.inbox
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">Templates</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Start the next card, or the next board, from one you saved. A template is a copy taken when it was saved: change it by saving over it.
        </p>
      </div>
      <section>
        <h3 className="text-sm font-semibold">Card templates</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          For work that repeats with the same steps. Everyone on this board starts cards from them, with the arrow on “Add card” and on “New task”. A
          card from a template has nobody assigned and no dates.
        </p>
        {templates.length ? (
          <ul className="mt-3 divide-y">
            {templates.map((t) => (
              <Row key={t.id} template={t} canChange={!readOnly} />
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
            No card templates yet.{!readOnly && ' Open a card, then choose ⋯ → Save as template…'}
          </p>
        )}
      </section>
      {owner && (
        <section>
          <h3 className="text-sm font-semibold">This board as a template</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Its lists, labels, fields, rules and card templates, to make the next board from: it shows under “Start with” when a board is made
            {access.workspace ? ` in ${access.workspace.name}, for everyone in it` : ''}. Never its cards or its people.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setSaving(true)}>
            <Plus /> Save board as template…
          </Button>
        </section>
      )}
      {saving && <SaveBoardTemplateDialog onClose={() => setSaving(false)} />}
    </div>
  )
}
