import { Buildings, Globe, LockSimple, UsersThree } from '@phosphor-icons/react'
import type { Visibility } from '@kanbanto/model/api'

/** Who can open a board, in words. `workspace` is completed with the workspace's name where it's known. */
export const VISIBILITY: Record<Visibility, { icon: typeof Globe; title: string; label: string; hint: string; short: string }> = {
  workspace: {
    icon: Buildings,
    title: 'Everyone in the workspace',
    label: 'Everyone in its workspace can open it',
    hint: 'Everyone in the workspace can open it without being invited, and so can people you add.',
    short: 'Everyone in the workspace, and people added',
  },
  invited: {
    icon: UsersThree,
    title: 'Only people added',
    label: 'Only people added can open it',
    hint: 'People you add, or who join with the link or code.',
    short: 'Only the people with access above',
  },
  private: {
    icon: LockSimple,
    title: 'Private',
    label: 'Private: only owners can open it',
    hint: 'Only the board’s owners can open it. People you added keep their place, but can’t open it until you share it again.',
    short: 'Only owners. People added keep their place for later',
  },
}

/** A board's setting in words (falling back to "Only people added" for a value this version doesn't know). */
export const visibilityOf = (v: string) => VISIBILITY[v as Visibility] ?? VISIBILITY.invited

/** The switch on top of any of those (not while private). */
export const PUBLIC_LINK = {
  icon: Globe,
  title: 'Anyone with the link can view',
  label: 'Anyone with the link can view it',
  hint: 'Even without an account: they see its cards, comments and files. Only people who can open it otherwise can change it.',
}
