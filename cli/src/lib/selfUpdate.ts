/**
 * Self-update mechanics — PURE (no process-control; the daemon decides when to restart).
 *
 * The daemon polls a GCS `metadata.json` (same shape as the device OTA manifest), and when a strictly
 * newer build is published it downloads `cli.js` + `notify.mjs`, verifies sha256 IN MEMORY (so a bad
 * download never touches disk), canary-runs the new bundle, then atomically swaps them into the install
 * dir (keeping a `.prev` for rollback). Firing the restart, supervising the new process, and rolling
 * back are all the CALLER's job (`restartForUpdate` in cli.ts) — this module only stages.
 *
 * Manifest entry shape (key = ADAPTER_UPDATE_KEY, coexists with the device `commander` key):
 *   { "adapter": { "version": "0.0.2",
 *                  "cli":    { "url": "…/cli.js",    "sha256": "…", "size": N },
 *                  "notify": { "url": "…/notify.mjs","sha256": "…", "size": M } } }
 */

import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { join } from 'path'

export interface FileRef {
  url: string
  sha256: string
  size?: number
}
export interface UpdateEntry {
  version: string
  cli: FileRef
  notify: FileRef
}

const CLI = 'cli.js'
const NOTIFY = 'notify.mjs'
const PACKAGE = 'package.json'
const RUNTIME_PACKAGE = `${JSON.stringify({ type: 'module' })}\n`

/** Strict semver-greater on the `X.Y.Z` core (ignores pre-release/build). Unparseable → false, so a
 *  malformed manifest or the `0.0.0-dev` dev sentinel never triggers a downgrade/oscillation. */
export function semverGt(a: string, b: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** Fetch + parse the manifest; return this adapter's entry, or null (unreachable / malformed / absent). */
export async function fetchManifest(url: string, key: string): Promise<UpdateEntry | null> {
  // No `cache` option needed: undici doesn't HTTP-cache by default and GCS serves the manifest no-cache.
  const res = await fetch(url)
  if (!res.ok) return null
  const json = (await res.json()) as Record<string, unknown>
  const entry = json?.[key] as Partial<UpdateEntry> | undefined
  const okFile = (f: unknown): f is FileRef =>
    !!f && typeof (f as FileRef).url === 'string' && typeof (f as FileRef).sha256 === 'string'
  if (!entry || typeof entry.version !== 'string' || !okFile(entry.cli) || !okFile(entry.notify)) return null
  return { version: entry.version, cli: entry.cli, notify: entry.notify }
}

/** Download one file and verify its sha256 in memory; throws on a non-2xx or a digest mismatch. */
export async function downloadVerified(ref: FileRef): Promise<Buffer> {
  const res = await fetch(ref.url)
  if (!res.ok) throw new Error(`download ${ref.url} → HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (got.toLowerCase() !== ref.sha256.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${ref.url}: expected ${ref.sha256}, got ${got}`)
  }
  return buf
}

/** Cheap runnability check: write the new bundle into a temp install-shaped dir and run
 *  `node cli.js version`. This catches broken ESM/CJS packaging before the live install is touched. */
export function canary(cliBuf: Buffer, dir: string): boolean {
  const tmpDir = join(dir, `.canary-${process.pid}-${Date.now()}`)
  const tmpCli = join(tmpDir, CLI)
  try {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, PACKAGE), RUNTIME_PACKAGE)
    writeFileSync(tmpCli, cliBuf)
    const r = spawnSync(process.execPath, [tmpCli, 'version'], { timeout: 15_000, stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** Atomically swap the new bytes into `dir`, backing up the current files to `.prev` for rollback.
 *  (Verify-in-memory first ⇒ we only ever write bytes we already trust; write-tmp+rename ⇒ no torn file.) */
export function stage(dir: string, cliBuf: Buffer, notifyBuf: Buffer): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, PACKAGE), RUNTIME_PACKAGE)
  const swap = (name: string, buf: Buffer): void => {
    const target = join(dir, name)
    if (existsSync(target)) copyFileSync(target, `${target}.prev`)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, buf)
    renameSync(tmp, target) // atomic within the same filesystem
  }
  swap(CLI, cliBuf)
  swap(NOTIFY, notifyBuf)
}

/** Roll a failed update back to the `.prev` bytes (called by the supervisor when the new build crashes). */
export function restore(dir: string): void {
  for (const name of [CLI, NOTIFY]) {
    const prev = join(dir, `${name}.prev`)
    if (existsSync(prev)) { try { renameSync(prev, join(dir, name)) } catch { /* ignore */ } }
  }
}

/** Drop the `.prev` backups once the new build is confirmed healthy. */
export function confirm(dir: string): void {
  for (const name of [CLI, NOTIFY]) {
    try { rmSync(join(dir, `${name}.prev`), { force: true }) } catch { /* ignore */ }
  }
}

export interface Poller { stop(): void }

/**
 * Poll on an interval; on the first strictly-newer, verified, canary-passed build, STAGE it and call
 * `onStaged(version)` exactly once, then stop polling (the caller restarts immediately). Every failure
 * (fetch/parse/sha/canary/disk) is swallowed and simply retried next tick — the daemon never crashes
 * on a bad update.
 */
export function startSelfUpdater(opts: {
  currentVersion: string
  url: string
  key: string
  dir: string
  intervalMs: number
  onStaged: (version: string) => void
}): Poller {
  let checking = false
  let done = false
  let timer: NodeJS.Timeout | null = null

  const stop = (): void => { if (timer) { clearInterval(timer); timer = null } }

  const tick = async (): Promise<void> => {
    if (checking || done) return
    checking = true
    try {
      const entry = await fetchManifest(opts.url, opts.key)
      if (!entry || !semverGt(entry.version, opts.currentVersion)) return
      console.log(`[update] newer build available: ${opts.currentVersion} → ${entry.version}`)
      const cliBuf = await downloadVerified(entry.cli)
      const notifyBuf = await downloadVerified(entry.notify)
      if (!canary(cliBuf, opts.dir)) { console.error('[update] canary failed for the new build — skipping'); return }
      stage(opts.dir, cliBuf, notifyBuf)
      done = true
      stop()
      console.log(`[update] staged ${entry.version} — restarting now`)
      opts.onStaged(entry.version)
    } catch (err) {
      console.error('[update] check failed (will retry):', err instanceof Error ? err.message : err)
    } finally {
      checking = false
    }
  }

  timer = setInterval(() => void tick(), opts.intervalMs)
  void tick() // also check immediately on start
  return { stop }
}
