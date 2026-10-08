// Reactions: answering a comment with an emoji where another comment would only say "ok".
//
// What is kept for a reaction is the emoji itself, so the set people choose from can grow (or become any emoji)
// without anything stored changing. Today it is a short set: one click, and it reads the same to everyone.

/**
 * The emoji a comment can be answered with, in the order they're offered and shown: agreed, thanks, well done,
 * funny, "I'm looking at it", done. (No thumbs down: a "no" deserves words.)
 */
export const REACTIONS = ['👍', '❤️', '🎉', '😄', '👀', '✅'] as const
export type Reaction = (typeof REACTIONS)[number]

/** What each means, for a screen reader and for the button's hint. */
export const REACTION_NAMES: Record<Reaction, string> = {
  '👍': 'Agreed',
  '❤️': 'Thanks',
  '🎉': 'Well done',
  '😄': 'Funny',
  '👀': 'Looking at it',
  '✅': 'Done',
}

export const isReaction = (emoji: string): emoji is Reaction => (REACTIONS as readonly string[]).includes(emoji)

/** One emoji on a comment, with the people who added it, in the order they did. */
export interface ReactionView {
  emoji: string
  by: { id: string; name: string }[]
}

/**
 * Who added a reaction, in words: "You", "Dana and you", "Dana, Priya and Tom", "Dana, Priya and 3 others". The
 * person looking is "you" and comes last (first when alone); first names, as elsewhere where room is short.
 */
export function reactedBy(by: readonly { id: string; name: string }[], me?: string): string {
  const others = by.filter((p) => p.id !== me).map((p) => p.name.split(' ')[0])
  const mine = by.some((p) => p.id === me)
  if (!others.length) return mine ? 'You' : ''
  const shown = others.slice(0, 3)
  const more = others.length - shown.length
  const names = [...shown, ...(more > 0 ? [`${more + (mine ? 1 : 0)} ${more + (mine ? 1 : 0) === 1 ? 'other' : 'others'}`] : mine ? ['you'] : [])]
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
}
