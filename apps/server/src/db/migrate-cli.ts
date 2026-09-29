import { env } from '../env'
import { createDb, migrateDb } from './index'

const { db, client } = createDb(env.databaseUrl)
await migrateDb(db)
await client.end()
console.log('Database is up to date.')
