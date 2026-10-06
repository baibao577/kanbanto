import { CheckCircle, HardDrives, Warning } from '@phosphor-icons/react'
import { useState } from 'react'
import type { StorageBucket } from '@kanbanto/model/api'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface BucketFields {
  endpoint: string
  region?: string
  bucket: string
  accessKeyId: string
  secret?: string
}

/**
 * An S3-compatible bucket (Cloudflare R2, AWS S3, MinIO…). The secret is write-only: saved encrypted and never
 * shown again. Saving tests the bucket first (writes and removes a small file); nothing is saved if that fails.
 */
export function BucketForm({
  bucket,
  encryptionReady,
  defaultLabel,
  own,
  onSave,
  onRemove,
}: {
  bucket: StorageBucket | null
  encryptionReady: boolean
  /** What's used without a bucket (e.g. "This server’s disk"). */
  defaultLabel: string
  /** A person's own bucket: it has to be on the public internet. (The site's own may be on its network.) */
  own?: boolean
  onSave: (fields: BucketFields) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState<BucketFields>({
    endpoint: bucket?.endpoint ?? '',
    region: bucket?.region ?? '',
    bucket: bucket?.bucket ?? '',
    accessKeyId: bucket?.accessKeyId ?? '',
    secret: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!editing)
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border p-3">
          {bucket ? (
            bucket.lastError ? (
              <Warning weight="fill" className="mt-0.5 size-5 shrink-0 text-destructive" />
            ) : (
              <CheckCircle weight="fill" className="mt-0.5 size-5 shrink-0 text-status-done" />
            )
          ) : (
            <HardDrives className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">{bucket ? `Bucket “${bucket.bucket}”` : defaultLabel}</p>
            {bucket && (
              <p className="truncate text-xs text-muted-foreground">
                {new URL(bucket.endpoint).host} · key {bucket.accessKeyId.slice(0, 6)}… · secret {bucket.keyHint}
              </p>
            )}
            {bucket?.lastError && <p className="text-xs text-destructive">Last problem: {bucket.lastError}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={!encryptionReady}>
            {bucket ? 'Change' : 'Use an S3 / R2 bucket'}
          </Button>
          {bucket && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                await onRemove().catch((e) => setError(errorMessage(e)))
                setBusy(false)
              }}
            >
              Stop using it
            </Button>
          )}
        </div>
        {!encryptionReady && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            The server has no encryption key yet, so storage keys can’t be saved. Restart Kanbanto: it makes one when it starts.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    )

  const set = (k: keyof BucketFields) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
          await onSave({ ...f, secret: f.secret || undefined })
          setEditing(false)
        } catch (err) {
          setError(errorMessage(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="s3-endpoint" className="text-xs">
          Endpoint
        </Label>
        <Input
          id="s3-endpoint"
          value={f.endpoint}
          onChange={set('endpoint')}
          placeholder="https://<account-id>.r2.cloudflarestorage.com"
          className="h-8"
          required
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Cloudflare R2: R2 → Overview → your account’s S3 API address. AWS: https://s3.&lt;region&gt;.amazonaws.com. MinIO and others: the storage’s
          own S3 address.{' '}
          {own
            ? 'It has to be a public https:// address.'
            : 'Files open in people’s browsers straight from this address, so use one their browsers can reach, not a name that only works on the server.'}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="s3-bucket" className="text-xs">
            Bucket
          </Label>
          <Input id="s3-bucket" value={f.bucket} onChange={set('bucket')} placeholder="kanbanto-files" className="h-8" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="s3-region" className="text-xs">
            Region
          </Label>
          <Input id="s3-region" value={f.region} onChange={set('region')} placeholder="Empty (R2, MinIO) or eu-west-1" className="h-8" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="s3-key" className="text-xs">
            Access key ID
          </Label>
          <Input
            id="s3-key"
            value={f.accessKeyId}
            onChange={set('accessKeyId')}
            autoComplete="off"
            spellCheck={false}
            className="h-8 font-mono"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="s3-secret" className="text-xs">
            Secret access key
          </Label>
          <Input
            id="s3-secret"
            type="password"
            value={f.secret}
            onChange={set('secret')}
            autoComplete="off"
            placeholder={bucket ? `Leave empty to keep ${bucket.keyHint}` : ''}
            required={!bucket}
            className="h-8 font-mono"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Use a key that can only read and write this bucket. It’s stored encrypted and never shown again. Files already uploaded stay where they are
        until you move them.
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
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
