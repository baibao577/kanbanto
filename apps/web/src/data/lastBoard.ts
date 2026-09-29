/** The board you had open last on this device, per account (to reopen it when you visit the bare address). */
const key = (userId: string) => `kankan:v4:last:${userId}`

export function lastBoard(userId: string): string | null {
  try {
    return localStorage.getItem(key(userId))
  } catch {
    return null
  }
}

export function rememberBoard(userId: string, boardId: string) {
  try {
    localStorage.setItem(key(userId), boardId)
  } catch {
    // Only a convenience.
  }
}
