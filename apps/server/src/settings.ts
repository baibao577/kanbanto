import { eq } from 'drizzle-orm'
import type { Db, Tx } from './db'
import { SETTING_DEFAULTS } from './db/defaults'
import { siteSettings } from './db/schema'

export type SiteSettings = typeof siteSettings.$inferSelect

/** The site's settings: the saved row, or the defaults when nothing's been saved yet. */
export async function loadSettings(db: Db | Tx): Promise<SiteSettings> {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, 1))
  return row ?? { id: 1, ...SETTING_DEFAULTS }
}
