import { describe, expect, it } from 'vitest'
import { kiloOneShotSpawn } from './oneshot.js'

/**
 * A production failure, pinned.
 *
 * The kilo recap worker escaped its scratch directory and ran against the user's real repository. The
 * daemon spawns it with `cwd: <scratch>`, which is not enough: kilo resolves its project from `$PWD`, and
 * `spawn({cwd})` does not rewrite that variable, so the child inherited the DAEMON's working directory.
 * Measured in the daemon log — the worker announced
 * `kilocode-indexing workspacePath=<the daemon's launch directory> initializing project indexing` the
 * moment a prompt reached it — and reproduced by hand by setting a hostile `PWD` with the correct `cwd`.
 *
 * The consequence was not a crash. The recap sat indexing a real repository until the 60s timeout, so no
 * `turn_summary` was ever produced: no recap, and a device tile that showed "Summarizing…" for a minute
 * on every single turn. Nothing about that is visible in a unit test of the parser, which is why the
 * containment rules are asserted here instead.
 */
describe('kilo recap worker containment', () => {
  const SCRATCH = '/tmp/adapter/kilo-recap'
  const HOSTILE = { PWD: '/Users/someone/Work/a-real-repo', TMUX: '/tmp/tmux-501/default', TMUX_PANE: '%3' }

  it('pins the workspace with --dir rather than trusting the spawn cwd', () => {
    const { args } = kiloOneShotSpawn(undefined, {}, SCRATCH)
    expect(args).toContain('--dir')
    expect(args[args.indexOf('--dir') + 1]).toBe(SCRATCH)
  })

  it('overrides an inherited PWD, which is what actually leaked', () => {
    const { env } = kiloOneShotSpawn(undefined, { ...HOSTILE }, SCRATCH)
    expect(env.PWD).toBe(SCRATCH)
  })

  it('keeps kilo\'s own store in the scratch dir', () => {
    // Kilo ignores KILO_DATA_DIR and OPENCODE_DATA_DIR; XDG_DATA_HOME is the only override that moves it.
    const { env } = kiloOneShotSpawn(undefined, {}, SCRATCH)
    expect(env.XDG_DATA_HOME).toBe(SCRATCH)
  })

  it('scrubs tmux so an ephemeral recap can never look like a pane agent', () => {
    const { env } = kiloOneShotSpawn(undefined, { ...HOSTILE }, SCRATCH)
    expect(env.TMUX).toBeUndefined()
    expect(env.TMUX_PANE).toBeUndefined()
  })

  /**
   * `--auto` is required: without it a recap whose model reaches for any tool dies on kilo's own
   * auto-rejection ("run ended with an auto-rejected permission") and returns no text at all. It is valid
   * on the `run` SUBCOMMAND only — Harness never applies it to the user's interactive TUI process.
   */
  it('runs autonomously and asks for machine-readable output', () => {
    const { args } = kiloOneShotSpawn(undefined, {}, SCRATCH)
    expect(args.slice(0, 5)).toEqual(['run', '--pure', '--auto', '--format', 'json'])
  })

  it('passes a model only when one is configured', () => {
    expect(kiloOneShotSpawn('kilo/stepfun/step-3.7-flash', {}, SCRATCH).args).toContain('--model')
    // KILO_SUMMARY_MODEL defaults to empty, meaning "use the user's own default" — not "--model ''".
    expect(kiloOneShotSpawn('', {}, SCRATCH).args).not.toContain('--model')
  })
})
