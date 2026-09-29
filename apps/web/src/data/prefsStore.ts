import { defaultPrefs, type ViewPrefs } from '@kanbanto/model/prefs'
import { ViewPrefsSchema } from '@kanbanto/model/schema'

/** Per-board view settings for this person (kept on this device; they aren't board data). */
export const prefsKey = (boardId: string) => `kankan:v3:prefs:${boardId}`
/** Where the single-board version kept view settings (moved per board on first run). */
export const legacyPrefsKey = 'kankan:v3:prefs'

export interface PrefsStore {
  load(): ViewPrefs | null
  save(prefs: ViewPrefs): void
}

export function prefsStoreFor(boardId: string, storage: Storage = localStorage): PrefsStore {
  const key = prefsKey(boardId)
  return {
    load() {
      try {
        const raw = storage.getItem(key)
        if (!raw) return null
        // Missing settings (older or partial saves) take their defaults; broken ones fall back entirely.
        const parsed = ViewPrefsSchema.safeParse({ ...defaultPrefs(), ...JSON.parse(raw), version: 3 })
        return parsed.success ? (parsed.data as ViewPrefs) : null
      } catch {
        return null
      }
    },
    save(prefs) {
      try {
        storage.setItem(key, JSON.stringify(prefs))
      } catch {
        // View settings are a convenience; if they can't be saved, the board still works.
      }
    },
  }
}
