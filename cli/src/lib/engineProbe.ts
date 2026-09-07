/**
 * Which engines does THIS machine actually have?
 *
 * The New Agent dialog lists every engine Harness supports. Whether a given machine has any of them
 * installed is a different question, and until this module existed it was only ever answered the
 * expensive way: create the agent, watch tmux run a command that does not exist, and read the
 * `ENGINE_NOT_INSTALLED` that came back. The dialog can ask first.
 *
 * ## It must run on the machine being asked about
 *
 * This is the whole reason the answer travels as a request rather than being computed in the app. A
 * developer's Mac and the Docker rig in `docker/remote-machine` routinely disagree — the rig ships
 * exactly one engine on purpose — and so do two laptops on one account. An availability list
 * computed locally and applied to a remote machine is wrong in the one case the feature exists for.
 *
 * ## It probes the binary the LAUNCH would use, not an alias
 *
 * [engineBin] is what `agent_create` puts in `command[0]`, so it is what has to resolve. Probing
 * `ENGINE_CLI_ALIASES` instead would let a machine answer "installed" for an alias the launch never
 * calls, which is a worse failure than no answer at all: the dialog would promise a create that
 * still cannot work.
 *
 * The probe itself is [commandAvailableInInteractiveShell] — the same call `cli.ts` already makes
 * when a create fails, in the same interactive shell a create launches through. Two different notions
 * of "installed" between the dialog and the launch is precisely the bug this avoids, so there is one
 * implementation and both sides call it.
 *
 * Note what that probe tests: `command -v`, then `-f` and `-x` on what it resolved. A DANGLING
 * SYMLINK — `~/.local/bin/hermes` pointing into a venv that was deleted — is therefore correctly
 * reported as not installed, which is the state a plain `command -v` gets wrong.
 */

import { ENGINES, type AgentEngine } from '../engines/types.js'
import { engineBin } from './engineBin.js'
import { commandAvailableInInteractiveShell } from './engineLaunch.js'
import { engineInstallRecipe } from './engineInstall.js'

/** One engine's answer for one machine. */
export interface EngineAvailability {
  readonly engine: AgentEngine
  /** Does the launch command resolve, as an existing executable file, in the agent's own shell? */
  readonly installed: boolean
  /** The command that was probed — `command[0]` of a launch. Null when the engine has no binary. */
  readonly command: string | null
  /** Whether Harness has a citable install line for it (see `engineInstall.ts`). */
  readonly installable: boolean
}

/**
 * How many shells to have in flight at once.
 *
 * Each probe spawns an interactive shell, and an interactive shell runs the user's rc files — which
 * on a real machine sources nvm, completions and vendor installers. Fourteen at once is a thundering
 * herd on the very startup path the agent launch also needs; one at a time makes the dialog wait for
 * the slowest rc file fourteen times over. Four is the compromise, and it is a number, not a
 * principle: raise it if a machine is measured to be idle through the probe.
 */
const PROBE_CONCURRENCY = 4

/** The launch command for an engine, or null when it has none we can name. */
function launchCommand(engine: AgentEngine): string | null {
  try {
    const bin = engineBin(engine)
    return bin && bin.length > 0 ? bin : null
  } catch {
    // `engineBin` throws for an engine whose binary is genuinely ambiguous on this machine (the
    // `agent` alias shared by Cursor and Grok is the live case). Ambiguous is not the same as
    // absent, but it is equally un-probeable, and reporting it as "not installed" would offer an
    // install that could not fix it. Null flows through to `installed: false, installable: false`.
    return null
  }
}

/**
 * Probe a set of engines on this machine.
 *
 * Order of the result follows the order asked for, so a caller can zip it against its own list.
 * Never throws: a machine that cannot answer for one engine still answers for the rest, because a
 * dialog that renders thirteen rows and one blank is more useful than one that renders an error.
 */
export async function probeEngines(
  engines: readonly AgentEngine[] = ENGINES,
): Promise<EngineAvailability[]> {
  const results = new Array<EngineAvailability>(engines.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= engines.length) return
      const engine = engines[index]
      const command = launchCommand(engine)
      let installed = false
      if (command) {
        try {
          installed = await commandAvailableInInteractiveShell(command)
        } catch {
          // The probe has its own 5s timeout and resolves false rather than rejecting; this catch is
          // for the spawn itself failing. Unknown reads as not installed, which is the safe way
          // round: the dialog then offers an install that is merely redundant, rather than promising
          // a launch that cannot happen.
          installed = false
        }
      }
      results[index] = {
        engine,
        installed,
        command,
        installable: !installed && command !== null && engineInstallRecipe(engine) !== null,
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, engines.length) }, () => worker()),
  )
  return results
}
