/**
 * The private config directory an engine is given when its provider lives in a file.
 *
 * Pi is the case this exists for: it reads providers out of a directory, and `PI_CODING_AGENT_DIR`
 * moves that directory. Rather than edit `~/.pi/agent/models.json` — someone else's file, which
 * would outlive the agent and survive every uninstall — the daemon writes a directory it owns and
 * points the engine at that. The user's own configuration is never opened, and deleting the
 * directory undoes the whole thing.
 *
 * Nothing written here is secret. A provider block references the key through an environment
 * variable; the key itself only ever lives in the process environment.
 */

import { lstat, mkdir, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config/env.js'
import type { GridConfigFile, GridConfigLink } from './gridLaunch.js'

/** Everything this module owns lives under one root, so pruning can be confident about what it is. */
export function gridConfigRoot(): string {
  return join(env.ADAPTER_DATA_DIR, 'grid-engine-config')
}

/**
 * A directory that has not been touched in this long belongs to an agent that is long gone.
 *
 * These are a few hundred bytes each, so this is tidiness rather than reclamation — but a directory
 * per agent ever created, kept forever, is the kind of thing that is only ever noticed years later.
 */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** Only `[A-Za-z0-9_-]` survives, so a key can never climb out of the root. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96) || 'agent'
}

async function prune(root: string): Promise<void> {
  const cutoff = Date.now() - PRUNE_AFTER_MS
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return
    const path = join(root, entry.name)
    const info = await stat(path).catch(() => null)
    if (info && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true }).catch(() => {})
  }))
}

/**
 * Link `name` in this agent's directory at `target`, so a redirected home can borrow one directory
 * back from the real one.
 *
 * Grok is the case: `GROK_HOME` moves its WHOLE state directory, and `sessions/` has to keep landing
 * where the daemon reads transcripts — see `GROK_GRID_HOME_LINKS`. A link rather than a copy because
 * the point is that the engine writes through it, live.
 *
 * Never fatal. A machine that cannot make the link (a target that does not exist yet, a filesystem
 * that will not) still gets an agent — one whose sessions land in the private directory, which costs
 * the harness that agent's transcript but does not cost the launch. Refusing here would trade a
 * degraded agent for no agent at all.
 */
async function linkInto(dir: string, name: string, target: string): Promise<void> {
  const path = join(dir, name)
  // A rewrite is the normal case (an agent moved between grids), and `symlink` will not overwrite.
  // Only ever a link is removed — a real directory here would be the engine's own state, and
  // deleting that is not this function's business.
  const existing = await lstat(path).catch(() => null)
  if (existing?.isSymbolicLink()) {
    if (await readlink(path).catch(() => null) === target) return
    await rm(path, { force: true }).catch(() => {})
  } else if (existing) {
    return
  }
  await symlink(target, path, 'dir').catch(() => {})
}

/**
 * Write `files` into this agent's own directory and return its path.
 *
 * Rewriting is the normal case, not an error: moving an agent to a different grid writes the same
 * directory again with the new provider, which is exactly what a respawn should read.
 */
export async function writeGridConfigDir(
  key: string,
  files: readonly GridConfigFile[],
  links: readonly GridConfigLink[] = [],
): Promise<string> {
  const root = gridConfigRoot()
  const dir = join(root, safeKey(key))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Best-effort and never in the way: a failed prune must not cost a launch.
  await prune(root).catch(() => {})
  for (const file of files) {
    await writeFile(join(dir, file.name), file.content, { mode: 0o600 })
  }
  for (const link of links) {
    await linkInto(dir, link.name, link.target)
  }
  return dir
}
