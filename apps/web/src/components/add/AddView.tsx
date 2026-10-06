import { Check, Tray } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { BoardSummary } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { hrefFor, type Route } from '@/app/router'
import { TitleDateChip } from '@/components/text/TitleDate'
import { useTitleDate } from '@/components/text/useTitleDate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useLoaded } from '@/data/useLoaded'
import { cardFromShared } from '@/lib/shared'

const INBOX = 'inbox'

/**
 * The little "add a card" page: what the bookmark button and a phone's Share open, with the page's title, its
 * address and any selected words already in. It goes to your Inbox unless you pick a board. Nothing is saved until
 * you press Add; then the window closes itself, when it was opened as a little window of its own.
 */
export function AddView({ route }: { route: Extract<Route, { page: 'add' }> }) {
  const start = useMemo(() => cardFromShared(route), [route])
  const [title, setTitle] = useState(start.title)
  const [details, setDetails] = useState(start.description)
  const [where, setWhere] = useState(INBOX)
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<{ place: string; href: string } | null>(null)
  const dates = useTitleDate(title)
  const [boards] = useLoaded(useCallback(() => api<{ boards: BoardSummary[] }>('GET', '/boards'), []))
  // The boards you can add to (your Inbox has its own line, first).
  const choices = (boards?.boards ?? []).filter((b) => !b.inbox && !b.archivedAt && b.role !== 'viewer')

  useEffect(() => {
    document.title = 'Add a card · Kanbanto'
  }, [])

  const add = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const said = dates.apply(title.trim())
      const body = { title: said.title, ...(details.trim() && { description: details.trim() }), ...said.fields }
      const r = await api<{ board: { id: string; name: string; inbox?: boolean }; card: { id: string } }>(
        'POST',
        where === INBOX ? '/inbox/cards' : `/boards/${where}/cards`,
        body,
      )
      setAdded({ place: r.board.inbox ? 'your Inbox' : r.board.name, href: hrefFor({ page: 'board', id: r.board.id, task: r.card.id }) })
      // (A window the bookmark button opened has done its job. One that can't close itself says "Added" instead.)
      if (route.w) setTimeout(() => window.close(), 900)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-start bg-background p-4 sm:place-items-center">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-5">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Tray className="size-5 text-muted-foreground" /> Add a card
        </h1>
        {added ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm">
              <Check weight="bold" className="size-4 text-status-done" /> Added to {added.place}.
            </p>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={added.href} target={route.w ? '_blank' : undefined} rel="noreferrer">
                  Open the card
                </a>
              </Button>
              {!route.w && (
                <Button asChild variant="ghost" size="sm">
                  <a href={hrefFor({ page: 'home' })}>Go to your boards</a>
                </Button>
              )}
            </div>
            {route.w && <p className="text-xs text-muted-foreground">You can close this window.</p>}
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="add-title">Title</Label>
              <Input id="add-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} placeholder="What is it?" />
              <TitleDateChip state={dates} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-details">Details</Label>
              <Textarea
                id="add-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={5}
                className="text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add()
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-where">Goes to</Label>
              <Select value={where} onValueChange={setWhere}>
                <SelectTrigger id="add-where" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INBOX}>Your Inbox</SelectItem>
                  {choices.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="w-full" disabled={!title.trim() || busy}>
              Add
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
