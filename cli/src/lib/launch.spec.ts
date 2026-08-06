import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VERSION } from '../version.js'

/**
 * `harness <engine>` wrapper contract:
 *  - refuses outside tmux, and refuses when the daemon is not joined/running — WITHOUT spawning the CLI
 *    and without starting the daemon behind the user's back;
 *  - forwards argv verbatim (the CLI's own flags must survive), appending the permission bypass the
 *    pane's remote driver cannot click through — unless the user named a policy themselves;
 *  - is transparent: inherits the tty, propagates the child's exit status.
 */

const spawnMock = vi.fn()
const execFileMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args),
}))

const daemonRunning = vi.fn(() => true)
const tokenSaved = vi.fn(() => true)
vi.mock('./daemonState.js', () => ({
  daemonPort: () => 18473,
  isDaemonRunning: () => daemonRunning(),
  hasSavedToken: () => tokenSaved(),
}))

vi.mock('./hooks.js', () => ({ installHooksFor: vi.fn() }))
vi.mock('./engineBin.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  engineBin: () => '/usr/bin/fake-claude',
}))
/** Drivable fake WebSocket — the tests decide when it opens/closes, so socket events (not timers) are
 *  what the assertions turn on. */
class FakeWs {
  static instances: FakeWs[] = []
  /** The daemon's ack. null → it never answers, which exercises the launcher's bounded wait. */
  static ack: Record<string, unknown> | null = { t: 'opened', v: 1, version: VERSION }
  handlers = new Map<string, (...a: unknown[]) => void>()
  sent: string[] = []
  closed = false
  constructor(public url: string) {
    FakeWs.instances.push(this)
    setTimeout(() => this.openIt(), 0) // a real socket opens on its own
  }
  on(event: string, fn: (...a: unknown[]) => void) { this.handlers.set(event, fn); return this }
  send(data: string) { this.sent.push(data) }
  close() { this.closed = true; this.emit('close') }
  emit(event: string, ...args: unknown[]) { this.handlers.get(event)?.(...args) }
  /** Complete the handshake the way `ws` would, then answer like the daemon does. */
  openIt() {
    this.emit('open')
    if (FakeWs.ack) setTimeout(() => this.emit('message', JSON.stringify(FakeWs.ack)), 0)
  }
}
vi.mock('ws', () => ({ WebSocket: FakeWs }))

/** A fake child that never exits on its own — the test drives its lifecycle. */
function fakeChild() {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  return {
    on(event: string, fn: (...a: unknown[]) => void) { handlers.set(event, fn); return this },
    kill: vi.fn(),
    emit(event: string, ...args: unknown[]) { handlers.get(event)?.(...args) },
  }
}

let exitCode: number | undefined
let stderr: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  exitCode = undefined
  stderr = []
  daemonRunning.mockReturnValue(true)
  tokenSaved.mockReturnValue(true)
  process.env.TMUX = '/tmp/tmux-501/default,1,0'
  process.env.TMUX_PANE = '%7'
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error('__exit__') // unwind like the real exit would end the turn
  }) as never)
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { stderr.push(a.join(' ')) })
  // Health probe: daemon answers OK unless a test says otherwise.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  FakeWs.instances = []
  FakeWs.ack = { t: 'opened', v: 1, version: VERSION }
  spawnMock.mockImplementation(() => fakeChild())
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(null, '', '')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete process.env.TMUX
  delete process.env.TMUX_PANE
})

/**
 * Kick off a launch and wait until it has *settled into* one of its two end states: refused (process.exit
 * called) or running (child spawned). It is never awaited to completion — the real launcher deliberately
 * returns a promise that never resolves, so the wrapper stays alive holding the pane until the child ends.
 */
async function launch(argv: string[] = [], settleMs = 1_000): Promise<void> {
  const { launchEngine } = await import('./launch.js')
  void launchEngine('claude', argv).catch((err: Error) => {
    if (err.message !== '__exit__') throw err
  })
  // `settleMs` must exceed ACK_WAIT_MS for the cases where the daemon never acks — the launcher waits
  // out that window before falling back and spawning.
  await vi.waitFor(() => {
    expect(exitCode !== undefined || spawnMock.mock.calls.length > 0).toBe(true)
  }, { timeout: settleMs })
}

