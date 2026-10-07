import { buildApp } from './app'
import { deleteExpiredTokens } from './auth/apiTokens'
import { tidyOAuth } from './oauth'
import { pruneActivity } from './boards/engine'
import { deleteExpiredSessions } from './auth/sessions'
import { loadMasterKey } from './crypto'
import { createDb, migrateDb } from './db'
import { env } from './env'
import { loggable } from './errors'
import { sendDigests } from './mail/digest'
import { sendReminders } from './reminders'
import { logTransport } from './mail/transport'
import { tidyFiles } from './routes/files'
import { moveSecretsOffDevKey } from './secrets'
import { versionWords } from './version'

/** A problem that stops Kanbanto from starting: said in one line, without a stack trace. */
function fail(message: string): never {
  console.error(`Kanbanto can’t start: ${message}`)
  process.exit(1)
}
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))

if (env.production && !env.appUrl)
  fail('APP_URL isn’t set. Set it to the address people use to open Kanbanto, like https://kanbanto.example.com (see docs/configuration.md).')
if (env.production && /\/\/kankan:kankan@/.test(env.databaseUrl))
  console.warn('The database still has the default password (kankan). Set POSTGRES_PASSWORD (see docs/self-hosting.md).')
let keySource: ReturnType<typeof loadMasterKey>
try {
  keySource = loadMasterKey()
} catch (e) {
  fail(reason(e))
}

const { db, client } = createDb(env.databaseUrl)
try {
  await migrateDb(db)
} catch (e) {
  fail(`couldn’t reach or update the database (${reason(e)}). Check DATABASE_URL and that PostgreSQL is running.`)
}
const secrets = await moveSecretsOffDevKey(db)
const app = await buildApp(db, {
  logger: true,
  mailWorker: true,
  transport: env.mailTransport === 'log' ? logTransport() : undefined,
}).catch((e) => fail(reason(e)))

if (keySource === 'new')
  app.log.info(`Made a new encryption key and saved it in ${env.keyFile}. Keep a copy somewhere safe: \`node dist/cli.js key\` shows it.`)
if (secrets.moved) app.log.info(`Re-encrypted ${secrets.moved} saved key(s) that used the public development key.`)
if (secrets.unreadable)
  app.log.warn(
    `${secrets.unreadable} saved key(s) can’t be read with this encryption key (it changed or was lost). Enter them again: Platform console → Email / Storage, or Account settings.`,
  )
if (env.mailTransport === 'log') app.log.warn('MAIL_TRANSPORT=log: emails are printed here, not sent.')
else if (app.mail.serverSender)
  app.log.info(`Email: sending through ${app.mail.serverSender.keyHint} (SMTP_URL). Try it with Platform console → Email → Send it to me.`)

const cleanup = setInterval(
  () => {
    void deleteExpiredSessions(db).catch(() => {})
    void app.mail.prune().catch(() => {})
    void app.webhooks.prune().catch(() => {})
    void deleteExpiredTokens(db).catch(() => {})
    void tidyOAuth(db).catch(() => {})
    void pruneActivity(db).catch(() => {})
    void tidyFiles(app).catch((e) => app.log.error({ err: loggable(e) }, 'tidying files'))
  },
  6 * 60 * 60 * 1000,
)
// Morning summaries (~8:00 in each person's time zone): checked every 10 minutes, at most one a day each.
// Reminders whose moment has come: checked every minute.
const reminders = setInterval(() => void sendReminders(app).catch((e) => app.log.error({ err: loggable(e) }, 'reminders')), 60 * 1000)
const digests = setInterval(() => void sendDigests(app).catch((e) => app.log.error({ err: loggable(e) }, 'morning summaries')), 10 * 60 * 1000)
const shutdown = async () => {
  clearInterval(cleanup)
  clearInterval(reminders)
  clearInterval(digests)
  await app.close()
  await client.end()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await app.listen({ port: env.port, host: env.host })
app.log.info(`Kanbanto ${versionWords()}`)
