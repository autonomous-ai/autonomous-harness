import { statSync } from 'node:fs'

/**
 * Is this path a directory an engine can be launched in?
 *
 * One definition for both launch paths. `agent_create` has refused a missing folder since it was
 * written — before opening any pane, as `CWD_NOT_FOUND`. `restoreAgents` never made the same check,
 * so a registry row whose folder was deleted between one boot and the next opened a pane whose
 * login shell could only fail its `cd` guard and exit 1, and the failure reached the user as
 * "the engine did not start". Sharing the test is what keeps the two paths from drifting on what
 * "available" means.
 *
 * `detail` is written for a person reading it in the app, possibly on a different machine than the
 * one that failed, so it names the path and says what to do about it.
 */
export type WorkdirAvailability = { ok: true } | { ok: false; detail: string }

export function workdirAvailable(cwd: string): WorkdirAvailability {
  try {
    if (statSync(cwd).isDirectory()) return { ok: true }
    return { ok: false, detail: `its folder ${cwd} is not a folder — put a folder back there, or create the agent again somewhere else` }
  } catch {
    // ENOENT, a dangling symlink, EACCES on a parent: all the same answer to a launch.
    return { ok: false, detail: `its folder ${cwd} no longer exists — put it back, or create the agent again somewhere else` }
  }
}

/**
 * The refusal a restore launch returns for a row whose folder is gone, or null to carry on.
 *
 * Separate from `workdirAvailable` so the one line `cli.ts` adds to its `buildLaunch` closure — the
 * only part of this that cannot be unit-tested — is a call and a return, with the decision here.
 */
export function restoreLaunchRefusal(
  entry: { cwd: string | null },
): { error: 'CWD_NOT_FOUND'; detail: string } | null {
  if (!entry.cwd) return null
  const available = workdirAvailable(entry.cwd)
  return available.ok ? null : { error: 'CWD_NOT_FOUND', detail: available.detail }
}
