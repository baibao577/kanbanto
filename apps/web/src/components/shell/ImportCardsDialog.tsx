import { FileCsv, Warning } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fieldKey } from '@kanbanto/model/fields'
import { newId } from '@kanbanto/model/ids'
import { guessColumns, IMPORT_ROLES, problemText, ROLE_LABEL, rowsText, type ColumnRole, type ImportReport } from '@kanbanto/model/importCards'
import type { Change } from '@kanbanto/model/records'
import { parseSheet, type Sheet } from '@kanbanto/model/sheet'
import { readDate, type DateOrder } from '@kanbanto/model/sheetValues'
import { api, errorMessage } from '@/api/client'
import { useBoard } from '@/app/board-context'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { decodeSheet, SHEET_ENCODINGS, type SheetEncoding } from '@/lib/sheetFile'
import { cn } from '@/lib/utils'

interface Answer {
  columns: ColumnRole[]
  report: ImportReport
  added: number
  seq?: number
  changes?: Change[]
}

const cards = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'card' : 'cards'}`
const named = (names: string[]) => names.map((n) => `“${n}”`).join(', ')
const longDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * Cards from a spreadsheet: paste rows (or choose a .csv), say what each column is, and read the check before
 * adding. The check is the server's (it knows the people's addresses and the cards other boards have), asked again
 * whenever something changes; nothing is added until the button is pressed, and it's one change to undo.
 */
export function ImportCardsDialog({ onClose }: { onClose: () => void }) {
  const { data, adopt } = useBoard()
  const boardId = data.board.id
  const [text, setText] = useState('')
  // A file that was chosen: kept, so it can be read again in another encoding.
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; encoding: SheetEncoding | 'utf-16'; sure: boolean } | null>(null)
  const [header, setHeader] = useState(true)
  // What the person said a column is, by its place; the rest are read from the names in the first row.
  const [said, setSaid] = useState<Record<number, ColumnRole>>({})
  const [dateOrder, setDateOrder] = useState<DateOrder | undefined>()
  const [addAnyway, setAddAnyway] = useState(false)
  // The server's answer, and the question it answers: an answer to an older question isn't shown.
  const [answer, setAnswer] = useState<{ to: object; is: { report: ImportReport } | { problem: string } } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const read = useMemo((): { sheet: Sheet } | { problem: string } | null => {
    if (!text.trim()) return null
    try {
      return { sheet: parseSheet(text) }
    } catch (e) {
      return { problem: errorMessage(e) }
    }
  }, [text])
  const sheet = read && 'sheet' in read ? read.sheet : null
  const width = sheet?.rows[0].length ?? 0

  const roles = useMemo((): ColumnRole[] => {
    if (!sheet) return []
    const guessed = guessColumns(header ? sheet.rows[0] : [], data.fields)
    const out = Array.from({ length: width }, (_, i): ColumnRole => said[i] ?? guessed[i] ?? 'skip')
    // What the person chose wins: a guess for the same thing elsewhere steps aside.
    for (const [at, role] of Object.entries(said))
      out.forEach((r, i) => i !== Number(at) && r === role && role !== 'skip' && !said[i] && (out[i] = 'skip'))
    if (!out.includes('title') && !Object.values(said).length && out.length) out[out.indexOf('skip') === -1 ? 0 : out.indexOf('skip')] = 'title'
    return out
  }, [sheet, header, said, data.fields, width])
  const hasTitle = roles.includes('title')
  const twice = roles.find((r, i) => r !== 'skip' && roles.indexOf(r) !== i)

  // The check, asked again a moment after anything changes.
  const body = useMemo(
    () =>
      sheet && hasTitle && !twice
        ? { text, columns: roles, header, dateOrder, addAnyway, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
        : null,
    [sheet, hasTitle, twice, text, roles, header, dateOrder, addAnyway],
  )
  useEffect(() => {
    if (!body) return
    const timer = setTimeout(() => {
      api<Answer>('POST', `/boards/${encodeURIComponent(boardId)}/tasks/import`, { ...body, dryRun: true }).then(
        (r) => setAnswer({ to: body, is: { report: r.report } }),
        (e) => setAnswer({ to: body, is: { problem: errorMessage(e) } }),
      )
    }, 350)
    return () => clearTimeout(timer)
  }, [body, boardId])
  const check = answer && answer.to === body ? answer.is : null
  const report = check && 'report' in check ? check.report : null

  /** Takes a file's bytes as the rows (again in another encoding, when its letters came out wrong). */
  const take = (name: string, bytes: Uint8Array, as?: SheetEncoding) => {
    setError(null)
    try {
      const got = decodeSheet(bytes, as)
      setFile({ name, bytes, encoding: got.encoding, sure: got.sure })
      setText(got.text)
      setSaid({})
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const choose = async (f: File) => take(f.name, new Uint8Array(await f.arrayBuffer()))

  const add = async () => {
    if (!body || !report) return
    setBusy(true)
    setError(null)
    try {
      const done = await api<Answer>('POST', `/boards/${encodeURIComponent(boardId)}/tasks/import`, { ...body, mutationId: newId() })
      if (done.seq !== undefined && done.changes) adopt(done.seq, done.changes, `Imported ${cards(done.added)}`)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const sample = sheet ? sheet.rows.slice(header ? 1 : 0, (header ? 1 : 0) + 3) : []
  const rowCount = sheet ? sheet.rows.length - (header ? 1 : 0) : 0
  const ask = report?.askDateOrder
  const ready = !!report && !ask && report.cards > 0

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className={cn('flex max-h-[92dvh] flex-col', sheet ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <DialogHeader>
          <DialogTitle>Import cards</DialogTitle>
          <DialogDescription>
            Each row of a spreadsheet becomes a card on “{data.board.name}”. Copy the rows in Excel or Google Sheets and paste them here, or choose a
            .csv file.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 text-sm">
          {!sheet ? (
            <>
              <Textarea
                autoFocus
                value={text}
                onChange={(e) => {
                  setFile(null)
                  setText(e.target.value)
                }}
                placeholder={'Title\tDue\tAssignee\nCall Acme\t31/10/2026\tAnn'}
                aria-label="Rows pasted from a spreadsheet"
                className="h-40 resize-none font-mono text-xs whitespace-pre"
              />
              {read && 'problem' in read && <p className="text-destructive">{read.problem}</p>}
              <Button type="button" variant="outline" size="sm" onClick={() => picker.current?.click()}>
                <FileCsv /> Choose a .csv file…
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="text-muted-foreground">
                  {file ? `${file.name}: ` : ''}
                  {rowCount.toLocaleString()} {rowCount === 1 ? 'row' : 'rows'}, {width} {width === 1 ? 'column' : 'columns'}
                </span>
                <label className="flex items-center gap-2">
                  <Checkbox checked={header} onCheckedChange={(on) => setHeader(!!on)} /> The first row is column names
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => {
                    setText('')
                    setFile(null)
                    setSaid({})
                    setDateOrder(undefined)
                  }}
                >
                  Start over
                </Button>
              </div>
              {file && !file.sure && (
                <label className="flex flex-wrap items-center gap-2">
                  Do the letters look wrong? Read the file as
                  <Select value={file.encoding} onValueChange={(v) => take(file.name, file.bytes, v as SheetEncoding)}>
                    <SelectTrigger size="sm" className="w-56" aria-label="The file’s encoding">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SHEET_ENCODINGS.filter(([id]) => id !== 'utf-8').map(([id, name]) => (
                        <SelectItem key={id} value={id}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}

              <section>
                <h3 className="font-medium">What each column is</h3>
                <p className="mb-2 text-muted-foreground">Read from the column names where they say. Change any that’s wrong.</p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-max min-w-full border-collapse text-left">
                    <thead>
                      <tr className="bg-muted/50">
                        {roles.map((role, i) => (
                          <th key={i} className="w-44 max-w-44 min-w-44 border-b p-1.5 align-top font-normal">
                            <Select value={role} onValueChange={(v) => setSaid((was) => ({ ...was, [i]: v as ColumnRole }))}>
                              <SelectTrigger
                                size="sm"
                                className={cn('w-full', role === 'skip' && 'text-muted-foreground')}
                                aria-label={`What column ${i + 1}${header && sheet.rows[0][i] ? ` (“${sheet.rows[0][i]}”)` : ''} is`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {IMPORT_ROLES.map((r) => (
                                  <SelectItem key={r} value={r}>
                                    {ROLE_LABEL[r]}
                                  </SelectItem>
                                ))}
                                {data.fields.length > 0 && (
                                  <>
                                    <SelectSeparator />
                                    <SelectGroup>
                                      <SelectLabel>This board’s fields</SelectLabel>
                                      {data.fields.map((f) => (
                                        <SelectItem key={f.id} value={fieldKey(f.id)}>
                                          {f.name}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </>
                                )}
                              </SelectContent>
                            </Select>
                            {header && <div className="truncate px-1 pt-1 text-xs font-medium">{sheet.rows[0][i] || ' '}</div>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sample.map((row, r) => (
                        <tr key={r} className="border-b last:border-0">
                          {row.map((cell, i) => (
                            <td key={i} className={cn('max-w-44 truncate px-2.5 py-1 text-xs', roles[i] === 'skip' && 'text-muted-foreground/60')}>
                              {cell.replace(/\s+/g, ' ') || ' '}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!hasTitle && <p className="mt-2 text-destructive">Say which column is the title: every card needs one.</p>}
                {twice && <p className="mt-2 text-destructive">Two columns are set to the same thing: each can only be used once.</p>}
              </section>

              {ask && (
                <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <h3 className="flex items-center gap-1.5 font-medium">
                    <Warning className="size-4" /> Which way round are the dates?
                  </h3>
                  <p className="mb-2 text-muted-foreground">
                    “{ask.sample}” in {ask.column} could be read two ways, and nothing in the column says which.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(['dmy', 'mdy'] as const).map((o) => {
                      const d = readDate(ask.sample, o)
                      return (
                        <Button key={o} type="button" variant="outline" size="sm" onClick={() => setDateOrder(o)}>
                          {o === 'dmy' ? 'Day first' : 'Month first'}
                          {d ? `: ${longDay(d.day)}` : ''}
                        </Button>
                      )
                    })}
                  </div>
                </section>
              )}

              <section aria-live="polite">
                <h3 className="mb-1 font-medium">The check</h3>
                {check && 'problem' in check ? (
                  <p className="text-destructive">{check.problem}</p>
                ) : !report ? (
                  <p className="text-muted-foreground">{body ? 'Checking…' : 'Set the columns first.'}</p>
                ) : (
                  <ul className="space-y-1">
                    <li>
                      <span className="font-medium">{cards(report.cards)}</span> will be added
                      {report.subtasks > 0 && ` (${report.subtasks.toLocaleString()} under another card)`}.
                    </li>
                    {report.lists.length > 0 && (
                      <li className="text-muted-foreground">
                        New {report.lists.length === 1 ? 'list' : 'lists'}: {named(report.lists)}.
                      </li>
                    )}
                    {report.labels.length > 0 && (
                      <li className="text-muted-foreground">
                        New {report.labels.length === 1 ? 'label' : 'labels'}: {named(report.labels)}.
                      </li>
                    )}
                    {report.options.map((o) => (
                      <li key={o.field} className="text-muted-foreground">
                        New in {o.field}: {named(o.names)}.
                      </li>
                    ))}
                    {report.noTitle.length > 0 && <li className="text-muted-foreground">Left out, with no title: {rowsText(report.noTitle)}.</li>}
                    {(report.duplicates.length > 0 || addAnyway) && (
                      <li className="text-muted-foreground">
                        {report.duplicates.length > 0 && `Left out, already a card on this board: ${rowsText(report.duplicates)}. `}
                        <label className="inline-flex items-center gap-1.5 text-foreground">
                          <Checkbox checked={addAnyway} onCheckedChange={(on) => setAddAnyway(!!on)} /> Add rows that are already cards
                        </label>
                      </li>
                    )}
                    {report.problems.map((p) => (
                      <li key={`${p.column}:${p.kind}`} className="text-amber-700 dark:text-amber-400">
                        {problemText(p)} ({rowsText(p.rows)}): {named(p.samples)}
                        {p.rows.length > p.samples.length ? '…' : ''}.
                        {p.kind !== 'long' && (p.rows.length === 1 ? ' That card is added without it.' : ' Those cards are added without it.')}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>

        <input
          ref={picker}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void choose(f)
            e.target.value = ''
          }}
        />
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !ready} onClick={() => void add()}>
            {busy ? 'Adding…' : report && report.cards > 0 ? `Add ${cards(report.cards)}` : 'Add cards'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
