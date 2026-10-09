/** People writing a card's description at this moment (see liveDoc.ts), in words and colours. */
export type Writer = { id: string; name: string }

/** Colours that are easy to tell apart, each dark enough for white letters on it. */
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f', '#0f766e', '#9a3412']
/**
 * The colour someone's cursor has, for everyone: their place among the board's people decides it, so two people on
 * a board of ten or fewer never share one, and every browser comes to the same answer. (Someone who isn't among
 * them, or no list given: by their id.)
 */
export function colorFor(userId: string, people: { id: string }[] = []) {
  const at = people
    .map((p) => p.id)
    .sort()
    .indexOf(userId)
  if (at >= 0) return COLORS[at % COLORS.length]
  let n = 0
  for (const ch of userId) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[n % COLORS.length]
}

/** "Ann", "Ann and Ben", "Ann, Ben and 2 others". */
export function namesOf(people: Writer[]) {
  const names = people.map((p) => p.name)
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`
}
