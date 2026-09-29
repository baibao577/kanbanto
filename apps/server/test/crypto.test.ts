import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { newId } from '@kanbanto/model/ids'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { currentKey, decrypt, DEV_KEY, encrypt, loadMasterKey } from '../src/crypto'
import { emailSenders } from '../src/db/schema'
import { env } from '../src/env'
import { moveSecretsOffDevKey } from '../src/secrets'
import { reset, setup } from './helpers'

let t: Awaited<ReturnType<typeof setup>>
beforeAll(async () => (t = await setup()))
beforeEach(async () => reset(t.db))
afterAll(async () => t.close())

const saved = { encryptionKey: env.encryptionKey, keyFile: env.keyFile, production: env.production }
afterEach(() => Object.assign(env, saved))

describe('the encryption key', () => {
  it('is made on first start and kept in the key file, readable only by its owner', () => {
    env.encryptionKey = undefined
    env.keyFile = path.join(mkdtempSync(path.join(tmpdir(), 'kanbanto-key-')), 'config', 'encryption.key')
    expect(loadMasterKey()).toBe('new')
    const key = readFileSync(env.keyFile, 'utf8').trim()
    expect(Buffer.from(key, 'base64')).toHaveLength(32)
    expect(statSync(env.keyFile).mode & 0o777).toBe(0o600)
    expect(currentKey()).toBe(key)
    // The next start uses the same key.
    expect(loadMasterKey()).toBe('file')
    expect(decrypt(encrypt('secret'))).toBe('secret')
  })

  it('the public development key is refused in production', () => {
    env.production = true
    env.encryptionKey = DEV_KEY
    expect(() => loadMasterKey()).toThrow(/public development key/)
    env.encryptionKey = 'too-short'
    expect(() => loadMasterKey()).toThrow(/isn’t valid/)
  })

  it('secrets saved with the public development key move to the real key', async () => {
    const dev = Buffer.from(DEV_KEY, 'base64')
    const id = newId()
    await t.db.insert(emailSenders).values({
      id,
      userId: null,
      provider: 'resend',
      apiKeyEncrypted: encrypt('re_saved_with_the_old_default', dev),
      keyHint: 're_…ault',
      fromAddress: 'Kanbanto <noreply@example.com>',
    })
    const r = await moveSecretsOffDevKey(t.db)
    expect(r.moved).toBe(1)
    const [row] = await t.db.select().from(emailSenders)
    expect(decrypt(row.apiKeyEncrypted)).toBe('re_saved_with_the_old_default')
    expect(() => decrypt(row.apiKeyEncrypted, dev)).toThrow()
    // Running again changes nothing.
    expect((await moveSecretsOffDevKey(t.db)).moved).toBe(0)
  })
})
