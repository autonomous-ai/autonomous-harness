/**
 * How `harness <engine>` starts an agent that nobody is sitting in front of.
 *
 * A CLI's defaults assume a human at the keyboard: it asks before each action, and several ask "do you
 * trust this directory?" before they will start at all. Driven from web or device there is no one to
 * answer, so the session simply stops — verified on 2026-07-31, when devin, cursor and Command Code each
 * sat on a trust prompt until someone walked to the computer. So the launcher supplies the flags itself.
 *
 * **Flags are the whole mechanism** (owner call, 2026-07-31): machine never edits a CLI's config to get
 * past a gate. Where a CLI takes trust through its config file and offers no flag — devin, and codex
 * since 0.145 — the prompt is left for the user to answer once, in the pane, at first start. A stale
 * entry written into someone's real config outlives the session that wanted it; a one-time keypress does
 * not.
 *
 * **Passing your own flag is the only opt-out**, by design — which is why `owned` below is deliberately
 * wider than what gets added.
 *
 * Every flag here was read from the installed CLI's own `--help` on 2026-07-31. When a CLI renames one,
 * this table goes silently wrong — `enginePermissions.spec.ts` is the tripwire.
 */

import type { AgentEngine } from '../engines/types.js'

/**
 * The two things a CLI can block on. They are kept apart because a user chooses them apart: `--trust`
 * says nothing about whether the agent may run a command, so naming one must not suppress the other.
 */
type Axis = 'permission' | 'trust'

interface EnginePermissions {
  /** What the launcher adds, per axis. `args` is the whole flag — value included where one is needed. */
  add: Array<{ axis: Axis; args: string[] }>
  /**
   * Flags meaning "the user already decided this axis", checked as whole argv entries (and `--flag=value`).
   * WIDER than `add` on purpose: someone who typed `codex --sandbox read-only` has chosen a policy, and
   * appending a bypass-everything flag on top would quietly invert what they asked for.
   */
  owned: Partial<Record<Axis, string[]>>
}

