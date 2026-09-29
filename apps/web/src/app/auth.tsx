import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Me, PublicUser } from '@kanbanto/model/api'
import { api, errorMessage, VERIFY_EVENT } from '@/api/client'
import { AuthContext, type AuthValue } from './use-auth'

/** Who's signed in. Renders nothing until that's known (one quick request). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(
    () =>
      api<Me>('GET', '/auth/me').then(
        (m) => {
          setMe(m)
          setError(null)
        },
        (e) => setError(errorMessage(e)),
      ),
    [],
  )
  useEffect(() => {
    api<Me>('GET', '/auth/me').then(setMe, (e) => setError(errorMessage(e)))
    // Coming back to the tab: pick up changes made elsewhere (signed out on another device, admin rights granted,
    // email confirmed in another tab). Also when the server says the email needs confirming.
    const onChange = () => void refresh()
    window.addEventListener('focus', onChange)
    window.addEventListener(VERIFY_EVENT, onChange)
    return () => {
      window.removeEventListener('focus', onChange)
      window.removeEventListener(VERIFY_EVENT, onChange)
    }
  }, [refresh])

  const value = useMemo<AuthValue | null>(
    () =>
      me && {
        ...me,
        // Same rule as the server: once the site sends email, confirm yours (platform admins are exempt).
        mustVerify: !!me.user && !me.user.emailVerified && me.emailEnabled && !me.user.isAdmin,
        refresh,
        signIn: async (email, password) => {
          const { user } = await api<{ user: PublicUser }>('POST', '/auth/signin', { email, password })
          setMe({ ...me, user })
        },
        signUp: async (fields) => {
          const r = await api<{ user: PublicUser; boardId: string | null } | { checkEmail: true }>('POST', '/auth/signup', fields)
          if ('checkEmail' in r) return r
          setMe({ ...me, user: r.user })
          return { boardId: r.boardId }
        },
        signOut: async () => {
          await api('POST', '/auth/signout')
          setMe({ ...me, user: null })
        },
        setUser: (user) => setMe({ ...me, user }),
      },
    [me, refresh],
  )

  if (error && !me)
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-sm">
          <p className="text-base font-semibold">Kanbanto can’t reach its server</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
          <button onClick={() => void refresh()} className="mt-4 text-sm font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      </div>
    )
  if (!value) return null
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
