import { createHash, randomBytes, randomInt } from 'crypto'
import type { IncomingMessage } from 'http'

/** The agent api-key from an HTTP header (`x-api-key`) or the first WS subprotocol token. */
export function extractKey(req: IncomingMessage): string | undefined {
  const header = req.headers['x-api-key']
  if (typeof header === 'string' && header) return header
  const proto = req.headers['sec-websocket-protocol']
  if (typeof proto === 'string' && proto) return proto.split(',')[0]?.trim()
  return undefined
}

/** A fresh per-agent api key: 32 random bytes, hex (64 chars, ≥16 required by the manager). */
export function generateApiKey(): string {
  return randomBytes(32).toString('hex')
}

/** sha256(value) as hex — deterministic lookup hash for high-entropy secrets (device tokens/codes). */
export function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** A short human pairing code from an unambiguous alphabet (no 0/O/1/I/L). Default 6 chars. */
export function generateUserCode(len = 6): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[randomInt(alphabet.length)]
  return out
}

/**
 * A random DNS-safe subdomain label: first char a letter, rest lowercase alnum. Default 12 chars.
 * The user never picks a subdomain — the backend generates one at register (collision-retried).
 */
export function generateSubdomain(len = 12): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = letters[randomInt(letters.length)]
  for (let i = 1; i < len; i++) out += alnum[randomInt(alnum.length)]
  return out
}

/**
 * machineId = sha256(apiKey)[:32] — IDENTICAL to the agent-manager's derivation
 * (`utils/crypto.ts`), so the id the backend stores matches the manager's record.
 */
export function machineIdFromKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}
