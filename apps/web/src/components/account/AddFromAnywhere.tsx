import { ArrowSquareOut, BookmarkSimple } from '@phosphor-icons/react'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { hrefFor } from '@/app/router'
import { PageTitle, SettingsCard } from '@/components/settings/SettingsCard'
import { bookmarkCode } from '@/lib/shared'

/**
 * Ways to put something in your Inbox without opening Kanbanto first: a button for the browser's bookmarks bar, Share
 * on an Android phone, and a call for other apps.
 */
export function AddFromAnywhere() {
  const button = useRef<HTMLAnchorElement>(null)
  // (React won't write a link that runs code, so the button's is set on the page itself.)
  useEffect(() => {
    button.current?.setAttribute('href', bookmarkCode(location.origin))
  }, [])
  return (
    <div className="space-y-6">
      <PageTitle title="Add from anywhere" description="Put something in your Inbox from wherever you are, and sort it out later." />
      <SettingsCard
        title="A button for your bookmarks bar"
        description="On any page, one click opens a small window with the page’s title and address, and any words you had selected, ready to add."
      >
        <div className="flex flex-wrap items-center gap-3">
          <a
            ref={button}
            draggable
            onClick={(e) => {
              e.preventDefault()
              toast('Drag this button to your bookmarks bar', { description: 'Then click it on any page you want to keep.' })
            }}
            className="inline-flex h-9 cursor-grab items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 text-sm font-medium active:cursor-grabbing"
          >
            <BookmarkSimple className="size-4" /> Add to Kanbanto
          </a>
          <span className="text-xs text-muted-foreground">← drag this to your bookmarks bar</span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Can’t see the bookmarks bar? In most browsers: View → Show Bookmarks Bar. The button holds no password: it works while you are signed in to
          Kanbanto in this browser, and nothing is saved until you press Add in the little window. A few sites stop buttons like this from running;
          there, copy the address and paste it into your Inbox.
        </p>
      </SettingsCard>
      <SettingsCard title="From your phone" description="On Android, Kanbanto can be in the list of apps that things are shared to.">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Open Kanbanto in Chrome on the phone, and choose “Add to Home screen” (or “Install app”) from Chrome’s menu.</li>
          <li>In any app, tap Share and pick Kanbanto.</li>
          <li>Check the title, and press Add.</li>
        </ol>
        <p className="text-xs leading-relaxed text-muted-foreground">
          It takes links and text. This needs Chrome on Android: Firefox, and Safari on an iPhone, don’t offer a web app in their share list. There,
          open{' '}
          <a href={hrefFor({ page: 'add' })} className="text-primary hover:underline">
            the add page
          </a>{' '}
          and paste.
        </p>
      </SettingsCard>
      <SettingsCard title="From another app or a script" description="One call adds a card to your Inbox, or to a board, with plain names.">
        <p className="text-sm">
          For n8n, Zapier, Make, a shortcut or a program of your own. It needs an API token (Account settings → API & apps).{' '}
          <a href="/api/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            How to call it <ArrowSquareOut className="size-3" />
          </a>
        </p>
      </SettingsCard>
    </div>
  )
}
