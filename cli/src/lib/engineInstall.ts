/**
 * Installing an engine that is not on the target machine yet.
 *
 * The New Agent dialog lists every engine Harness supports, not every engine the machine HAS — and
 * until now the difference only surfaced as a failed create: tmux ran a command that did not exist,
 * the pane said `command not found`, and the daemon reported `ENGINE_NOT_INSTALLED` after the fact
 * (see the probe in `engineLaunch.ts` and its caller in `cli.ts`). This module is the other half:
 * what to RUN so that the engine exists, so the dialog can offer the install instead of the failure.
 *
 * ## Every entry is the vendor's own published install line
 *
 * Nothing here is derived, and nothing is a plausible-looking package name. An engine whose install
 * could not be verified against the vendor's own registry entry or documentation gets **no entry**,
 * and the dialog then says the engine is missing without offering to fix it. A missing entry is a
 * smaller lie than a wrong one.
 *
 * Verify against the VENDOR, not against a plausible package name. The unscoped `pi-coding-agent`
 * on npm is "Placeholder package name reservation" with no bin, while pi.dev publishes
 * `@earendil-works/pi-coding-agent` — installing the first would leave a machine with no `pi` and
 * no error, having just reported success.
 *
 * ## Why the command is a string, and why it runs in the user's own shell
 *
 * These are the lines a person would paste. They are run through the SAME interactive shell that
 * launches an agent (`interactiveEngineShell`), for the reason that shell exists at all: a detached
 * daemon does not have the user's PATH, and `npm`, `node` and `curl` frequently arrive through
 * `.zshrc`/`.bashrc` (nvm, asdf, vendor installers). Installing with the daemon's PATH would either
 * fail to find npm or install into a prefix the agent's own shell cannot then see — the worst
 * outcome, because it looks like success and leaves the engine still missing.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not sudo, does not choose a package manager on the user's behalf beyond what the vendor
 * publishes, and does not retry. An install that fails leaves its output in the pane and says so;
 * the person reads the reason and fixes it. A privileged retry is how a tool ends up owning a
 * machine's global prefix without ever being asked.
 */

import type { AgentEngine } from '../engines/types.js'

/** One engine's published install line. */
export interface EngineInstallRecipe {
  /**
   * The shell command, exactly as the vendor publishes it.
   *
   * Runs in the user's interactive shell on the TARGET machine — which is not necessarily the
   * machine the person is sitting at, so it must not assume anything about the operating system
   * beyond a POSIX shell.
   */
  readonly command: string
  /**
   * Where the line above was read from. Kept in the code rather than a commit message because the
   * next person to touch this needs to re-verify it, and a URL in a diff is not findable later.
   */
  readonly source: string
}

/**
 * The engines Harness can install, and how.
 *
 * `Partial` on purpose — an absent key is the honest answer for an engine whose install we cannot
 * cite, and [engineInstallRecipe] returns null for it rather than guessing.
 */
export const ENGINE_INSTALL: Partial<Record<AgentEngine, EngineInstallRecipe>> = {
  claude: {
    command: 'npm install -g @anthropic-ai/claude-code',
    source: 'npm: @anthropic-ai/claude-code — the same package the remote-machine rig installs',
  },
  codex: {
    command: 'npm install -g @openai/codex',
    source: 'npm: @openai/codex — matches the `@openai/codex/bin/codex.js` runtime evidence in engines/README.md',
  },
  copilot: {
    command: 'npm install -g @github/copilot',
    source: 'npm: @github/copilot — matches the `@github/copilot` npm loader in engines/README.md',
  },
  opencode: {
    command: 'npm install -g opencode-ai',
    source: 'npm: opencode-ai — matches the `opencode-ai/bin/opencode.exe` runtime evidence in engines/README.md',
  },
  hermes: {
    // Not npm. Hermes is a Python agent whose installer builds a venv and links an entrypoint, which
    // is why a broken checkout shows up as a DANGLING SYMLINK on ~/.local/bin/hermes rather than a
    // missing file — and why the availability probe tests `-f` and `-x`, not just `command -v`.
    command: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
    source: 'NousResearch/hermes-agent README — "Quick Install", Linux/macOS/WSL2/Termux',
  },
  pi: {
    // `--ignore-scripts` is the vendor's own line, not a hardening we added — pi.dev publishes it
    // that way, and dropping it is not ours to decide.
    //
    // The package is SCOPED, and the unscoped `pi-coding-agent` is a different thing entirely:
    // "Placeholder package name reservation", version 0.0.1, no bin. Installing that one leaves a
    // machine with no `pi` and no error, which is the exact failure this comment exists to prevent
    // the next person from re-introducing by "simplifying" the name.
    command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    source: 'pi.dev — its published install line; npm @earendil-works/pi-coding-agent ships bin `pi`',
  },
}

/** The install line for an engine, or null when Harness has none it can cite. */
export function engineInstallRecipe(engine: AgentEngine): EngineInstallRecipe | null {
  return ENGINE_INSTALL[engine] ?? null
}

/**
 * The engines an install can be offered for.
 *
 * Mirrored by `kInstallableEngines` in the desktop app so the dialog can label a row before it has
 * asked the machine anything — the same arrangement `kGridCapableEngines` has with `gridLaunch.ts`.
 * Keep the two in sync.
 */
export const INSTALLABLE_ENGINES: ReadonlySet<AgentEngine> = new Set(
  Object.keys(ENGINE_INSTALL) as AgentEngine[],
)
