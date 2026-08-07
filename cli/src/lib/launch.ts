/**
 * `harness <engine> [args…]` — run an agent CLI inside the CURRENT tmux pane, wrapped so the adapter
 * owns its lifecycle.
 *
 * Design (see the machine-ID architecture):
 *  - **No PTY library.** The command already runs in a tmux pane, so the pane IS the pty: `stdio:
 *    'inherit'` hands the child the real tty. `capture-pane` output is byte-identical to running the
 *    CLI natively (verified), so submit-verification / question-scraping / the `/model` picker all keep
 *    working unchanged. That also means this file must print NOTHING to the pane while the child runs —
 *    any stray line would land inside the child's TUI. Mid-session notices go to the tmux status bar via
 *    `display-message` instead.
 *  - **Machine ID owns the session.** Each launch mints a UUID, exports it as `MACHINE_ID` for the child,
 *    and opens it with the daemon. The engine's own hook reports that id back at registration, so a
 *    session exists in the adapter only while its launching wrapper is alive.
 *  - **Two hard gates**: must be inside tmux, and the daemon must already be joined + running. Neither is
 *    auto-provisioned — we refuse with an instruction instead of doing something behind the user's back.
 */

import { execFile, spawn } from 'child_process'
import { refusalMessage } from './duplicateAgent.js'
import { randomUUID } from 'crypto'
import { WebSocket } from 'ws'
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import type { AgentEngine } from '../engines/types.js'
import { daemonPort, hasSavedToken, isDaemonRunning } from './daemonState.js'
import { engineBin, engineCommand } from './engineBin.js'
import { permissionArgsFor } from './enginePermissions.js'
import { MACHINE_WS_PATH } from './launcherSessions.js'
import {
  LAUNCHER_PROTOCOL_V, isSupportedProtocol,
  type LauncherDownFrame, type LauncherNoticeFrame, type LauncherNoticeLevel, type LauncherOpenedFrame,
} from './launcherProtocol.js'
import { installHooksFor } from './hooks.js'

const PANE_RE = /^%\d+$/
/** How long each status-bar warning stays up. Must EXCEED the reconnect interval (RETRY_MS) so
 *  consecutive notices OVERLAP and the line never blinks out between them. tmux's own `display-time`
 *  default is 750ms, which flashed past unseen. Deliberately finite rather than `-d 0` ("stay until a key
 *  is pressed"), because that variant consumes the next keystroke — and the user is typing into the agent. */
const NOTICE_MS = 6_000
/** How long to wait for the daemon's `opened` ack before falling back to this build's own answers. */
const ACK_WAIT_MS = 2_000

