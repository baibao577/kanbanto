import { platformAdmins, resetPassword, setPlatformAdmin } from './admins'
import { currentKey, newMasterKey } from './crypto'
import { createDb, migrateDb } from './db'
import { env } from './env'
import { versionWords } from './version'

/**
 * Server-side commands for the platform owner. Platform admin rights are only granted here (never by signing up),
 * so nobody can make themselves an admin through the website.
 *
 *   admin grant <email>    make an existing account a platform admin
 *   admin revoke <email>
 *   admin list
 *   user password <email>  set a temporary password for an account (e.g. you forgot yours and email isn't set up)
 *   key                    print the encryption key in use, to keep a copy (it protects the saved email and storage keys)
 *   secret                 print a new random key, if you'd rather set ENCRYPTION_KEY yourself
 *   version                which Kanbanto this is
 *
 * In development: pnpm admin grant you@example.com
 * In Docker:      docker compose exec app node dist/cli.js admin grant you@example.com
 */
const USAGE = 'Usage: admin grant <email> | admin revoke <email> | admin list | user password <email> | key | secret | version'

const [group, action, email] = process.argv.slice(2)

if (group === 'version') {
  console.log(`Kanbanto ${versionWords()}`)
  process.exit(0)
}

if (group === 'secret') {
  console.log(newMasterKey())
  console.error('To use it, set it as ENCRYPTION_KEY on the server (before saving any keys) and keep a copy somewhere safe.')
  process.exit(0)
}
if (group === 'key') {
  const key = currentKey()
  if (!key) {
    console.error('No encryption key yet: Kanbanto makes one the first time it starts.')
    process.exit(1)
  }
  console.log(key)
  console.error('Keep this somewhere safe (a password manager). To move Kanbanto to a new server, set it there as ENCRYPTION_KEY.')
  process.exit(0)
}

const { db, client } = createDb(env.databaseUrl)
let code = 0
try {
  await migrateDb(db)
  if (group === 'user' && action === 'password' && email) {
    const password = await resetPassword(db, email)
    if (!password) throw new Error(`No account with the email ${email}.`)
    console.log(`Temporary password for ${email}: ${password}`)
    console.log('They’ve been signed out everywhere. After signing in, change it under Account settings → Password.')
  } else if (group !== 'admin') throw new Error(USAGE)
  else if (action === 'list') {
    const admins = await platformAdmins(db)
    console.log(admins.length ? admins.map((a) => `${a.email}  (${a.name})`).join('\n') : 'No platform admins yet.')
  } else if ((action === 'grant' || action === 'revoke') && email) {
    if (!(await setPlatformAdmin(db, email, action === 'grant')))
      throw new Error(`No account with the email ${email}. Sign up on the website first, then run this again.`)
    console.log(action === 'grant' ? `${email} is now a platform admin.` : `${email} is no longer a platform admin.`)
  } else throw new Error(USAGE)
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  code = 1
} finally {
  await client.end()
}
process.exit(code)
