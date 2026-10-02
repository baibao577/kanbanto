import { Archive, HardDrives, Warning } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { StorageBucket, StorageMove, StoragePlace } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatSize } from '@/lib/format'

const files = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`

/**
 * Where files still are, other than where new ones go: the server's disk, Kanbanto's storage, or buckets used
 * earlier. They keep opening from there; "Move here" brings them to the storage in use. An earlier bucket can get new
 * keys (after changing them at the provider) or be used again. Shown only when there's something elsewhere.
 */
export function StoragePlaces({
  base,
  places,
  move,
  target,
  note,
  onChanged,
}: {
  /** The site's storage settings, or a person's. */
  base: '/admin/storage' | '/account/storage'
  places: StoragePlace[]
  move: StorageMove | null
  /** Where new files go now, in words: "the bucket “files”", "this server’s disk". */
  target: string
  /** Something to know before moving (they'll count toward your space). */
  note?: string
  onChanged: () => Promise<unknown>
}) {
  const [keysFor, setKeysFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = !!move?.running

  // While files are moving, keep the numbers fresh; say how it went when it ends.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (!running) {
      if (wasRunning.current && move) toast(move.moved ? `Moved ${files(move.moved)} to ${target}.` : 'No files were moved.')
      wasRunning.current = false
      return
    }
    wasRunning.current = true
    const timer = setInterval(() => void onChanged(), 2000)
    return () => clearInterval(timer)
  }, [running, move, target, onChanged])

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await what()
      await onChanged()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const problems = move && !running ? move.failed + move.noSpace : 0
  if (!places.length && !running && !problems) return null
  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <h3 className="text-sm font-medium">Files kept elsewhere</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          These files keep opening from where they are. Move here brings them to {target} and removes them from the old place.{note && ` ${note}`}
        </p>
      </div>
      {places.map((p) => (
        <div key={p.id} className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            {p.bucket?.lastError ? (
              <Warning weight="fill" className="mt-0.5 size-5 shrink-0 text-destructive" />
            ) : p.bucket ? (
              <Archive className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            ) : (
              <HardDrives className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1 basis-48 space-y-0.5">
              <p className="text-sm font-medium">
                {p.kind === 'disk' ? 'This server’s disk' : p.kind === 'site' ? 'Kanbanto’s storage' : `Earlier bucket “${p.bucket?.bucket}”`}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {files(p.files)} · {formatSize(p.bytes)}
                {p.bucket && ` · ${new URL(p.bucket.endpoint).host} · key ${p.bucket.accessKeyId.slice(0, 6)}…`}
              </p>
              {p.bucket?.lastError && <p className="text-xs text-destructive">Last problem: {p.bucket.lastError}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || running}
                onClick={() =>
                  act(async () => {
                    await api('POST', `${base}/move`, { place: p.id })
                    // A quick move may be over before the first look at its progress.
                    wasRunning.current = true
                  })
                }
              >
                Move here
              </Button>
              {p.bucket && (
                <>
                  <Button size="sm" variant="ghost" disabled={busy || running} onClick={() => setKeysFor(keysFor === p.id ? null : p.id)}>
                    Update keys
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy || running} onClick={() => act(() => switchBackTo(base, p.bucket!))}>
                    Use again
                  </Button>
                </>
              )}
            </div>
          </div>
          {p.bucket && keysFor === p.id && (
            <KeysForm
              bucket={p.bucket}
              onCancel={() => setKeysFor(null)}
              onSave={async (keys) => {
                await api('PUT', `${base}/buckets/${p.id}/keys`, keys)
                toast('Keys saved. The files in that bucket open with them now.')
                setKeysFor(null)
                await onChanged()
              }}
            />
          )}
        </div>
      ))}
      {move && running && (
        <div className="flex items-center gap-3 text-sm" role="status">
          <span className="tabular-nums">
            Moving files: {move.moved.toLocaleString()} of {move.total.toLocaleString()}…
          </span>
          <Button size="sm" variant="ghost" onClick={() => act(() => api('DELETE', `${base}/move`))}>
            Stop
          </Button>
        </div>
      )}
      {move && !running && problems > 0 && (
        <p className="text-xs text-destructive" role="status">
          {move.failed > 0 && `${files(move.failed)} couldn’t be moved${move.lastError ? ` (${move.lastError})` : ''}. `}
          {move.noSpace > 0 && `${files(move.noSpace)} didn’t fit in the space left. `}
          They are still where they were.
        </p>
      )}
    </div>
  )
}

/** Makes an earlier bucket the one new files go to, with the keys Kanbanto already has for it. */
const switchBackTo = async (base: string, b: StorageBucket) => {
  await api('PUT', `${base}/bucket`, { endpoint: b.endpoint, region: b.region, bucket: b.bucket, accessKeyId: b.accessKeyId })
  toast(`New files go to the bucket “${b.bucket}” again.`)
}

function KeysForm({
  bucket,
  onSave,
  onCancel,
}: {
  bucket: StorageBucket
  onSave: (keys: { accessKeyId: string; secret: string }) => Promise<void>
  onCancel: () => void
}) {
  const [accessKeyId, setAccessKeyId] = useState(bucket.accessKeyId)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await onSave({ accessKeyId, secret })
        } catch (err) {
          setError(errorMessage(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`keys-id-${bucket.id}`} className="text-xs">
            Access key ID
          </Label>
          <Input
            id={`keys-id-${bucket.id}`}
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-8 font-mono"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`keys-secret-${bucket.id}`} className="text-xs">
            Secret access key
          </Label>
          <Input
            id={`keys-secret-${bucket.id}`}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            className="h-8 font-mono"
            required
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        For when this bucket’s key was changed or revoked at the provider. The new key is tested first; new files keep going where they go now.
      </p>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Testing the bucket…' : 'Test and save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
