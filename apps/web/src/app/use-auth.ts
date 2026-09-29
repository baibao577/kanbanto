import { createContext, useContext } from 'react'
import type { Me, PublicUser } from '@kanbanto/model/api'

export interface AuthValue extends Me {
  /** Signed in, but has to confirm their email before using the app. */
  mustVerify: boolean
  signIn: (email: string, password: string) => Promise<void>
  /**
   * Returns the board joined through `invite`, if any — or `checkEmail` when the site sends email and the new account
   * has to confirm its address first (you're signed in by the link in that email).
   */
  signUp: (fields: { name: string; email: string; password: string; invite?: string }) => Promise<{ boardId: string | null } | { checkEmail: true }>
  signOut: () => Promise<void>
  setUser: (user: PublicUser) => void
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
