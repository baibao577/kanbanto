const RELOADED_KEY = 'kankan:reloaded-for-update'

/** The app was updated while this tab was open, so a part it loads on demand no longer exists. */
export const isStaleChunk = (e: unknown) =>
  e instanceof Error && /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(e.message)

/**
 * Reloads once to pick up a new version of the app (after an update, parts of the old one are gone). Returns false
 * if it just did, so a real problem can't turn into a reload loop.
 */
export function reloadForUpdate(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY) ?? 0)
    if (Date.now() - last < 30_000) return false
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()))
  } catch {
    // No storage: reload anyway (at worst once per click).
  }
  location.reload()
  return true
}
