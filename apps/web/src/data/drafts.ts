/**
 * What's being written and not saved yet (a card's description), kept in this browser so a reload, a closed tab or a
 * crash doesn't lose it. One draft per thing written (`id`); it goes once the text is saved or thrown away.
 */

export interface Draft {
  text: string
  /** When it was last typed in (ms). */
  at: number
}

const PREFIX = 'kankan:draft:'
/** A draft nobody came back to is dropped after this long. */
const KEEP_MS = 30 * 86_400_000

export function readDraft(id: string): Draft | null {
  try {
    const raw = localStorage.getItem(PREFIX + id)
    const d = raw ? (JSON.parse(raw) as Partial<Draft>) : null
    return d && typeof d.text === 'string' && typeof d.at === 'number' ? { text: d.text, at: d.at } : null
  } catch {
    return null
  }
}

export function writeDraft(id: string, text: string, now = Date.now()) {
  try {
    localStorage.setItem(PREFIX + id, JSON.stringify({ text, at: now } satisfies Draft))
  } catch {
    // No room, or storage is off: the text is only as safe as the open page, as before.
  }
}

export function clearDraft(id: string) {
  try {
    localStorage.removeItem(PREFIX + id)
  } catch {
    // Nothing to clear.
  }
}

/** Drops the drafts nobody came back to (called when the app opens). */
export function pruneDrafts(now = Date.now()) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PREFIX)) continue
      const d = readDraft(key.slice(PREFIX.length))
      if (!d || now - d.at > KEEP_MS) localStorage.removeItem(key)
    }
  } catch {
    // Storage is off.
  }
}
