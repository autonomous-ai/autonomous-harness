import { execFile } from 'node:child_process'
import type { TerminalBackend } from './terminalBackend.js'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionNotStarted,
  terminalActionPossiblyExecuted,
  type TerminalActionResult,
  type TerminalCaptureOptions,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalInventoryResult,
  type TerminalLogicalKey,
  type TerminalProcessExpectation,
  type TerminalReadResult,
  type TerminalStreamHandle,
  type TerminalStreamSink,
  type TerminalStreamSize,
  type TmuxRuntimeRef,
  type RuntimeValidation,
} from './terminalTypes.js'
import { TmuxControlStream } from './tmuxStream.js'
import {
  captureTmuxPane,
  listPaneTitles,
  resolvePaneEngineProcess,
  sendKeyToTmux,
  sendLiteralToTmux,
  sendToTmux,
  setPaneMouseOn,
} from './tmux.js'
import { listTmuxPanes } from './tmuxAgentDiscovery.js'
import { terminalRouteKey } from './terminalRuntime.js'

const TMUX_KEYS: Record<TerminalLogicalKey, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backtab: 'BTab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  backspace: 'BSpace',
  delete: 'DC',
  pageup: 'PPage',
  pagedown: 'NPage',
  'ctrl-c': 'C-c',
  'ctrl-d': 'C-d',
  'ctrl-u': 'C-u',
  'ctrl-w': 'C-w',
  space: 'Space',
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
}

function legacyActionResult(ok: boolean, operation: string): TerminalActionResult {
  // The legacy helper has spawned tmux before it reports false, so execution cannot safely be ruled out.
  return ok ? TERMINAL_ACTION_SUCCEEDED : terminalActionPossiblyExecuted(`${operation} did not complete`)
}

