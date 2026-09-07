import { accessSync, constants, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

import { env } from '../config/env.js'

/**
 * The Node interpreter to bake into anything that runs LATER, in a process we do not launch — engine
 * hook command lines above all. Such a command cannot say `node`: a hook fires in a shell whose PATH
 * belongs to the engine (an app started from Finder inherits launchd's bare
 * `/usr/bin:/bin:/usr/sbin:/sbin`), and since the product moved to a private runtime, a machine with
 * no `node` on PATH at all is the normal case rather than the broken one.
 *
 * The managed runtime is preferred over [process.execPath], and the ordering is the whole point:
 * `execPath` is whatever interpreter THIS daemon happened to be launched with, which goes stale the
 * moment a new runtime is provisioned under a long-running daemon, whereas `current-node` is rewritten
 * by both installers and by Desktop Harness every time they lay one down. Reading it here means the
 * next `harness start` emits hooks pointing at the CURRENT runtime even while this process is still
 * running on the previous one — so a Node upgrade repairs the hooks by itself, not just a CLI upgrade.
 *
 * `execPath` remains the answer for a dev checkout or any machine with no managed runtime, and for a
 * `current-node` that has gone bad: a hook naming an interpreter that cannot run is strictly worse
 * than one naming the interpreter we are demonstrably running on.
 */
export function managedNodePath(): string {
  try {
    const recorded = readFileSync(join(env.ADAPTER_RUNTIME_DIR, 'current-node'), 'utf-8').trim()
    // Only ever trust a path inside the runtime directory we own — the same containment check the
    // desktop app applies to this file before executing what it names.
    if (recorded && recorded.startsWith(env.ADAPTER_RUNTIME_DIR + sep)) {
      accessSync(recorded, constants.X_OK)
      return recorded
    }
  } catch {
    // absent, unreadable, or not executable → fall through
  }
  return process.execPath
}
