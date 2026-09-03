/**
 * Reading the environment of a live engine process.
 *
 * Two things about a pane are decided at `execve` and readable nowhere else: which endpoint the engine
 * talks to (`gatewayRuntime.ts`) and which grid it was pointed at (`gridAssignment.ts`). Both are
 * questions about the SAME process, so the read lives here and both ask through it — one `ps` per
 * agent, not one per question.
 *
 * Nothing here interprets or stores what it reads. A process environment is the user's business: the
 * callers pick out the handful of variables they have a reason to look at, and the rest is passed
 * through and dropped.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { ProcessIdentity } from './registry.js'

/** NUL-separated `/proc/<pid>/environ`. */
export function parseEnviron(blob: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of blob.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

/**
 * macOS `ps eww -p <pid> -o command=`: argv first, then `KEY=VALUE` pairs, all space-separated with no
 * quoting. A value containing spaces is therefore only recoverable by reading up to the next token that
 * starts a new variable — which is exactly what this does. Leading argv is skipped by the same rule
 * (`--flag=x` cannot start a variable), and the keys we care about never carry spaces anyway.
 */
export function parsePsEnviron(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  let key: string | null = null
  for (const token of line.trim().split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq))) {
      key = token.slice(0, eq)
      out[key] = token.slice(eq + 1)
    } else if (key) {
      out[key] += ` ${token}`
    }
  }
  return out
}

function read(pid: number): Promise<Record<string, string> | null> {
  if (process.platform === 'linux') {
    return readFile(`/proc/${pid}/environ`, 'utf8').then(parseEnviron).catch(() => null)
  }
  return new Promise((resolve) => {
    execFile('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 2_000, maxBuffer: 4 << 20 }, (err, stdout) => {
      resolve(err && !stdout ? null : parsePsEnviron(stdout))
    })
  })
}

/**
 * A process's environment cannot change under it, so a read is permanent — for that process.
 *
 * The TTL is not about the environment changing. It is about having read the WRONG process: a launcher
 * like `ori claude` is discoverable for the ~100ms before it `execve`s the vendor binary away, and on
 * macOS `comm` truncates to 16 characters, so `~/.local/bin/ori` and `~/.local/bin/claude` are the same
 * cache key and the exec is invisible. Expiring the entry closes that window — and every other one like
 * it — for one extra `ps` per agent per minute. See `gatewayRuntime.ts`, where this was measured.
 *
 * A failed read is never cached: "we could not look" must not harden into an answer.
 */
const cache = new Map<string, { env: Record<string, string>; at: number }>()
const CACHE_LIMIT = 256
const TTL_MS = 60_000

export function processEnvCacheKey(identity: ProcessIdentity): string {
  return `${identity.pid}\u0000${identity.startMarker}\u0000${identity.executable}`
}

export function clearProcessEnvCache(): void {
  cache.clear()
}

/** The live environment of `identity`, or null when it could not be read. */
export async function readProcessEnv(identity: ProcessIdentity): Promise<Record<string, string> | null> {
  const key = processEnvCacheKey(identity)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.env
  const env = await read(identity.pid)
  if (!env) return null
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, { env, at: Date.now() })
  return env
}