export class TmuxBackend implements TerminalBackend<TmuxRuntimeRef> {
  readonly name = 'tmux' as const
  readonly instanceId = 'tmux:default'

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResult<TmuxRuntimeRef>> {
    const args = ['new-session', '-d', '-P', '-F', '#{pane_id}']
    if (request.cwd) args.push('-c', request.cwd)
    if (request.label) args.push('-s', request.label)
    // Trailing args after this point become the session's shell-command. tmux execs them directly
    // (no shell interposed) when given as separate argv elements, so no quoting/escaping is needed.
    if (request.command?.length) args.push(...request.command)
    // Keep the pane when its process dies, so an engine that exits immediately (not logged in, bad
    // config) still has its error text readable afterwards instead of taking the whole session down
    // with it. Chained into THIS tmux invocation on purpose: an engine can exit in under a
    // millisecond, and a second `set-option` call loses that race — measured, the session was
    // already gone before the follow-up command could reach the server.
    // Whoever created the pane owns turning this back off; see `clearPaneRemainOnExit`.
    args.push(';', 'set-option', '-w', 'remain-on-exit', 'on')
    // `killed`/`signal` come from execFile's own error shape, which ErrnoException alone does not declare.
    type ExecError = NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null }
    const result = await new Promise<{ error: ExecError | null; stdout: string; stderr: string }>((resolve) => {
      execFile('tmux', args, { timeout: 5_000 }, (error, stdout, stderr) => resolve({
        error: error as ExecError | null,
        stdout,
        stderr,
      }))
    })
    if (result.error) {
      if (result.error.code === 'ENOENT') return terminalActionNotStarted('tmux is unavailable')
      // tmux says exactly why it refused — "duplicate session", "protocol version mismatch",
      // a .tmux.conf error, a directory it cannot enter. Dropping stderr here turned every one of
      // those into the same unactionable SPAWN_FAILED, diagnosable only by reading the daemon log
      // on the machine that failed, which does not have the reason either.
      const detail = result.stderr.trim().split('\n')[0]?.slice(0, 200)
        // execFile reports a timeout kill as SIGTERM with no stderr — the one failure whose cause
        // is not in tmux's own output.
        || (result.error.killed ? 'tmux did not answer within 5s' : result.error.message.slice(0, 200))
      return terminalActionPossiblyExecuted(`tmux session creation did not complete: ${detail}`)
    }
    const paneId = result.stdout.trim()
    if (!/^%\d+$/.test(paneId)) {
      return terminalActionPossiblyExecuted('tmux created a session without returning its root pane')
    }
    await setPaneMouseOn(paneId)
    return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId } }
  }

  async kill(runtime: TmuxRuntimeRef): Promise<TerminalActionResult> {
    const sessionId = await new Promise<string | null>((resolve) => {
      execFile('tmux', ['display-message', '-p', '-t', runtime.paneId, '#{session_id}'], { timeout: 2_000 }, (error, stdout) => {
        const value = stdout.trim()
        resolve(!error && /^\$\d+$/.test(value) ? value : null)
      })
    })
    if (!sessionId) return terminalActionNotStarted('tmux session could not be resolved from pane')
    const ok = await new Promise<boolean>((resolve) => {
      execFile('tmux', ['kill-session', '-t', sessionId], { timeout: 5_000 }, (error) => resolve(!error))
    })
    return legacyActionResult(ok, 'tmux session close')
  }

  async titles(): Promise<TerminalReadResult<Map<string, string>>> {
    const titles = await listPaneTitles()
    return {
      state: 'succeeded',
      value: new Map([...titles].map(([paneId, title]) => [terminalRouteKey({ backend: 'tmux', paneId }), title])),
    }
  }

  async inventory(): Promise<TerminalInventoryResult> {
    const result = await listTmuxPanes()
    if (!result.ok) return { state: 'unavailable', reason: result.error }
    return {
      state: 'available',
      roots: result.panes.map((pane) => ({
        runtime: { backend: 'tmux' as const, paneId: pane.tmuxPane },
        rootPid: pane.rootPid,
        cwd: pane.cwd,
      })),
    }
  }

  async validate(runtime: TmuxRuntimeRef, expected: TerminalProcessExpectation): Promise<RuntimeValidation> {
    try {
      const live = await resolvePaneEngineProcess(runtime.paneId, expected.engine)
      if (!live) return { state: 'gone', reason: `no ${expected.engine} process under tmux pane` }
      if (expected.processIdentity
        && (expected.processIdentity.pid !== live.pid || expected.processIdentity.startMarker !== live.startMarker)) {
        return { state: 'gone', reason: 'process changed under tmux pane' }
      }
      return { state: 'alive' }
    } catch {
      return { state: 'unknown', reason: 'tmux runtime probe failed' }
    }
  }

  async capture(runtime: TmuxRuntimeRef, options: TerminalCaptureOptions = {}): Promise<TerminalReadResult<string>> {
    const captured = await captureTmuxPane(runtime.paneId, options.historyLines, {
      visible: options.mode === 'visible',
      ansi: options.ansi,
    })
    return captured === null
      ? { state: 'failed', reason: 'tmux capture failed' }
      : { state: 'succeeded', value: captured }
  }

  async typeLiteral(runtime: TmuxRuntimeRef, text: string): Promise<TerminalActionResult> {
    return legacyActionResult(await sendLiteralToTmux(runtime.paneId, text), 'tmux literal input')
  }

  async submitText(runtime: TmuxRuntimeRef, text: string): Promise<TerminalActionResult> {
    return legacyActionResult(await sendToTmux(runtime.paneId, text), 'tmux submission')
  }

  async sendKey(runtime: TmuxRuntimeRef, key: TerminalLogicalKey): Promise<TerminalActionResult> {
    return legacyActionResult(await sendKeyToTmux(runtime.paneId, TMUX_KEYS[key]), 'tmux key input')
  }

  async setTitle(runtime: TmuxRuntimeRef, title: string): Promise<TerminalActionResult> {
    const ok = await new Promise<boolean>((resolve) => {
      execFile('tmux', ['select-pane', '-t', runtime.paneId, '-T', title.slice(0, 200)], { timeout: 2_000 }, (error) => {
        resolve(!error)
      })
    })
    return legacyActionResult(ok, 'tmux title update')
  }

  async notify(runtime: TmuxRuntimeRef, title: string, body: string): Promise<TerminalActionResult> {
    const message = `${title.slice(0, 200)}: ${body.slice(0, 1_000)}`
    const ok = await new Promise<boolean>((resolve) => {
      execFile('tmux', ['display-message', '-t', runtime.paneId, '--', message], { timeout: 2_000 }, (error) => {
        resolve(!error)
      })
    })
    return legacyActionResult(ok, 'tmux notification')
  }

  /**
   * Stream a pane's bytes. Deliberately NOT gated on identifying the engine process in it.
   *
   * Streaming and injection need different thresholds, and they used to share one. This path
   * addresses the PANE — `capture-pane -t %N` out, `send-keys -t %N` in — and a tmux pane id is
   * monotonic and never reused within a server, so the id alone is a safe address. Injection is the
   * one that types into whatever process owns the pane, and it keeps validating: see
   * `TerminalBackendCoordinator.validateLease` and the lease dispatch fallbacks. The reaper
   * (`coordinator.validate`) keeps validating too.
   *
   * Requiring a match here made the pane unviewable in exactly the situations where seeing it is the
   * whole point: an engine that crashed, one stopped at a first-run prompt under a process the
   * matcher does not cover, or a pane that has fallen back to a bare shell. The agent was listed, and
   * clicking it produced "TERMINAL FROZEN · no <engine> process under tmux pane" instead of the
   * screen that would have explained why. A pane that is genuinely gone still fails, one line later:
   * `TmuxControlStream.open` reads `paneMeta` first and refuses a missing pane and a multi-pane
   * window. Dropping the check also takes a whole-process-table `ps` scan off every terminal open.
   *
   * `expected` stays in the signature because `TerminalBackend` defines it and Herdr may still want
   * it; it is intentionally unused here.
   */
  async openStream(
    runtime: TmuxRuntimeRef,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
  ): Promise<TerminalReadResult<TerminalStreamHandle<TmuxRuntimeRef>>> {
    void expected
    return TmuxControlStream.open(runtime.paneId, size, sink)
  }
}
