import { toast } from 'sonner'
import type { AccountStorage } from '@kanbanto/model/api'
import { api } from '@/api/client'
import { BucketForm } from '@/components/email/BucketForm'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { formatSize } from '@/lib/format'
import { useLoaded } from '@/data/useLoaded'

const fetchStorage = () => api<AccountStorage>('GET', '/account/storage')

/** Account settings → File storage: space used on your boards, or your own bucket (no limit). */
export function AccountStorageSection() {
  const [info, reload] = useLoaded(fetchStorage)
  if (!info) return null

  const pct = info.quota ? Math.min(100, Math.round((info.used / info.quota) * 100)) : 100
  return (
    <div className="space-y-6">
      <PageTitle title="File storage" description="Where files attached to cards on your boards are kept." />
      {!info.bucket && (
        <SettingsCard
          title="Space used"
          description={`All the files on all the boards you own count toward this one total, whoever attached them. Each file can be up to ${formatSize(info.maxFile)}.`}
        >
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Used</span>
              <span className="tabular-nums">
                {formatSize(info.used)} of {formatSize(info.quota)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-foreground/8">
              <div className={pct >= 90 ? 'h-full rounded-full bg-amber-500' : 'h-full rounded-full bg-primary'} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </SettingsCard>
      )}
      <SettingsCard
        title="Your own bucket"
        description={
          info.bucket
            ? 'Files on boards you own go to your own bucket, with no limit.'
            : 'Connect an S3-compatible bucket (Cloudflare R2, AWS S3…) for unlimited space on your boards.'
        }
      >
        <BucketForm
          key={info.bucket?.updatedAt ?? 'none'}
          bucket={info.bucket}
          encryptionReady={info.encryptionReady}
          defaultLabel="Kanbanto’s storage"
          onSave={async (fields) => {
            await api('PUT', '/account/storage/bucket', fields)
            toast('Bucket connected. New files on your boards go there.')
            await reload()
          }}
          onRemove={async () => {
            await api('DELETE', '/account/storage/bucket')
            toast('New files will use Kanbanto’s storage again. Files already in your bucket stay there.')
            await reload()
          }}
        />
      </SettingsCard>
    </div>
  )
}
