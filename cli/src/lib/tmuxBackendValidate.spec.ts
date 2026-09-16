/**
 * `validate` is the live path: `terminals.validate` / `acquireLease` hand it the identity PERSISTED in
 * the registry, so it is the one place a marker written by an older CLI is compared against one read
 * today. `checkSessionRuntime` makes the same allowance, but nothing calls it.
 *
 * Own file, and one narrowly-mocked import, because the sibling `tmuxBackend.spec.ts` drives the real
 * binary through stub `tmux`/`ps` scripts on PATH — the wrong instrument for asserting which branch of
 * one comparison ran.
 */
import { describe, expect, it, vi } from 'vitest'

const resolvePaneEngineProcess = vi.hoisted(() => vi.fn())
vi.mock('./tmux.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tmux.js')>()),
  resolvePaneEngineProcess,
}))

const { TmuxBackend } = await import('./tmuxBackend.js')

const PANE = { backend: 'tmux' as const, paneId: '%42' }
/** The same process, read today, under the LC_TIME=C that psEnv now guarantees. */
const LIVE = { pid: 15160, executable: '/Users/admin/.local/bin/claude', startMarker: 'Tue Sep 15 23:10:38 2026' }

describe('TmuxBackend.validate and the pre-psEnv start marker', () => {
  it('keeps a pane whose saved marker was written under the user own LC_TIME', async () => {
    resolvePaneEngineProcess.mockResolvedValue(LIVE)
    // hu_HU parsed fine before psEnv landed, so a marker like this is on disk for real users. It can
    // never equal the C-locale stamp above, and comparing it would report a running engine as gone.
    const saved = { ...LIVE, startMarker: 'K szept. 15 23:10:38 2026' }

    const result = await new TmuxBackend().validate(PANE, { engine: 'claude', processIdentity: saved })

    expect(result.state).toBe('alive')
  })

  it('keeps a pane whose saved marker came from the shifted pre-fix parser', async () => {
    resolvePaneEngineProcess.mockResolvedValue(LIVE)
    const saved = { ...LIVE, startMarker: 'Greeting Thu Jul 30 11:00:03 2026' }

    expect((await new TmuxBackend().validate(PANE, { engine: 'claude', processIdentity: saved })).state)
      .toBe('alive')
  })

  it('still evicts a pane whose engine really was replaced', async () => {
    resolvePaneEngineProcess.mockResolvedValue(LIVE)
    // A C-locale stamp IS comparable, so a genuine difference must still count — the allowance above
    // must not become a hole in the PID-reuse guard.
    const saved = { ...LIVE, pid: 999, startMarker: 'Mon Sep 14 08:00:00 2026' }

    const result = await new TmuxBackend().validate(PANE, { engine: 'claude', processIdentity: saved })

    // Narrow before reading `reason`: only the non-alive arms of RuntimeValidation carry one.
    if (result.state !== 'gone') throw new Error(`expected gone, got ${result.state}`)
    expect(result.reason).toContain('process changed')
  })

  it('reports an empty pane as gone, saved marker or not', async () => {
    resolvePaneEngineProcess.mockResolvedValue(null)
    const saved = { ...LIVE, startMarker: 'K szept. 15 23:10:38 2026' }

    expect((await new TmuxBackend().validate(PANE, { engine: 'claude', processIdentity: saved })).state)
      .toBe('gone')
  })
})
