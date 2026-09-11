import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

// Format: "scrypt$<saltHex>$<hashHex>". Built-in scrypt → no native dependency.
const KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const dk = scryptSync(password, salt, KEYLEN)
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const dk = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === dk.length && timingSafeEqual(expected, dk)
}
