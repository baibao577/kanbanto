import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { env } from './env'
import { HttpError } from './http'

/**
 * Encrypts secrets stored in the database (email keys, mail server and storage passwords) with AES-256-GCM. The
 * master key never goes in the database, so a leaked database or backup doesn't reveal the secrets. Each value gets
 * its own random IV, and the auth tag makes any tampering fail to decrypt.
 *
 * The master key is ENCRYPTION_KEY if set; otherwise one is made on first start and kept in KEY_FILE (a Docker
 * volume), so nobody ends up with a key everyone knows.
 *
 * Stored as `v1.<iv>.<tag>.<ciphertext>` (base64url); the version leaves room to rotate the master key later.
 */

/** The development key from the example settings. It's public, so it protects nothing: never used in production. */
export const DEV_KEY = 'ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE='

/** 32 bytes of base64, or null. */
const parseKey = (b64: string) => {
  const key = Buffer.from(b64.trim(), 'base64')
  return key.length === 32 ? key : null
}

let master: Buffer | null = null

/**
 * Loads the master key at startup: ENCRYPTION_KEY, else the key file, else a new key saved to the key file. Throws
 * with a readable reason if there's no usable key (the server then refuses to start rather than lose secrets).
 */
export function loadMasterKey(): 'env' | 'file' | 'new' {
  if (env.encryptionKey) {
    const key = parseKey(env.encryptionKey)
    if (!key) throw new Error('ENCRYPTION_KEY isn’t valid: it must be 32 random bytes in base64 (make one with `node dist/cli.js secret`).')
    if (env.production && env.encryptionKey.trim() === DEV_KEY)
      throw new Error('ENCRYPTION_KEY is the public development key. Remove it to have Kanbanto make its own, or set your own.')
    master = key
    return 'env'
  }
  const file = path.resolve(env.keyFile)
  if (existsSync(file)) {
    const key = parseKey(readFileSync(file, 'utf8'))
    if (!key) throw new Error(`The encryption key in ${file} isn’t valid (it must be 32 bytes in base64).`)
    master = key
    return 'file'
  }
  const fresh = randomBytes(32)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${fresh.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(file, 0o600)
  } catch (e) {
    throw new Error(
      `Couldn’t save a new encryption key to ${file} (${e instanceof Error ? e.message : e}). Set ENCRYPTION_KEY, or point KEY_FILE at a folder Kanbanto can write to.`,
    )
  }
  master = fresh
  return 'new'
}

/** The key in use (for `cli.js key`, so people can keep a copy): ENCRYPTION_KEY or the key file. */
export function currentKey(): string | null {
  if (env.encryptionKey) return env.encryptionKey.trim()
  const file = path.resolve(env.keyFile)
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
}

function masterKey(): Buffer {
  // Tests and one-off scripts don't call loadMasterKey(): they use ENCRYPTION_KEY directly.
  if (!master && env.encryptionKey) master = parseKey(env.encryptionKey)
  if (!master) throw new HttpError(503, 'Keys can’t be saved until the server has an encryption key. Restart Kanbanto to make one.')
  return master
}

/** Whether secrets can be stored. */
export function encryptionReady() {
  try {
    masterKey()
    return true
  } catch {
    return false
  }
}

export function encrypt(plain: string, key: Buffer = masterKey()): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

export function decrypt(stored: string, key: Buffer = masterKey()): string {
  const [version, iv, tag, data] = stored.split('.')
  if (version !== 'v1' || data === undefined) throw new Error('Unreadable secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}

/**
 * Secrets saved while the public development key was in use are re-encrypted with the real key, so upgrading an
 * install that ran on the old default keeps its saved keys working. Returns how many were moved, and how many can't
 * be read with either key (those have to be entered again).
 */
export function reencryptFromDevKey(secrets: { id: string; value: string }[]): { moved: { id: string; value: string }[]; unreadable: number } {
  const key = masterKey()
  const dev = parseKey(DEV_KEY)!
  const moved: { id: string; value: string }[] = []
  let unreadable = 0
  if (key.equals(dev)) return { moved, unreadable }
  for (const s of secrets) {
    try {
      decrypt(s.value, key)
      continue
    } catch {
      // Not ours: maybe the old public key.
    }
    try {
      moved.push({ id: s.id, value: encrypt(decrypt(s.value, dev), key) })
    } catch {
      unreadable++
    }
  }
  return { moved, unreadable }
}

/** What people see instead of a key: its start and last four characters. */
export const keyHint = (key: string) => `${key.slice(0, 3)}…${key.slice(-4)}`

/** A new master key, for ENCRYPTION_KEY. */
export const newMasterKey = () => randomBytes(32).toString('base64')
