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
