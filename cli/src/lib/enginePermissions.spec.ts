import { describe, expect, it } from 'vitest'
import { ENGINES } from './engineBin.js'
import { permissionArgsFor, userChosePermissions } from './enginePermissions.js'

/**
 * This table is a contract with eight CLIs, read from their own `--help` on 2026-07-31. When one renames
 * a flag the adapter cannot tell — the agent simply starts asking for permission again, from a pane
 * nobody is watching. These assertions are the tripwire, so they name the flags literally.
 */
describe('default permission flags', () => {
  it('gives every engine the flags read from its --help', () => {
    const flags = Object.fromEntries(ENGINES.map((e) => [e, permissionArgsFor(e, [])]))
    expect(flags).toEqual({
      claude: ['--dangerously-skip-permissions'],
      // Undocumented, but identical to --dangerously-bypass-approvals-and-sandbox: both land on
      // "permissions: YOLO mode" (compared side by side on codex 0.145.0).
      codex: ['--yolo'],
      cursor: ['--force', '--trust'],
      opencode: ['--auto'],
      // Pi has no permission bypass at all — only the trust axis. Inventing one would fail to start.
      pi: ['--approve'],
      hermes: ['--yolo'],
      commandcode: ['--yolo', '--trust'],
      // Devin's flag takes a value. Its trust gate has no flag, and harness will not write config to get
      // past one — so `harness devin` still asks once per directory, on purpose.
      devin: ['--permission-mode', 'dangerous'],
      // Muse's `--yolo` also trusts the workspace for the run, so one flag clears approval, sandbox and
      // trust in one go — measured from `muse --help`, 0.1.0-R708.1.
      muse: ['--yolo'],
      // Amp's flag is UNDOCUMENTED — not in `--help`, found in the binary — and verified three ways on
      // 0.0.1786064749: an unknown flag is rejected while this one is accepted, an `ask` rule blocks the
      // tool without it ("blocked by a permissions rule"), and the same command runs with it.
      amp: ['--dangerously-allow-all'],
    })
  })

  it('adds nothing once the user has named a policy of their own', () => {
    // The ONLY opt-out, so it has to cover flags machine would never add itself.
    expect(permissionArgsFor('codex', ['--sandbox', 'read-only'])).toEqual([])
    expect(permissionArgsFor('codex', ['-a', 'untrusted'])).toEqual([])
    expect(permissionArgsFor('claude', ['--permission-mode', 'plan'])).toEqual([])
    expect(permissionArgsFor('devin', ['--permission-mode', 'accept-edits'])).toEqual([])
    expect(permissionArgsFor('hermes', ['--safe-mode'])).toEqual([])
    // `--flag=value` is the same choice as `--flag value`.
    expect(permissionArgsFor('claude', ['--permission-mode=plan'])).toEqual([])
  })

  it('keeps the two axes independent', () => {
    // Trusting the directory says nothing about whether the agent may run a command.
    expect(permissionArgsFor('cursor', ['--trust'])).toEqual(['--force'])
    expect(permissionArgsFor('commandcode', ['-t'])).toEqual(['--yolo'])
    // …and choosing a permission policy must not withdraw the trust flag.
    expect(permissionArgsFor('commandcode', ['--permission-mode', 'standard'])).toEqual(['--trust'])
    expect(permissionArgsFor('cursor', ['--force'])).toEqual(['--trust'])
  })

  it('leaves ordinary arguments alone', () => {
    expect(permissionArgsFor('claude', ['--resume', 'abc', '--model', 'opus']))
      .toEqual(['--dangerously-skip-permissions'])
    expect(permissionArgsFor('devin', ['-r'])).toEqual(['--permission-mode', 'dangerous'])
    // `-t` is Command Code's trust flag but Pi's TOOL allowlist — the same spelling, different axis.
    expect(permissionArgsFor('pi', ['-t', 'read,bash'])).toEqual(['--approve'])
  })

  it('reports whether the user chose anything at all', () => {
    expect(userChosePermissions('codex', ['--sandbox', 'read-only'])).toBe(true)
    expect(userChosePermissions('cursor', ['--trust'])).toBe(true)
    expect(userChosePermissions('claude', ['--resume', 'abc'])).toBe(false)
    expect(userChosePermissions('hermes', [])).toBe(false)
  })
})
