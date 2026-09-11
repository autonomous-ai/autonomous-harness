import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../config/env.js'

const PREFIX = 'v1'

function key(): Buffer {
  const value = Buffer.from(env.HARNESS_CREDENTIAL_ENCRYPTION_KEY, 'base64')
  if (value.length !== 32) throw new Error('Machine credential encryption key is not configured')
  return value
}

/** AES-256-GCM envelope: version.iv.tag.ciphertext (all binary values are base64url). */
export function encryptMachineCredential(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function decryptMachineCredential(envelope: string): string {
  const [version, ivRaw, tagRaw, bodyRaw, extra] = envelope.split('.')
  if (version !== PREFIX || !ivRaw || !tagRaw || !bodyRaw || extra) throw new Error('Invalid machine credential envelope')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivRaw, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(bodyRaw, 'base64url')), decipher.final()]).toString('utf8')
}
