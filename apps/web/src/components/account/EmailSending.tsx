import { toast } from 'sonner'
import type { AccountEmail, EmailSender } from '@kanbanto/model/api'
import { api } from '@/api/client'
import { useAuth } from '@/app/use-auth'
import { EmailKeyForm } from '@/components/email/EmailKeyForm'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { useLoaded } from '@/data/useLoaded'

const fetchEmail = () => api<AccountEmail>('GET', '/account/email')

/** Account settings → Email sending: invite emails with the site's allowance, or your own Resend key. */
export function AccountEmailSection() {
  const { user } = useAuth()
  const [info, reload] = useLoaded(fetchEmail)

  if (!info || !user) return null
  const { used, limit } = info.allowance
  return (
    <div className="space-y-6">
      <PageTitle title="Email sending" description="How the board invites you send by email go out." />
      <SettingsCard
        title={info.sender ? 'Using your own Resend key' : 'Using this site’s email'}
        description={
          info.sender
            ? 'Your invites go out from your address, on your own Resend account, with no monthly limit.'
            : info.platformReady
              ? limit === null
                ? 'Your invites use this site’s email. You can also add your own Resend key to send them from your own domain.'
                : `Your invites use this site’s email: ${Math.max(0, limit - used)} of ${limit} left this month. Add your own Resend key to send from your domain with no limit.`
              : 'This site doesn’t send email yet. Add your own Resend key to send invites by email.'
        }
      >
        <EmailKeyForm
          sender={info.sender}
          encryptionReady={info.encryptionReady}
          testRecipient={user.email}
          fromPlaceholder={`${user.name} <you@yourdomain.com>`}
          onSave={async (fields) => {
            await api<EmailSender>('PUT', '/account/email/sender', fields)
            toast('Saved. A test email is on its way to you.')
            await reload()
          }}
          onRemove={async () => {
            await api('DELETE', '/account/email/sender')
            toast('Your email key was removed.')
            await reload()
          }}
        />
      </SettingsCard>
    </div>
  )
}
