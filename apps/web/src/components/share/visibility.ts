import { Globe, LockSimple, UsersThree } from '@phosphor-icons/react'
import type { Visibility } from '@kanbanto/model/api'

/** Who can open a board, in words. */
export const VISIBILITY: Record<Visibility, { icon: typeof Globe; title: string; label: string; hint: string }> = {
  private: {
    icon: LockSimple,
    title: 'Private',
    label: 'Private: only owners can open it',
    hint: 'Only the board’s owners can open it. People you invited keep their place, but can’t open it until you share it again.',
  },
  invited: {
    icon: UsersThree,
    title: 'Invited people',
    label: 'Invited people can open it',
    hint: 'People you add or who join with the link or code.',
  },
  public: {
    icon: Globe,
    title: 'Public',
    label: 'Public: anyone with the link can view it',
    hint: 'Anyone with the board’s address can view it, even without an account. Only invited people can change it.',
  },
}
