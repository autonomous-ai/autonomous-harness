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

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config/env.js'
import type { GridConfigFile } from './gridLaunch.js'

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
 * Write `files` into this agent's own directory and return its path.
 *
 * Rewriting is the normal case, not an error: moving an agent to a different grid writes the same
 * directory again with the new provider, which is exactly what a respawn should read.
 */
export async function writeGridConfigDir(key: string, files: readonly GridConfigFile[]): Promise<string> {
  const root = gridConfigRoot()
  const dir = join(root, safeKey(key))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Best-effort and never in the way: a failed prune must not cost a launch.
  await prune(root).catch(() => {})
  for (const file of files) {
    await writeFile(join(dir, file.name), file.content, { mode: 0o600 })
  }
  return dir
}
