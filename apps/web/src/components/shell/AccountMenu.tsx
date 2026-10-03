import { Desktop, MagnifyingGlass, Moon, ShieldCheck, SignOut, Sun, Timer, UserCircle } from '@phosphor-icons/react'
import { navigate } from '@/app/router'
import { useAuth } from '@/app/use-auth'
import { useTheme } from '@/app/use-theme'
import { SEARCH_KEYS } from '@/components/cards/search'
import { Avatar } from '@/components/common/bits'
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

/** Your avatar: search all cards, account, appearance, the platform console (platform admins), sign out. */
export function AccountMenu() {
  const { user, signOut } = useAuth()
  const { theme, setTheme } = useTheme()
  if (!user) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button aria-label="Your account" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <Avatar name={user.name} className="size-8 text-xs" />
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
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
