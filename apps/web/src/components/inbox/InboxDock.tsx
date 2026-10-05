import { useInbox } from '@/app/use-inbox'

/** Where the Inbox panel goes on a page: at the left of what's beside it, taking no room while it's closed. */
export function InboxDock() {
  const { setDock } = useInbox()
  return <div ref={setDock} className="flex min-h-0 shrink-0" />
}
