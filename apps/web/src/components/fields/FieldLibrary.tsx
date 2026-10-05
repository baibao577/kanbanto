import { Archive, ArrowCounterClockwise, ArrowsMerge, PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import { useCallback, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { FieldLibraryView, FieldUsage, FieldView } from '@kanbanto/model/api'
import { FIELD_LIMITS } from '@kanbanto/model/fields'
import { api, errorMessage } from '@/api/client'
import { ConfirmDialog, type ConfirmRequest } from '@/components/common/ConfirmDialog'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { Button } from '@/components/ui/button'
import { useLoaded } from '@/data/useLoaded'
import { FieldEditor } from './FieldEditor'
import { FieldMergeDialog } from './FieldMerge'
import { FIELD_ICON, fieldSummary } from './meta'

const boardsWord = (f: FieldView) => {
  const n = f.boards
  if (n === 0) return 'Not on any board'
  // (An archived field is hidden where it was: restoring it brings it back there.)
  return `${f.archivedAt ? 'Hidden on' : 'On'} ${n === 1 ? '1 board' : `${n} boards`}`
}

/**
 * A library of fields and the screen to manage it: your own (`/fields`), or a workspace's
 * (`/workspaces/<id>/fields`). Everyone who can see the library sees the list; only the people who manage it (you,
 * or the workspace's admins) get the controls. A field goes away in two steps: archived (hidden on every board, its
 * values kept), then deleted for good. Or, when it doubles another one, by being merged into it.
 */
export function FieldLibrary({ base, description }: { base: string; description: ReactNode }) {
  const [view, reload] = useLoaded<FieldLibraryView>(useCallback(() => api('GET', base), [base]))
  const [editing, setEditing] = useState<FieldView | 'new' | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [merging, setMerging] = useState<FieldView | null>(null)
  if (!view) return null
  const { canManage } = view
  const active = view.fields.filter((f) => !f.archivedAt)
  const archived = view.fields.filter((f) => f.archivedAt)
  /** The fields one could be merged into: the others of its kind that are in use. */
  const alike = (f: FieldView) => active.filter((x) => x.id !== f.id && x.type === f.type)

  const act = (run: () => Promise<unknown>, done?: string) =>
    run().then(
      () => {
        if (done) toast(done)
        void reload()
      },
      (e) => void toast.error(errorMessage(e)),
    )
  const archive = (f: FieldView) =>
    act(
      () => api('PATCH', `${base}/${f.id}`, { archived: true }),
      f.boards
        ? `“${f.name}” is archived: it’s off ${f.boards === 1 ? 'its board' : `its ${f.boards} boards`}, and its values are kept.`
        : `“${f.name}” is archived.`,
    )
  const remove = async (f: FieldView) => {
    try {
      const use = await api<FieldUsage>('GET', `${base}/${f.id}/usage`)
      setConfirm({
        title: `Delete “${f.name}” for good?`,
        description: use.cards
          ? `${use.cards === 1 ? '1 card holds' : `${use.cards} cards hold`} a value for it. ${use.cards === 1 ? 'That value' : 'Those values'} will be deleted with it. This can’t be undone.`
          : 'No card holds a value for it. This can’t be undone.',
        confirmLabel: 'Delete for good',
        destructive: true,
        onConfirm: () => void act(() => api('DELETE', `${base}/${f.id}`)),
      })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const row = (f: FieldView, actions: ReactNode) => {
    const I = FIELD_ICON[f.type]
    return (
      <li key={f.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <I className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{f.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {fieldSummary(f)} · {boardsWord(f)}
          </p>
        </div>
        {canManage && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </li>
    )
  }

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Fields"
        description={description}
        action={
          canManage && (
            <Button size="sm" className="gap-1.5" disabled={active.length >= FIELD_LIMITS.perSpace} onClick={() => setEditing('new')}>
              <Plus /> New field
            </Button>
          )
        }
      >
        {active.length ? (
          <ul className="divide-y">
            {active.map((f) =>
              row(
                f,
                <>
                  <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setEditing(f)}>
                    <PencilSimple /> <span className="max-sm:sr-only">Change</span>
                  </Button>
                  {alike(f).length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      title="For two fields that mean the same thing: its values move to the other one"
                      onClick={() => setMerging(f)}
                    >
                      <ArrowsMerge /> <span className="max-lg:sr-only">Merge</span>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    title="Hides it on every board and keeps its values"
                    onClick={() => void archive(f)}
                  >
                    <Archive /> <span className="max-sm:sr-only">Archive</span>
                  </Button>
                </>,
              ),
            )}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {canManage
              ? 'No fields yet. Add one, like Client, Amount or Stage, then switch it on for a board in the board’s settings.'
              : 'No fields yet. The workspace’s admins add them.'}
          </p>
        )}
        {active.length >= FIELD_LIMITS.perSpace && (
          <p className="text-xs text-muted-foreground">
            That’s the most there can be ({FIELD_LIMITS.perSpace}). Archive one that’s no longer used to add another.
          </p>
        )}
      </SettingsCard>

      {archived.length > 0 && (
        <SettingsCard
          title="Archived fields"
          description="Hidden on every board, their values kept. Restore one to bring it back where it was, or delete it for good."
        >
          <ul className="divide-y">
            {archived.map((f) =>
              row(
                f,
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void act(() => api('PATCH', `${base}/${f.id}`, { archived: false }))}
                  >
                    <ArrowCounterClockwise /> <span className="max-sm:sr-only">Restore</span>
                  </Button>
                  <Button variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => void remove(f)}>
                    <Trash /> <span className="max-sm:sr-only">Delete</span>
                  </Button>
                </>,
              ),
            )}
          </ul>
        </SettingsCard>
      )}

      {editing && (
        <FieldEditor base={base} field={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />
      )}
      {merging && (
        <FieldMergeDialog base={base} field={merging} others={alike(merging)} onClose={() => setMerging(null)} onMerged={() => void reload()} />
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}