function fail(lines: string[]): never {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** The running daemon's health, build and supported protocols — or null when it is not answering. */
async function daemonInfo(timeoutMs = 2_000): Promise<{ version?: string; protocols?: number[] } | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/health`, { signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json().catch(() => ({}))) as { version?: string; protocols?: number[] }
  } catch { return null } finally { clearTimeout(timer) }
}

/**
 * Style per level — foreground AND background, always both.
 *
 * tmux paints the status message with `message-style`, which defaults to `bg=yellow,fg=black`. Setting
 * only a foreground therefore gambles on the user's theme, and loses: `fg=yellow` on that default
 * rendered yellow-on-yellow — a solid gold bar with the text invisible inside it (seen on a real pane,
 * 2026-08-03). Naming the background too makes contrast ours to guarantee rather than theirs to supply.
 *
 * `warn` deliberately matches the tmux default, so the common case looks native rather than decorated.
 */
const LEVEL_STYLE: Record<LauncherNoticeLevel, string> = {
  info: 'bg=black,fg=cyan,bold',
  warn: 'bg=yellow,fg=black,bold',
  error: 'bg=red,fg=white,bold',
}
/** A tmux colour name (`red`, `brightblack`, `colour214`) or `#rrggbb`. Anything else is not a colour. */
const SAFE_COLOUR = /^(?:[a-zA-Z][a-zA-Z0-9]{0,15}|#[0-9a-fA-F]{6})$/
const NOTICE_MIN_MS = 1_000
const NOTICE_MAX_MS = 15_000
const NOTICE_MAX_CHARS = 300
/** Gap between the repeats a warning gets, so one keystroke cannot erase it for good. */
const NOTICE_REPEAT_MS = 2_500
/** How often the launcher re-dials a daemon that is not answering. Flat, and coupled to
 *  MACHINE_RECONNECT_GRACE_MS (cli.ts, 15s): the grace covers several of these, so "it never came back"
 *  is a verdict about the launcher, not about how long a backoff happened to have grown. */
const RETRY_MS = 2_000
/** SIGTERM → SIGKILL for the engine when the agent is deleted. Coupled to `FALLBACK_CHECK_MS`
 *  (deleteAgentFallback.ts), which must stay LONGER so a launcher that got the request always wins. */
const LAUNCHER_EXIT_GRACE_MS = 3_000

/**
 * Make daemon-supplied text safe to hand to `tmux display-message`.
 *
 * That command runs its argument through tmux's FORMATS parser (we cannot pass `-l`, which would print
 * our own colour directives literally). So `#` is live syntax there — `#{…}` interpolates variables,
 * `#[…]` switches style mid-string, and `#(…)` runs a shell command. Doubling every `#` is what turns the
 * message back into text. Control characters go too: the status line is one row, and a stray ESC would
 * repaint it.
 */
function escapeNoticeText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/#/g, '##')
    .slice(0, NOTICE_MAX_CHARS)
    .trim()
}

/**
 * Status-bar notice on the pane running the agent. Deliberately NOT stdout: writing into the pane would
 * corrupt the child's TUI and the pane captures the adapter scrapes. Best-effort.
 *
 * A status message is erased by the user's next keystroke, so a warning shown once is a warning missed.
 * The fix is to REPEAT it, not to make it sticky: tmux's `-N` ("ignore key presses") does not merely keep
 * the message up, it swallows the keystrokes entirely — measured on a real pane, keys typed during a 6s
 * `-N` notice never reached the child, before or after it expired. That is a frozen terminal and lost
 * input, which is far worse than a missed notice. So warnings re-post a couple of times instead, and the
 * user keeps typing throughout.
 */
function paneNotice(pane: string, message: string, opts: {
  level?: LauncherNoticeLevel
  color?: string
  durationMs?: number
} = {}): void {
  const level: LauncherNoticeLevel = opts.level && opts.level in LEVEL_STYLE ? opts.level : 'info'
  // An override picks the text colour only; the background stays ours, so no colour the daemon sends can
  // land on top of itself.
  const style = opts.color && SAFE_COLOUR.test(opts.color)
    ? `bg=black,fg=${opts.color},bold`
    : LEVEL_STYLE[level]
  const ms = Number.isFinite(opts.durationMs)
    ? Math.min(NOTICE_MAX_MS, Math.max(NOTICE_MIN_MS, Math.round(opts.durationMs as number)))
    : NOTICE_MS
  const text = escapeNoticeText(message)
  if (!text) return
  const args = ['display-message', '-d', String(ms), '-t', pane, `#[${style}] ${text} #[default]`]
  const post = (): void => { execFile('tmux', args, { timeout: 2_000 }, () => { /* best effort */ }) }
  post()
  if (level === 'info') return
  // Two more chances to be read, since the first one dies with the next keystroke. Unref'd: a notice must
  // never be the reason this process outlives the agent it wraps.
  for (const delay of [NOTICE_REPEAT_MS, NOTICE_REPEAT_MS * 2]) {
    const timer = setTimeout(post, delay)
    timer.unref?.()
  }
}

/**
 * The launcher's lifeline to the daemon.
 *
 * One WebSocket, open for the whole run. It carries no terminal data — only `{t:'open'}` — because its
 * VALUE IS ITS EXISTENCE: while it is up the daemon knows this launcher lives (no `ps` scanning), and the
 * moment it drops we know the daemon is gone (no health polling). Both directions are now event-driven
 * instead of the two 3-5s poll loops this replaced.
 *
 * A drop is never fatal: the agent keeps running and we reconnect with backoff, so a daemon self-update
 * (which restarts it) reclaims the session within ~1s instead of orphaning it.
 */
class LauncherLink {
  private ws: WebSocket | null = null
  private retry: NodeJS.Timeout | null = null
  private disposed = false
  private everConnected = false
  /** Is the daemon reachable right now? */
  up = false
  /** True once the daemon has told us it cannot speak our protocol version. */
  incompatible = false
  private resolveAck: ((frame: LauncherOpenedFrame) => void) | null = null
  /** Called on every up→down / down→up transition (not on the first connect). */
  onState: (up: boolean) => void = () => { /* set by the caller */ }
  /** Called on each failed reconnect while still down — the caller re-posts its notice. A tmux status
   *  message is transient (it clears after `display-time` OR on the next key press, and the user is
   *  typing into the agent), so a single announcement WILL be missed. */
  onStillDown: () => void = () => { /* set by the caller */ }
  /** Called when the daemon refuses our protocol version — the agent runs on, but is unreachable from the
   *  web until the user restarts it, so this one is announced repeatedly. */
  onIncompatible: () => void = () => { /* set by the caller */ }
  /** Called when the daemon reports a different BUILD. Informational: protocol compatibility is what
   *  decides whether things work; this only tells the user a newer machine is live. */
  onStaleBuild: (daemonVersion: string) => void = () => { /* set by the caller */ }
  /** Called for a notice the daemon pushed on its own initiative. */
  onNotice: (frame: LauncherNoticeFrame) => void = () => { /* set by the caller */ }
  /** Called when the daemon asks this agent to end (the user deleted it). */
  onExitRequested: (reason: string | undefined) => void = () => { /* set by the caller */ }
  /** Set if the request arrived before the caller had a child to stop — it re-runs the callback itself. */
  exitRequested: string | undefined | false = false
  /**
   * When the daemon last warned us, so a drop right after can be explained instead of misreported.
   *
   * A daemon that says "I am restarting" and then closes the socket is not the same event as a daemon
   * that vanished — but they look identical from here, and the ordinary message tells the user to run
   * `harness join`, which would be wrong advice while the daemon is already coming back on its own.
   */
  private warnedAt = 0
  /** True while a warning from the daemon is recent enough to explain the current disconnect. */
  recentlyWarned(withinMs = 30_000): boolean {
    return this.warnedAt > 0 && Date.now() - this.warnedAt < withinMs
  }

  constructor(
    private readonly launcherId: string,
    private readonly engine: AgentEngine,
    private readonly pane: string,
    private readonly cwd: string,
  ) {}

  connect(): void {
    if (this.disposed || this.ws) return
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${daemonPort()}${MACHINE_WS_PATH}`)
    } catch { this.scheduleRetry(); return }
    this.ws = ws

    ws.on('open', () => {
      const wasDown = this.everConnected && !this.up
      this.up = true
      this.everConnected = true
      try {
        ws.send(JSON.stringify({
          t: 'open', v: LAUNCHER_PROTOCOL_V, launcherId: this.launcherId, engine: this.engine,
          tmuxPane: this.pane, cwd: this.cwd, version: VERSION,
        }))
      } catch { /* the close handler will retry */ }
      if (wasDown) this.onState(true)
    })
    // The ack is not decoration: it carries the engine binary and whether the daemon installed the
    // hooks, i.e. the two decisions moved OUT of this (possibly outdated) launcher.
    ws.on('message', (raw: unknown) => {
      let frame: LauncherDownFrame
      try { frame = JSON.parse(String(raw)) as LauncherDownFrame } catch { return }
      if (frame.t === 'error') {
        // The daemon cannot speak our protocol. The agent keeps running — killing someone's session over
        // this would be worse — but it is NOT remote-controllable, so say so until they restart it.
        this.incompatible = frame.reason === 'unsupported_protocol'
        if (this.incompatible) this.onIncompatible()
        return
      }
      if (frame.t === 'exit') {
        // The agent was deleted. Stop reconnecting FIRST: the socket is about to close for a known reason,
        // and the disconnect notice would otherwise tell the user their agent lost the daemon.
        this.stopReconnecting()
        this.exitRequested = typeof frame.reason === 'string' ? frame.reason : undefined
        this.onExitRequested(this.exitRequested)
        return
      }
      if (frame.t === 'notice') {
        // Nothing here trusts the frame: `text` may be missing on a malformed one, and everything else is
        // clamped downstream in paneNotice. A bad notice must be a no-op, never a crash — and never a
        // console line, which would land inside the child's TUI.
        if (typeof frame.text === 'string' && frame.text) {
          if (frame.level === 'warn' || frame.level === 'error') this.warnedAt = Date.now()
          this.onNotice(frame)
        }
        return
      }
      if (frame.t !== 'opened') return
      this.resolveAck?.(frame)
      this.resolveAck = null
      if (frame.version && frame.version !== VERSION) this.onStaleBuild(frame.version)
    })
    // 'error' is always followed by 'close', so recovery lives in one place.
    ws.on('error', () => { /* handled by close */ })
    ws.on('close', () => {
      this.ws = null
      if (this.disposed) return
      if (this.up) { this.up = false; this.onState(false) }
      this.scheduleRetry()
    })
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retry) return
    // A FLAT interval, not a backoff. The daemon decides a launcher is dead when it has not reconnected
    // within MACHINE_RECONNECT_GRACE_MS (cli.ts) — and that verdict is only as good as the retry rhythm
    // behind it. At a fixed 2s the 15s grace always covers several whole attempts; the old 0.5→1→2→4→5s
    // backoff made the number of attempts inside that window depend on how long the daemon had already
    // been away, so a long outage quietly made the verdict less safe. Keep trying forever: the user is
    // still working in the agent, and the daemon may come back at any time (`harness join`, self-update).
    const delay = RETRY_MS
    this.retry = setTimeout(() => {
      this.retry = null
      // Re-announce BEFORE retrying: if the daemon is still gone the notice is back on screen within a
      // few seconds of being dismissed, instead of the user seeing it once and losing it.
      if (this.everConnected && !this.up) this.onStillDown()
      this.connect()
    }, delay)
    this.retry.unref?.()
  }

  /**
   * The daemon's answer to our `open`, or null if it does not arrive in time.
   *
   * Bounded on purpose: the ack decides the binary and the hooks, but waiting for a daemon that is wedged
   * must NEVER stop the user's agent from starting — on timeout the launcher falls back to its own
   * (possibly older) resolution and spawns anyway.
   */
  waitForAck(timeoutMs: number): Promise<LauncherOpenedFrame | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.resolveAck = null; resolve(null) }, timeoutMs)
      timer.unref?.()
      this.resolveAck = (frame) => { clearTimeout(timer); resolve(frame) }
    })
  }

  /**
   * Stop chasing the daemon, but leave the socket open.
   *
   * Not `dispose()`: this runs while the engine is still shutting down, and the socket must stay up until
   * the child actually exits so teardown keeps flowing through the ONE existing path (`child.on('exit')`
   * → `closeSession()`), instead of a second one racing it.
   */
  stopReconnecting(): void {
    this.disposed = true
    if (this.retry) { clearTimeout(this.retry); this.retry = null }
  }

  /** End the session: closing the socket is what tells the daemon to drop the tile immediately. */
  dispose(): void {
    this.disposed = true
    if (this.retry) { clearTimeout(this.retry); this.retry = null }
    const ws = this.ws
    this.ws = null
    try { ws?.close() } catch { /* already gone */ }
  }
}

/**
 * Launch `engine` with `argv` forwarded verbatim. Returns never — it always ends the process with the
 * child's exit status so `harness claude …` is indistinguishable from `claude …` to the calling shell.
 */
export async function launchEngine(engine: AgentEngine, argv: string[]): Promise<never> {
  // ── Gate 1: must already be inside tmux. The machine never creates a tmux session; the pane is what
  // gives us both the pty and the addressable target the remote side types into.
  const pane = process.env.TMUX_PANE ?? ''
  if (!process.env.TMUX || !PANE_RE.test(pane)) {
    fail([
      `\n  ✗ harness ${engineCommand(engine)} must run inside tmux.`,
      '',
      '    Start one, then run it again:',
      '      tmux new -s work',
      `      harness ${engineCommand(engine)}\n`,
    ])
  }

  // ── Gate 2: the daemon must already be joined AND running. We never start it implicitly.
  const info = isDaemonRunning() ? await daemonInfo() : null
  if (!info) {
    fail(hasSavedToken()
      ? [
          '\n  ✗ The machine adapter is not running on this computer.',
          '',
          '    Start it (the saved credential is reused):',
          '      harness join\n',
        ]
      : [
          '\n  ✗ This computer has not joined a machine yet.',
          '',
          '    Join it with the token from your machine page:',
          '      harness join <token>\n',
        ])
  }

  // ── Gate 3: the daemon must be able to SPEAK to us. Deliberately a protocol check, not a build check:
  // launcher and daemon come from the same OTA bundle but a running launcher keeps its build for hours,
  // so different builds are normal and fine — only an unsupported PROTOCOL actually breaks the session.
  // (A daemon predating protocol advertisement is a v1 daemon.)
  const protocols = info.protocols ?? [1]
  if (!protocols.includes(LAUNCHER_PROTOCOL_V)) {
    fail([
      `\n  ✗ The running machine is too old to talk to this CLI (it speaks protocol v${protocols.join('/')}, this needs v${LAUNCHER_PROTOCOL_V}).`,
      '',
      '    Restart it on the current build:',
      '      harness stop && harness join\n',
    ])
  }

  // ── Open the machine session over a WebSocket that stays up for the whole run. The SOCKET is the
  // liveness signal in both directions: while it is open the daemon knows this launcher lives, and the
  // moment it drops we know the daemon is gone — no polling on either side.
  const launcherId = randomUUID()
  const link = new LauncherLink(launcherId, engine, pane, process.cwd())

  // Wire the notices BEFORE connecting. The daemon can refuse our protocol on the very first frame, and
  // callbacks attached after the spawn would miss it — the user would then get no warning at all for the
  // one case where the agent is live but permanently unreachable.
  // Every notice goes to the tmux status bar, never into the pane the TUI is drawing in.
  const incompatibleNotice = (): void =>
    paneNotice(pane, `harness was updated and can no longer drive this agent · exit and re-run: harness ${engineCommand(engine)}`, { level: 'error' })
  // A drop right after the daemon warned us is the daemon restarting ITSELF (an update), and it comes back
  // on its own — telling the user to run `harness join` there would be wrong advice at the worst moment.
  const disconnectedNotice = (): void => link.recentlyWarned()
    ? paneNotice(pane, 'harness is restarting — this agent reconnects on its own', { level: 'warn' })
    : paneNotice(pane, 'harness disconnected — this agent is no longer remote-controllable · run: harness join', { level: 'warn' })
  link.onState = (up: boolean): void => {
    if (up) paneNotice(pane, 'harness reconnected')
    else disconnectedNotice()
  }
  link.onStillDown = (): void => { link.incompatible ? incompatibleNotice() : disconnectedNotice() }
  // Anything the daemon decides the person in this pane should see. The frame is advisory: paneNotice
  // clamps the duration, filters the colour and escapes the text before any of it reaches tmux.
  link.onNotice = (frame: LauncherNoticeFrame): void =>
    paneNotice(pane, frame.text, { level: frame.level, color: frame.color, durationMs: frame.durationMs })
  link.onIncompatible = incompatibleNotice
  link.onStaleBuild = (daemonVersion: string): void => {
    paneNotice(pane, `harness updated to v${daemonVersion} (this agent runs v${VERSION}) · exit and re-run: harness ${engineCommand(engine)}`)
  }

  // A refusal has to be acted on the INSTANT it lands, not after the ack wait: the daemon closes the
  // socket ~2ms behind the `exit` frame, and the close path ends this process — measured, the launcher
  // exited 0 in silence with the check below never reached. Nothing has spawned yet at this point, so
  // saying so and leaving IS the whole handling; once the engine exists, line ~478 takes this over with
  // the teardown that stops it.
  link.onExitRequested = (reason: string | undefined): never => fail(refusalMessage(reason))

  link.connect()

  // ── Let the DAEMON decide the two things that change between builds: which binary an engine maps to,
  // and what this engine's hooks look like. A launcher left over from an older build would otherwise
  // spawn a stale binary name and install stale hook definitions. Bounded wait — a wedged daemon must
  // never stop the agent from starting, so on timeout we fall back to this build's own answers.
  const ack = await link.waitForAck(ACK_WAIT_MS)
  // The daemon can turn a launch away outright — today only "one muse agent per directory", where a
  // second agent could never be told apart from the first. It arrives as `exit` in place of the ack, so
  // there is no `opened` and `waitForAck` simply times out. Bail HERE, in the gap before the spawn: the
  // engine has not started, so the pane returns to the shell instead of flashing a CLI that something
  // else kills a moment later (which is what an older launcher, acting on this only after spawning, does).
  if (link.exitRequested !== false) fail(refusalMessage(link.exitRequested || undefined))
  const bin = ack?.bin || engineBin(engine)
  if (!ack?.hooksReady && !env.DISABLE_HOOK_INSTALL) {
    // Fallback only. The installers narrate to stdout, which here is the user's pane — a stray
    // "[hooks] …" line would print above the CLI's TUI, so swallow their chatter.
    const { log, error, warn } = console
    console.log = console.error = console.warn = () => { /* silence: this is the user's terminal */ }
    try { installHooksFor(engine, daemonPort()) } catch { /* never block the launch on hook install */ }
    finally { Object.assign(console, { log, error, warn }) }
  }

  // ── Permissions. Nobody is watching this pane — it is driven from web/device — so an agent that stops
  // to ask is an agent that never answers. Add the engine's bypass flags unless the user named their own
  // policy (that is the only opt-out, by design). Flags are the whole mechanism: where a CLI keeps its
  // directory trust in a config file and offers no flag (devin, codex), machine leaves that prompt alone
  // and the user answers it once, here in the pane, rather than machine editing their config for them.
  const launchArgv = [...argv, ...permissionArgsFor(engine, argv)]

  // ── Spawn. `stdio: 'inherit'` → the child owns the real tty (colors, keys, resize, isTTY all native).
  // TMUX / TMUX_PANE are deliberately kept (the opposite of the recap one-shots, which scrub them so they
  // cannot self-register) — the engine's hook needs the pane, and now the machine id too.
  const child = spawn(bin, launchArgv, {
    stdio: 'inherit',
    env: {
      ...process.env,
      MACHINE_ID: launcherId,
      // Muse's launcher forks a background self-update on every invocation and can replace both the
      // script and the binary while the user is mid-session. Pin it: an agent must not change under
      // the person using it.
      ...(engine === 'muse' ? { MUSE_NO_AUTO_UPDATE: '1' } : {}),
      // Amp's plugin runs under Bun with its own directory as `process.cwd()` — measured: it reported
      // `<project>/.amp/plugins`, not the project. The transcript's `cwd` is what re-binds a session
      // after a restart, so a wrong one there means an agent that can never be re-found. The launcher is
      // standing in the right directory, so it simply says which one.
      ...(engine === 'amp' ? { HARNESS_AGENT_CWD: process.cwd() } : {}),
    },
  })

  const closeSession = async (): Promise<void> => { link.dispose() }

  /**
   * The agent was deleted from the web or the device: end the engine, and let the existing child-exit
   * handler end this wrapper. The tmux pane is untouched — the user gets their shell prompt back.
   *
   * SIGTERM, then SIGKILL if the engine will not go: "delete" has to mean deleted, and a CLI that traps
   * SIGTERM for a confirmation prompt would otherwise leave an agent running that nothing on screen
   * accounts for. The daemon has its own, later backstop for launchers too old to receive this at all.
   */
  let exiting = false
  const endForDeletion = (reason: string | undefined): void => {
    if (exiting) return
    exiting = true
    paneNotice(pane, `harness: this agent was deleted${reason ? ` (${reason})` : ''} — closing`, { level: 'warn' })
    try { child.kill('SIGTERM') } catch { /* already gone; the exit handler runs either way */ }
    const grace = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, LAUNCHER_EXIT_GRACE_MS)
    grace.unref?.()
  }
  link.onExitRequested = endForDeletion
  // The frame can arrive while we were still waiting for the ack, i.e. before there was a child to stop.
  if (link.exitRequested !== false) endForDeletion(link.exitRequested)

  // Ctrl-C is delivered by the tty driver to the whole foreground process group, so the child already
  // gets it — the wrapper must NOT die first, or the shell would take the prompt back while the agent is
  // still drawing. Ignore it here and let the child decide, exactly like running the CLI directly.
  process.on('SIGINT', () => { /* child handles it */ })
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { try { child.kill(sig) } catch { /* already gone */ } })
  }


  child.on('error', (err: NodeJS.ErrnoException) => {
    // `.catch` after the exit: nothing here may surface as an unhandled rejection — the close is
    // best-effort and the handler's last act is to end the process anyway.
    void closeSession().finally(() => {
      if (err.code === 'ENOENT') {
        console.error(`machine: ${bin}: command not found`)
        process.exit(127) // same code a shell uses for a missing command
      }
      console.error(`machine: failed to start ${bin}: ${err.message}`)
      process.exit(1)
    }).catch(() => { /* exit already requested */ })
  })

  child.on('exit', (code, signal) => {
    // `.catch` after the exit: nothing here may surface as an unhandled rejection — the close is
    // best-effort and the handler's last act is to end the process anyway.
    void closeSession().finally(() => {
      // Re-raise the signal on ourselves so the calling shell reports the death exactly as it would for
      // the CLI run directly (e.g. 130 for SIGINT), instead of a synthesized exit code.
      if (signal) { process.kill(process.pid, signal); return }
      process.exit(code ?? 0)
    }).catch(() => { /* exit already requested */ })
  })

  // Keep the event loop alive until one of the handlers above exits the process.
  return new Promise<never>(() => { /* resolved by process.exit */ })
}
