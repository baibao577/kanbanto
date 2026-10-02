import { useState } from 'react'
import { toast } from 'sonner'
import type { PlatformStorage } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { BucketForm } from '@/components/email/BucketForm'
import { StoragePlaces } from '@/components/email/StoragePlaces'
import { useLoaded } from '@/data/useLoaded'
import { formatSize } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'

const fetchStorage = () => api<PlatformStorage>('GET', '/admin/storage')

/** Platform console → Storage: where attachments go (this server's disk, or an S3/R2 bucket), and the limits. */
export function StorageSettings() {
  const [info, reload] = useLoaded(fetchStorage)
  if (!info) return null

  return (
    <div className="space-y-6">
      <PageTitle title="Storage" description="Where card attachments are kept, and how much space people get." />
      <SettingsCard
        title="Where files are kept"
        description="Switching doesn’t move files already uploaded: they keep opening from where they were saved, and can be moved afterwards."
      >
        <BucketForm
          key={info.bucket?.updatedAt ?? 'disk'}
          bucket={info.bucket}
          encryptionReady={info.encryptionReady}
          defaultLabel="This server’s disk (the Docker volume)"
          onSave={async (fields) => {
            await api('PUT', '/admin/storage/bucket', fields)
            toast('Bucket saved. New files go there.')
            await reload()
          }}
          onRemove={async () => {
            await api('DELETE', '/admin/storage/bucket')
            toast('New files go to this server’s disk again.')
            await reload()
          }}
        />
        <p className="text-xs text-muted-foreground">
          {info.usage.files.toLocaleString()} {info.usage.files === 1 ? 'file' : 'files'} · {formatSize(info.usage.bytes)} in total ·{' '}
          {info.usage.ownStorage === 1 ? '1 person uses' : `${info.usage.ownStorage} people use`} their own bucket
        </p>
        <StoragePlaces
          base="/admin/storage"
          places={info.elsewhere}
          move={info.move}
          target={info.bucket ? `the bucket “${info.bucket.bucket}”` : 'this server’s disk'}
          onChanged={reload}
        />
      </SettingsCard>
      <SettingsCard title="Limits" description="People can connect their own bucket (in their Account settings) for unlimited space on their boards.">
        <Limits key={JSON.stringify(info.settings)} settings={info.settings} onSaved={reload} />
      </SettingsCard>
    </div>
  )
}

function Limits({ settings, onSaved }: { settings: PlatformStorage['settings']; onSaved: () => void }) {
  const [v, setV] = useState(settings)
  const changed = v.quotaMb !== settings.quotaMb || v.maxFileMb !== settings.maxFileMb
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await api('PATCH', '/admin/storage/settings', v)
          toast('Limits saved')
          onSaved()
        } catch (err) {
          toast.error(errorMessage(err))
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="quota" className="text-xs">
            Space per person (MB)
          </Label>
          <Input
            id="quota"
            type="number"
            min={0}
            value={v.quotaMb}
            onChange={(e) => setV({ ...v, quotaMb: Number(e.target.value) })}
            className="h-8"
          />
          <p className="text-[11px] text-muted-foreground">
            In total, across all the boards they own (whoever attached the files). Their own bucket has no limit.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="maxfile" className="text-xs">
            Largest file (MB)
          </Label>
          <Input
            id="maxfile"
            type="number"
            min={1}
            max={200}
            value={v.maxFileMb}
            onChange={(e) => setV({ ...v, maxFileMb: Number(e.target.value) })}
            className="h-8"
          />
          <p className="text-[11px] text-muted-foreground">Applies everywhere, own buckets included.</p>
        </div>
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={!changed}>
        Save limits
      </Button>
    </form>
  )
}
