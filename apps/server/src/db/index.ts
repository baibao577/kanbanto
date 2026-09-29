import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { fileURLToPath } from 'node:url'
import * as schema from './schema'

export type Db = ReturnType<typeof createDb>['db']
/** A transaction, or the database itself: queries work the same on both. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} })
  return { db: drizzle(client, { schema }), client }
}

/** Brings the database schema up to date (runs on startup; safe to run repeatedly). */
export async function migrateDb(db: Db) {
  // Next to src/ in development, next to dist/ in production.
  const folder = fileURLToPath(new URL('../../drizzle', import.meta.url))
  const fallback = fileURLToPath(new URL('../drizzle', import.meta.url))
  const { existsSync } = await import('node:fs')
  await migrate(db, { migrationsFolder: existsSync(folder) ? folder : fallback })
}