const PERMISSIONS: Readonly<Record<AgentEngine, EnginePermissions>> = {
  claude: {
    add: [{ axis: 'permission', args: ['--dangerously-skip-permissions'] }],
    owned: {
      permission: [
        '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode',
      ],
    },
  },
  // `--yolo` is undocumented (absent from `--help`) but real, and identical to the long spelling: both
  // start the session at `permissions: YOLO mode`, compared side by side on 0.145.0. Codex also gates
  // directory trust — no flag reaches it, and `-c projects."<dir>".trust_level` does not either (tried),
  // so that one prompt stays with the user.
  codex: {
    add: [{ axis: 'permission', args: ['--yolo'] }],
    owned: {
      permission: [
        '--yolo', '--dangerously-bypass-approvals-and-sandbox', '--full-auto',
        '-a', '--ask-for-approval', '-s', '--sandbox',
      ],
    },
  },
  cursor: {
    add: [
      { axis: 'permission', args: ['--force'] },
      { axis: 'trust', args: ['--trust'] },
    ],
    owned: {
      permission: ['-f', '--force', '--yolo', '--sandbox'],
      trust: ['--trust'],
    },
  },
  opencode: {
    add: [{ axis: 'permission', args: ['--auto'] }],
    owned: { permission: ['--auto'] },
  },
  /**
   * Kilo adds NOTHING, and this is the one place it diverges hardest from the opencode it forked.
   *
   * `kilo run` documents BOTH `--auto` and `--dangerously-skip-permissions`, so the flags exist on the
   * binary — but they belong to the `run` subcommand, and the launcher starts the TUI (`kilo`), not `run`.
   * Measured on a real TTY inside tmux, with a control: bare `kilo` starts the TUI, while `kilo --auto`
   * prints the usage block and exits. Adding the flag anyway would not loosen permissions, it would stop
   * the agent from starting at all.
   *
   * Note the non-TTY form cannot answer this question: with stdin closed, `kilo --auto`,
   * `kilo --dangerously-skip-permissions` and an invented flag all print byte-identical usage, so the
   * usual unknown-flag test reads as "rejected" for real flags too. The TTY is the only place it shows.
   *
   * `owned` still lists both spellings: a user who types one has chosen the axis, and nothing should be
   * appended on top of that if this table ever gains an `add`.
   */
  kilo: {
    add: [],
    owned: { permission: ['--auto', '--dangerously-skip-permissions'] },
  },
  // Pi has NO permission bypass: its model is tool allow/deny lists (`--tools`, `--exclude-tools`) with no
  // "approve everything" switch, so only the trust axis is set. Inventing a flag would just fail to start.
  pi: {
    add: [{ axis: 'trust', args: ['--approve'] }],
    owned: {
      permission: ['--tools', '-t', '--no-tools', '-nt', '--exclude-tools', '-xt'],
      trust: ['--approve', '-a'],
    },
  },
  hermes: {
    add: [{ axis: 'permission', args: ['--yolo'] }],
    owned: { permission: ['--yolo', '--safe-mode'] },
  },
  commandcode: {
    add: [
      { axis: 'permission', args: ['--yolo'] },
      { axis: 'trust', args: ['--trust'] },
    ],
    owned: {
      permission: ['--yolo', '--dangerously-skip-permissions', '--permission-mode'],
      trust: ['-t', '--trust'],
    },
  },
  // Devin's trust gate has no flag at all, so `harness devin` still shows it once per directory. (The
  // recap one-shot, which runs headless in a scratch dir machine itself made, trusts that one path —
  // see trustDevinWorkspace in oneshot.ts.)
  devin: {
    add: [{ axis: 'permission', args: ['--permission-mode', 'dangerous'] }],
    owned: { permission: ['--permission-mode'] },
  },
  // `--yolo` is muse's own name for the same thing, and it does three jobs at once: no approval prompts,
  // no sandbox, and trust this workspace for the run. The finer flags are listed as owned so a user who
  // passes one of them keeps their choice instead of getting ours on top.
  muse: {
    add: [{ axis: 'permission', args: ['--yolo'] }],
    owned: { permission: ['--yolo', '--disable-approval', '--disable-sandbox', '--trust-workspace', '--approval-mode'] },
  },
  // `--dangerously-allow-all` is UNDOCUMENTED — absent from `--help`, found in the binary's strings — and
  // it is real. Measured all three ways on 0.0.1786064749: an unknown flag is rejected outright
  // (`error: unknown option`) while this one is accepted; with an `ask shell_command` rule in settings and
  // no flag the tool is refused mid-turn ("blocked by a permissions rule … rule 0: ask shell_command");
  // with the flag the same command runs and returns its output.
  //
  // That refusal is why the flag matters: Amp does not stall waiting for someone, it tells the model no
  // and carries on, so an unattended agent produces a turn that quietly did nothing. There is no config
  // edit here either — the rules live in `amp.permissions` in settings.json, which this launcher leaves
  // alone. A user who passes the flag themselves keeps their own choice.
  amp: {
    add: [{ axis: 'permission', args: ['--dangerously-allow-all'] }],
    owned: { permission: ['--dangerously-allow-all'] },
  },
}

/** Whole-argv-entry match; `--flag=value` is the same choice as `--flag value`. */
function mentions(argv: string[], flags: string[] | undefined): boolean {
  if (!flags?.length) return false
  const seen = new Set(argv.map((arg) => (arg.startsWith('--') ? arg.split('=')[0] : arg)))
  return flags.some((flag) => seen.has(flag))
}

/** The flags to append for this engine — each axis dropped only if the user spoke to THAT axis. */
export function permissionArgsFor(engine: AgentEngine, argv: string[] = []): string[] {
  const spec = PERMISSIONS[engine]
  const chosen: Record<Axis, boolean> = {
    permission: mentions(argv, spec.owned.permission),
    trust: mentions(argv, spec.owned.trust),
  }
  return spec.add.filter((entry) => !chosen[entry.axis]).flatMap((entry) => entry.args)
}

/** True when the user already chose a permission or trust policy for this engine. */
export function userChosePermissions(engine: AgentEngine, argv: string[]): boolean {
  const { owned } = PERMISSIONS[engine]
  return mentions(argv, [...(owned.permission ?? []), ...(owned.trust ?? [])])
}
