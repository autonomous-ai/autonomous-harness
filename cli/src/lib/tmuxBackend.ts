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
    const result = await new Promise<{ error: NodeJS.ErrnoException | null; stdout: string }>((resolve) => {
      execFile('tmux', args, { timeout: 5_000 }, (error, stdout) => resolve({
        error: error as NodeJS.ErrnoException | null,
        stdout,
      }))
    })
    if (result.error) {
      return result.error.code === 'ENOENT'
        ? terminalActionNotStarted('tmux is unavailable')
        : terminalActionPossiblyExecuted('tmux session creation did not complete')
    }
    const paneId = result.stdout.trim()
    if (!/^%\d+$/.test(paneId)) {
      return terminalActionPossiblyExecuted('tmux created a session without returning its root pane')
    }
    // Without this, a scroll gesture over a program in the alternate screen buffer (Claude Code's
    // own TUI, most chat CLIs) is forwarded to that program as raw wheel/arrow-key bytes instead of
    // being caught by tmux — the program mostly has no binding for it, so scrolling silently does
    // nothing. `mouse on` makes tmux itself catch the wheel event and enter copy-mode, which DOES
    // keep scrollback for the alternate screen. Session-scoped (target is the pane tmux just
    // returned, no -g) so this never touches tmux mouse behavior outside sessions this app creates.
    await new Promise<void>((resolve) => {
      execFile('tmux', ['set-option', '-t', paneId, 'mouse', 'on'], { timeout: 2_000 }, () => resolve())
    })
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

  async openStream(
    runtime: TmuxRuntimeRef,
    expected: TerminalProcessExpectation,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
  ): Promise<TerminalReadResult<TerminalStreamHandle<TmuxRuntimeRef>>> {
    const validation = await this.validate(runtime, expected)
    if (validation.state !== 'alive') return {
      state: 'failed',
      reason: validation.state === 'gone' ? validation.reason : 'tmux runtime validation failed',
    }
    return TmuxControlStream.open(runtime.paneId, size, sink)
  }
}
