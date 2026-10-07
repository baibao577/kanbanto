import { ArrowSquareOut, BookOpenText, Desktop, MagnifyingGlass, Moon, ShieldCheck, SignOut, Sun, Timer, UserCircle } from '@phosphor-icons/react'
import { navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { useTheme } from '@/app/use-theme'
import { SEARCH_KEYS } from '@/components/cards/search'
import { Avatar } from '@/components/common/bits'
import { formatShortDay } from '@/lib/format'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Your avatar: search all cards, your week, the guides, account, appearance, the platform console (platform admins),
 * sign out, and which Kanbanto this is.
 */
export function AccountMenu() {
  const { user, signOut, guidesUrl, version } = useAuth()
  const { theme, setTheme } = useTheme()
  if (!user) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button aria-label="Your account" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <Avatar name={user.name} picture={user.picture} className="size-8 text-xs" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <span className="block truncate text-sm font-medium">{user.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate({ page: 'cards', state: 'active' })}>
            <MagnifyingGlass /> Search all cards
            <DropdownMenuShortcut>{SEARCH_KEYS}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate({ page: 'time' })}>
            <Timer /> My week
          </DropdownMenuItem>
          {guidesUrl && (
            <DropdownMenuItem asChild>
              {/* (How to use Kanbanto: another site, so it opens beside the app.) */}
              <a href={guidesUrl} target="_blank" rel="noreferrer">
                <BookOpenText /> Guides
                <ArrowSquareOut className="ml-auto size-3.5 text-muted-foreground" />
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => navigate({ page: 'account' })}>
            <UserCircle /> Account settings
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Desktop />}
              Appearance
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">Match my system</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {user.isAdmin && (
            <DropdownMenuItem onSelect={() => navigate({ page: 'admin' })}>
              <ShieldCheck /> Platform console
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              void signOut().then(() => {
                navigate({ page: 'signin' }, { replace: true })
              })
            }
          >
            <SignOut /> Sign out
          </DropdownMenuItem>
          {version && (
            // Which Kanbanto this is, for when something needs reporting: the release, and the day this copy was built.
            <p className="truncate px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
              Kanbanto {version.number}
              {version.built && ` · ${formatShortDay(version.built)}`}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