describe('harness <engine> launcher', () => {
  it('refuses to run outside tmux and never spawns the CLI', async () => {
    delete process.env.TMUX
    delete process.env.TMUX_PANE
    await launch()
    expect(exitCode).toBe(1)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(stderr.join('\n')).toContain('tmux')
  })

  it('refuses when the computer has never joined, pointing at `harness join <token>`', async () => {
    daemonRunning.mockReturnValue(false)
    tokenSaved.mockReturnValue(false)
    await launch()
    expect(exitCode).toBe(1)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(stderr.join('\n')).toContain('harness join <token>')
  })

  it('refuses when the daemon is stopped — and does NOT start it implicitly', async () => {
    daemonRunning.mockReturnValue(false)
    tokenSaved.mockReturnValue(true)
    await launch()
    expect(exitCode).toBe(1)
    expect(spawnMock).not.toHaveBeenCalled() // no daemon respawn, no CLI
    const out = stderr.join('\n')
    expect(out).toContain('harness join')
    expect(out).not.toContain('<token>') // credential is saved; don't ask for it again
  })

  it('forwards every argument verbatim and inherits the terminal', async () => {
    const argv = ['--resume', 'abc-123', '--model', 'opus', '--', 'a b c']
    await launch(argv)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(bin).toBe('/usr/bin/fake-claude')
    // The user's arguments arrive untouched and IN ORDER; the permission flag is appended after them,
    // never spliced in — `--` and everything past it must keep meaning what the user wrote.
    expect(args.slice(0, argv.length)).toEqual(argv)
    expect(opts.stdio).toBe('inherit')
  })

  it('adds the permission bypass nobody is there to click, unless the user chose one', async () => {
    // The pane is driven from web/device, so an agent that stops to ask never gets an answer.
    await launch()
    const [, plain] = spawnMock.mock.calls[0] as [string, string[]]
    expect(plain).toContain('--dangerously-skip-permissions')

    spawnMock.mockClear()
    await launch(['--permission-mode', 'plan'])
    const [, chosen] = spawnMock.mock.calls[0] as [string, string[]]
    expect(chosen).toEqual(['--permission-mode', 'plan'])
  })

  it('exports MACHINE_ID to the child and keeps the tmux env', async () => {
    await launch()
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(opts.env.MACHINE_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(opts.env.TMUX_PANE).toBe('%7') // opposite of the recap one-shots, which scrub it
  })

  it('announces the session over the launcher socket, with the id the child receives', async () => {
    await launch()
    const ws = FakeWs.instances[0]
    expect(ws.url).toContain('/api/machine-ws')
    ws.openIt()
    const open = JSON.parse(ws.sent[0]) as Record<string, unknown>
    expect(open.t).toBe('open')
    expect(open.engine).toBe('claude')
    expect(open.tmuxPane).toBe('%7')
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
    expect(open.launcherId).toBe(opts.env.MACHINE_ID) // the daemon and the CLI agree on the id
  })

  it('closes the launcher socket on exit (that close is what drops the tile) and keeps the exit code', async () => {
    const child = fakeChild()
    spawnMock.mockImplementation(() => child)
    await launch()
    const ws = FakeWs.instances[0]
    try { child.emit('exit', 3, null) } catch { /* mocked process.exit throws */ }
    await vi.waitFor(() => expect(ws.closed).toBe(true))
    await vi.waitFor(() => expect(exitCode).toBe(3))
  })

  it('prints NOTHING on a normal exit — even if the daemon died mid-session', async () => {
    const child = fakeChild()
    spawnMock.mockImplementation(() => child)
    await launch()
    FakeWs.instances[0].emit('close') // daemon stopped while the agent was running
    stderr.length = 0

    try { child.emit('exit', 0, null) } catch { /* mocked process.exit throws */ }
    await vi.waitFor(() => expect(exitCode).toBe(0))
    // Native `claude` says nothing when it exits; a wrapper that nags on the way out is not transparent
    // (it also pollutes stdout/stderr for anything scripting the command).
    expect(stderr.join('')).toBe('')
  })

  it('warns the moment the socket drops — no polling delay — and never writes into the pane', async () => {
    await launch()
    const ws = FakeWs.instances[0]

    const notices = (): unknown[][] => execFileMock.mock.calls.filter((c: unknown[]) =>
      Array.isArray(c[1]) && (c[1] as string[])[0] === 'display-message')
    expect(notices()).toHaveLength(0)

    ws.emit('close') // e.g. `harness stop` in another pane
    // Synchronous with the socket event: the old build waited up to 3s for a health poll.
    expect(notices()).toHaveLength(1)
    const args = notices()[0][1] as string[]
    expect(args).toContain('-d') // explicit duration; tmux's 750ms default flashed past unseen
    expect(args.join(' ')).toContain('harness join')
    // Transparency: the warning goes to the tmux status bar, never into the pane the TUI is drawing in.
    expect(stderr.join('\n')).not.toContain('harness join')
  })

  it('keeps re-posting the disconnect notice while the daemon stays down', async () => {
    vi.useFakeTimers()
    await launch()
    const notices = (): number => execFileMock.mock.calls.filter((c: unknown[]) =>
      Array.isArray(c[1]) && (c[1] as string[])[0] === 'display-message').length

    FakeWs.instances[0].emit('close')
    expect(notices()).toBe(1) // instant, on the socket event

    // A tmux status message is cleared by `display-time` OR by the user's next keystroke — announcing
    // once means it WILL be missed. Every failed reconnect must put it back.
    for (let i = 1; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5_100)
      FakeWs.instances[FakeWs.instances.length - 1].emit('close') // still no daemon
    }
    expect(notices()).toBeGreaterThan(2)
    vi.useRealTimers()
  })

  it('reconnects after a drop and re-announces the session', async () => {
    vi.useFakeTimers()
    await launch()
    FakeWs.instances[0].emit('close')
    await vi.advanceTimersByTimeAsync(2_100) // one flat retry interval
    expect(FakeWs.instances.length).toBe(2)
    const reopen = JSON.parse(FakeWs.instances[1].sent[0]) as Record<string, unknown>
    expect(reopen.t).toBe('open')
    // Same id → the daemon re-claims the SAME session instead of creating a second one.
    expect(reopen.launcherId).toBe(JSON.parse(FakeWs.instances[0].sent[0]).launcherId)
    vi.useRealTimers()
  })

  it('retries on a FLAT interval, so the daemon\'s 15s grace always covers several attempts', async () => {
    // The daemon declares a launcher dead after MACHINE_RECONNECT_GRACE_MS of silence. With the old
    // 0.5→1→2→4→5s backoff, how many attempts fell inside that window depended on how long the daemon had
    // already been away — the verdict got less safe the longer the outage. A flat interval fixes it.
    vi.useFakeTimers()
    try {
      await launch()
      FakeWs.instances[0].emit('close')
      const attemptsAt: number[] = []
      for (let elapsed = 0; elapsed < 15_000; elapsed += 500) {
        await vi.advanceTimersByTimeAsync(500)
        const last = FakeWs.instances[FakeWs.instances.length - 1]
        if (attemptsAt.length < FakeWs.instances.length - 1) attemptsAt.push(elapsed + 500)
        last.emit('close') // the daemon is still down
      }
      // ≥6 tries inside the grace window, and never a widening gap between them.
      expect(attemptsAt.length).toBeGreaterThanOrEqual(6)
      const gaps = attemptsAt.slice(1).map((at, i) => at - attemptsAt[i])
      expect(Math.max(...gaps)).toBeLessThanOrEqual(2_500)
    } finally { vi.useRealTimers() }
  })

  it('keeps the same machine id for the whole process, however often it reconnects', async () => {
    // The id is what binds a session to a launcher. Minting a fresh one on reconnect would orphan the
    // agent the daemon is holding for it — the reconnect would look like a brand-new launcher.
    vi.useFakeTimers()
    try {
      await launch()
      const first = JSON.parse(FakeWs.instances[0].sent[0]).launcherId as string
      for (let i = 0; i < 3; i++) {
        FakeWs.instances[FakeWs.instances.length - 1].emit('close')
        await vi.advanceTimersByTimeAsync(2_100)
      }
      expect(FakeWs.instances.length).toBe(4)
      for (const ws of FakeWs.instances) expect(JSON.parse(ws.sent[0]).launcherId).toBe(first)
    } finally { vi.useRealTimers() }
  })

  it('spawns the binary the DAEMON resolved, not this build\'s own guess', async () => {
    // Binary policy changes between builds (`commandcode` → `cmd` already happened). A launcher left over
    // from an older build must not strand the user on the old name.
    FakeWs.ack = { t: 'opened', v: 1, version: VERSION, bin: '/opt/new/location/claude', hooksReady: true }
    await launch()
    const [bin] = spawnMock.mock.calls[0] as [string]
    expect(bin).toBe('/opt/new/location/claude')
  })

  it('skips its own hook install when the daemon says it already did it', async () => {
    const { installHooksFor } = await import('./hooks.js')
    FakeWs.ack = { t: 'opened', v: 1, version: VERSION, bin: '/usr/bin/fake-claude', hooksReady: true }
    await launch()
    expect(installHooksFor).not.toHaveBeenCalled() // the daemon's (newer) definitions win
  })

  it('still spawns when the daemon never acks — a wedged daemon must not block the agent', async () => {
    FakeWs.ack = null // connected, but silent
    const { installHooksFor } = await import('./hooks.js')
    await launch([], 5_000)
    const [bin] = spawnMock.mock.calls[0] as [string]
    expect(bin).toBe('/usr/bin/fake-claude') // fell back to this build's resolution
    expect(installHooksFor).toHaveBeenCalled() // …and to installing hooks itself
  }, 10_000)

  it('warns repeatedly when the daemon refuses our protocol version', async () => {
    FakeWs.ack = { t: 'error', reason: 'unsupported_protocol', supported: [2] }
    await launch([], 5_000)
    const notices = (): unknown[][] => execFileMock.mock.calls.filter((c: unknown[]) =>
      Array.isArray(c[1]) && (c[1] as string[])[0] === 'display-message')
    // The agent runs on (killing it would be worse) but it is unreachable from the web, so unlike the
    // one-shot "a newer build exists" notice this one has to keep saying so.
    await vi.waitFor(() => expect(notices().length).toBeGreaterThan(0))
    expect((notices()[0][1] as string[]).join(' ')).toContain('exit and re-run')
  }, 10_000)

  it('reports a missing engine binary like a shell does (127), without a stack trace', async () => {
    const child = fakeChild()
    spawnMock.mockImplementation(() => child)
    await launch()
    try { child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })) } catch { /* exit */ }
    await vi.waitFor(() => expect(exitCode).toBe(127))
    expect(stderr.join('\n')).toContain('command not found')
  })
})

/**
 * The daemon can push a notice onto the pane's status line at any time. Everything in the frame is
 * ADVISORY — it crosses a version boundary (an hours-old launcher, a daemon from today) — so these tests
 * pin the two things that must never depend on the sender behaving: the text reaches tmux's FORMAT parser,
 * and a malformed frame must be a no-op rather than a broken status line.
 */
describe('daemon → launcher notices', () => {
  const notices = (): string[][] => execFileMock.mock.calls
    .filter((c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'display-message')
    .map((c: unknown[]) => c[1] as string[])
  const lastNotice = (): string[] => notices()[notices().length - 1]

  async function push(frame: Record<string, unknown>): Promise<void> {
    await launch()
    execFileMock.mockClear()
    FakeWs.instances[0].emit('message', JSON.stringify(frame))
  }

  it('always names a background, so the text can never land on its own colour', async () => {
    await push({ t: 'notice', text: 'all good', level: 'info' })
    expect(lastNotice().join(' ')).toContain('#[bg=black,fg=cyan,bold] all good')

    FakeWs.instances[0].emit('message', JSON.stringify({ t: 'notice', text: 'heads up', level: 'warn' }))
    // The bug this pins: tmux's `message-style` default is `bg=yellow`, so a foreground-only `fg=yellow`
    // rendered a solid gold bar with invisible text on a real pane.
    expect(lastNotice().join(' ')).toContain('#[bg=yellow,fg=black,bold] heads up')
    for (const args of notices()) expect(args.join(' ')).toMatch(/#\[bg=[a-z]+,fg=/)
  })

  it('never passes -N — it would swallow the user\'s keystrokes, not just hold the message', async () => {
    // Measured on a real pane: keys typed during a 6s `-N` notice never reached the child, before OR after
    // it expired. A frozen terminal is a far worse bug than a notice someone missed.
    await push({ t: 'notice', text: 'heads up', level: 'warn' })
    FakeWs.instances[0].emit('message', JSON.stringify({ t: 'notice', text: 'broken', level: 'error' }))
    for (const args of notices()) expect(args).not.toContain('-N')
  })

  it('re-posts a warning, since one keystroke erases it', async () => {
    vi.useFakeTimers()
    try {
      await push({ t: 'notice', text: 'heads up', level: 'warn' })
      expect(notices()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(notices().length).toBeGreaterThan(1)
      expect(notices().every((a) => a.join(' ').includes('heads up'))).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('does NOT re-post ordinary chatter', async () => {
    vi.useFakeTimers()
    try {
      await push({ t: 'notice', text: 'all good', level: 'info' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(notices()).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('neutralises tmux format syntax in the daemon\'s text', async () => {
    // display-message expands FORMATS (we cannot pass -l — that would print our own colour codes), so
    // `#{…}` interpolates, `#[…]` restyles and `#(…)` RUNS A SHELL COMMAND. Doubling every `#` is the fix.
    await push({ t: 'notice', text: '#{pane_id} #[fg=red]x #(id)' })
    const message = lastNotice()[lastNotice().length - 1]
    expect(message).toContain('##{pane_id}')
    expect(message).toContain('##[fg=red]x')
    expect(message).toContain('##(id)')
    // The only unescaped directives left are the ones this launcher wrote itself.
    expect(message.replace(/^#\[[^\]]+\]/, '').replace(/#\[default\]$/, '')).not.toMatch(/(^|[^#])#([^#]|$)/)
  })

  it('ignores a colour that is not a colour', async () => {
    // Escaping alone would not save this one: the payload closes the style bracket and opens its own,
    // without needing a single `#`.
    await push({ t: 'notice', text: 'hi', level: 'warn', color: 'red]#[fg=black' })
    expect(lastNotice().join(' ')).toContain('#[bg=yellow,fg=black,bold] hi')
    // The injected `]#[` never becomes a second style directive.
    expect(lastNotice().join(' ')).not.toContain('red]')

    // A colour that IS a colour is honoured — on the launcher's own background, never a supplied one.
    FakeWs.instances[0].emit('message', JSON.stringify({ t: 'notice', text: 'hi', color: 'colour214' }))
    expect(lastNotice().join(' ')).toContain('#[bg=black,fg=colour214,bold] hi')
  })

  it('clamps the duration instead of trusting it', async () => {
    await push({ t: 'notice', text: 'a', durationMs: 999_999_999 })
    expect(lastNotice()[lastNotice().indexOf('-d') + 1]).toBe('15000')

    FakeWs.instances[0].emit('message', JSON.stringify({ t: 'notice', text: 'b', durationMs: -5 }))
    expect(lastNotice()[lastNotice().indexOf('-d') + 1]).toBe('1000')

    FakeWs.instances[0].emit('message', JSON.stringify({ t: 'notice', text: 'c', durationMs: 'soon' }))
    expect(lastNotice()[lastNotice().indexOf('-d') + 1]).toBe('6000') // the launcher's own default
  })

  it('shrugs off a malformed notice rather than showing garbage', async () => {
    await push({ t: 'notice' })                                   // no text at all
    expect(notices()).toHaveLength(0)

    FakeWs.instances[0].emit('message', JSON.stringify({ t: 'notice', text: '   ' }))
    expect(notices()).toHaveLength(0)                             // nothing left after trimming

    FakeWs.instances[0].emit('message', JSON.stringify({ t: 'notice', text: 'ok', level: 'catastrophe' }))
    expect(lastNotice().join(' ')).toContain('#[bg=black,fg=cyan,bold] ok') // unknown level ⇒ info
    expect(lastNotice()).not.toContain('-N')
  })

  it('ignores a frame type it has never heard of', async () => {
    // The compatibility mechanism for every FUTURE daemon→launcher frame: a launcher released today must
    // sit quietly through whatever a daemon from next year sends it.
    await push({ t: 'some-future-frame', text: 'x', payload: { a: 1 } })
    expect(notices()).toHaveLength(0)
    expect(stderr.join('')).toBe('')
  })

  it('explains a disconnect that the daemon itself just announced', async () => {
    await push({ t: 'notice', text: 'machine is updating — restarting now', level: 'warn' })
    FakeWs.instances[0].emit('close')

    // Telling someone to run `harness join` while the daemon is already coming back is wrong advice at
    // the worst possible moment.
    expect(lastNotice().join(' ')).toContain('restarting')
    expect(lastNotice().join(' ')).not.toContain('harness join')
  })

  it('still gives the plain disconnect advice when nothing warned us', async () => {
    await launch()
    execFileMock.mockClear()
    FakeWs.instances[0].emit('close')
    expect(lastNotice().join(' ')).toContain('harness join')
  })
})
/**
 * Deleting an agent must end the launcher and the engine — and leave the tmux pane alone. These pin the
 * launcher's half: it stops its child itself, routes teardown through the ONE existing exit path, and
 * never treats the resulting socket close as "the daemon vanished".
 */
describe('daemon → launcher exit request', () => {
  const notices = (): string[][] => execFileMock.mock.calls
    .filter((c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'display-message')
    .map((c: unknown[]) => c[1] as string[])

  it('SIGTERMs the engine and says why on the status bar', async () => {
    const child = fakeChild()
    spawnMock.mockImplementation(() => child)
    await launch()
    execFileMock.mockClear()

    FakeWs.instances[0].emit('message', JSON.stringify({ t: 'exit', reason: 'deleted' }))

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(notices()[0]?.join(' ')).toContain('deleted')
    // Not tmux's problem: the pane and its shell survive this.
    expect(execFileMock.mock.calls.some((c: unknown[]) => (c[1] as string[])?.[0] === 'kill-pane')).toBe(false)
  })

  it('escalates to SIGKILL if the engine will not go', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      spawnMock.mockImplementation(() => child)
      await launch()
      FakeWs.instances[0].emit('message', JSON.stringify({ t: 'exit' }))
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')

      await vi.advanceTimersByTimeAsync(3_100)
      // A CLI that traps SIGTERM for a confirmation prompt would otherwise survive its own deletion.
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally { vi.useRealTimers() }
  })

  it('lets the existing child-exit path do the teardown, not a second one', async () => {
    const child = fakeChild()
    spawnMock.mockImplementation(() => child)
    await launch()
    const ws = FakeWs.instances[0]

    ws.emit('message', JSON.stringify({ t: 'exit' }))
    expect(ws.closed).toBe(false) // the socket stays up until the engine is actually gone

    try { child.emit('exit', 0, null) } catch { /* mocked process.exit throws */ }
    await vi.waitFor(() => expect(exitCode).toBe(0))
    expect(ws.closed).toBe(true)
  })

  it('stops reconnecting — a close after this is expected, not a lost daemon', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      spawnMock.mockImplementation(() => child)
      await launch()
      FakeWs.instances[0].emit('message', JSON.stringify({ t: 'exit' }))
      execFileMock.mockClear()

      FakeWs.instances[0].emit('close')
      await vi.advanceTimersByTimeAsync(6_000)

      expect(FakeWs.instances).toHaveLength(1)                      // no reconnect attempt
      const said = notices().map((a) => a.join(' ')).join('\n')
      expect(said).not.toContain('harness join')                    // and no misleading advice
    } finally { vi.useRealTimers() }
  })

  it('handles an exit that arrives before the engine was even spawned', async () => {
    // The daemon can answer `open` and then delete the agent while the launcher is still waiting on its
    // ack — there is no child to stop yet, and the request must not be dropped on the floor.
    const child = fakeChild()
    spawnMock.mockImplementation(() => {
      setTimeout(() => FakeWs.instances[0].emit('message', JSON.stringify({ t: 'exit' })), 0)
      return child
    })
    await launch()
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'))
  })
})
