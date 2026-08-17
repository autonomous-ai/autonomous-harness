import type { TerminalBackend } from './terminalBackend.js'
import { HerdrApiClient, type HerdrApiResult, type HerdrEndpoint } from './herdrApiClient.js'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionNotStarted,
  terminalActionPossiblyExecuted,
  terminalActionRejected,
  type HerdrRuntimeRef,
  type RuntimeValidation,
  type TerminalActionResult,
  type TerminalCaptureOptions,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalInventoryResult,
  type TerminalLogicalKey,
  type TerminalProcessExpectation,
  type TerminalReadResult,
} from './terminalTypes.js'
import { engineProcessMatchScore, processRows } from './tmux.js'
import { terminalRouteKey } from './terminalRuntime.js'

interface HerdrPaneInfo {
  pane_id: string
  terminal_id: string
  workspace_id?: string
  cwd?: string
  label?: string
  title?: string
  terminal_title_stripped?: string
}

interface HerdrSessionSnapshotResult {
  type: 'session_snapshot'
  snapshot: {
    version: string
    protocol: number
    panes: HerdrPaneInfo[]
  }
}

interface HerdrPaneProcessInfoResult {
  type: 'pane_process_info'
  process_info: {
    pane_id: string
    shell_pid?: number
  }
}

interface HerdrPaneReadResult {
  type: 'pane_read'
  read: { text: string }
}

interface HerdrPaneInfoResult {
  type: 'pane_info'
  pane: HerdrPaneInfo
}

interface HerdrWorkspaceCreatedResult {
  type: 'workspace_created'
  root_pane: HerdrPaneInfo
}

const HERDR_KEYS: Record<TerminalLogicalKey, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backtab: 'BackTab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  backspace: 'Backspace',
  delete: 'Delete',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  'ctrl-c': 'Ctrl+C',
  'ctrl-d': 'Ctrl+D',
  'ctrl-u': 'Ctrl+U',
  'ctrl-w': 'Ctrl+W',
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

function actionResult(result: HerdrApiResult<unknown>): TerminalActionResult {
  if (result.ok) return TERMINAL_ACTION_SUCCEEDED
  if (result.dispatch === 'not_started') return terminalActionNotStarted(result.reason)
  if (result.dispatch === 'rejected') return terminalActionRejected(result.reason)
  return terminalActionPossiblyExecuted(result.reason)
}

function runtimeFor(endpoint: HerdrEndpoint, pane: HerdrPaneInfo): HerdrRuntimeRef {
  return {
    backend: 'herdr',
    endpointId: endpoint.endpointId,
    sessionName: endpoint.sessionName,
    terminalId: pane.terminal_id,
    paneId: pane.pane_id,
  }
}

function paneTitle(pane: HerdrPaneInfo): string | null {
  for (const candidate of [pane.label, pane.terminal_title_stripped, pane.title]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return null
}

export class HerdrBackend implements TerminalBackend<HerdrRuntimeRef> {
  readonly name = 'herdr' as const
  readonly instanceId: string
  readonly client: HerdrApiClient

  constructor(
    readonly endpoint: HerdrEndpoint,
    client = new HerdrApiClient(endpoint),
  ) {
    this.instanceId = `herdr:${endpoint.endpointId}`
    this.client = client
  }

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResult<HerdrRuntimeRef>> {
    const result = await this.client.request<HerdrWorkspaceCreatedResult>('workspace.create', {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      focus: false,
      ...(request.label ? { label: request.label } : {}),
      env: {},
    }, { mutation: 'other' })
    if (!result.ok) {
      if (result.dispatch === 'not_started') return terminalActionNotStarted(result.reason)
      if (result.dispatch === 'rejected') return terminalActionRejected(result.reason)
      return terminalActionPossiblyExecuted(result.reason)
    }
    if (result.result.type !== 'workspace_created'
      || typeof result.result.root_pane?.pane_id !== 'string'
      || typeof result.result.root_pane?.terminal_id !== 'string') {
      return terminalActionPossiblyExecuted('Herdr created a workspace without returning its root pane')
    }
    return {
      state: 'succeeded',
      dispatch: 'executed',
      runtime: runtimeFor(this.endpoint, result.result.root_pane),
    }
  }

  async kill(runtime: HerdrRuntimeRef): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    const info = await this.client.request<HerdrPaneInfoResult>('pane.get', { pane_id: runtime.paneId })
    if (!info.ok
      || info.result.type !== 'pane_info'
      || info.result.pane?.terminal_id !== runtime.terminalId
      || typeof info.result.pane.workspace_id !== 'string') {
      return terminalActionNotStarted('Herdr workspace could not be resolved from terminal runtime')
    }
    return actionResult(await this.client.request('workspace.close', {
      workspace_id: info.result.pane.workspace_id,
    }, { mutation: 'other' }))
  }

  async titles(): Promise<TerminalReadResult<Map<string, string>>> {
    const snapshot = await this.client.request<HerdrSessionSnapshotResult>('session.snapshot', {})
    if (!snapshot.ok) return { state: 'failed', reason: snapshot.reason }
    if (snapshot.result.type !== 'session_snapshot' || !Array.isArray(snapshot.result.snapshot?.panes)) {
      return { state: 'failed', reason: 'Herdr session snapshot has an incompatible shape' }
    }
    const titles = new Map<string, string>()
    for (const pane of snapshot.result.snapshot.panes) {
      if (!pane || typeof pane.pane_id !== 'string' || typeof pane.terminal_id !== 'string') continue
      const title = paneTitle(pane)
      if (title) titles.set(terminalRouteKey(runtimeFor(this.endpoint, pane)), title)
    }
    return { state: 'succeeded', value: titles }
  }

  private owns(runtime: HerdrRuntimeRef): boolean {
    return runtime.endpointId === this.endpoint.endpointId && runtime.sessionName === this.endpoint.sessionName
  }

  async inventory(): Promise<TerminalInventoryResult> {
    const ping = await this.client.ping()
    if (!ping.ok) {
      return ping.code === 'protocol_mismatch'
        ? { state: 'incompatible', reason: ping.reason }
        : { state: 'unavailable', reason: ping.reason }
    }
    const snapshot = await this.client.request<HerdrSessionSnapshotResult>('session.snapshot', {})
    if (!snapshot.ok) return { state: 'unavailable', reason: snapshot.reason }
    if (snapshot.result.type !== 'session_snapshot' || !Array.isArray(snapshot.result.snapshot?.panes)) {
      return { state: 'incompatible', reason: 'Herdr session snapshot has an incompatible shape' }
    }
    const roots = await Promise.all(snapshot.result.snapshot.panes.map(async (pane) => {
      if (!pane || typeof pane.pane_id !== 'string' || typeof pane.terminal_id !== 'string') return null
      const info = await this.client.request<HerdrPaneProcessInfoResult>('pane.process_info', { pane_id: pane.pane_id })
      if (!info.ok
        || info.result.type !== 'pane_process_info'
        || !Number.isSafeInteger(info.result.process_info?.shell_pid)
        || info.result.process_info.shell_pid! <= 0) return null
      return {
        runtime: runtimeFor(this.endpoint, pane),
        rootPid: info.result.process_info.shell_pid!,
        cwd: typeof pane.cwd === 'string' ? pane.cwd : '',
      }
    }))
    if (roots.some((root) => root === null)) {
      return { state: 'unavailable', reason: 'Herdr pane process inventory failed' }
    }
    return { state: 'available', roots: roots.filter((root) => root !== null) }
  }

  async resolveRuntimeHint(paneId: string): Promise<TerminalReadResult<HerdrRuntimeRef>> {
    const info = await this.client.request<HerdrPaneInfoResult>('pane.get', { pane_id: paneId })
    if (!info.ok || info.result.type !== 'pane_info' || typeof info.result.pane?.terminal_id !== 'string') {
      return { state: 'failed', reason: info.ok ? 'Herdr pane response is incompatible' : info.reason }
    }
    return { state: 'succeeded', value: runtimeFor(this.endpoint, info.result.pane) }
  }

  async validate(runtime: HerdrRuntimeRef, _expected: TerminalProcessExpectation): Promise<RuntimeValidation> {
    if (!this.owns(runtime)) return { state: 'gone', reason: 'Herdr runtime belongs to another configured endpoint' }
    const resolved = await this.resolveRuntimeHint(runtime.paneId)
    if (resolved.state === 'failed') return { state: 'unknown', reason: resolved.reason }
    if (resolved.value.terminalId !== runtime.terminalId) {
      return { state: 'gone', reason: 'Herdr terminal identity changed under pane route' }
    }
    if (!_expected.processIdentity) return { state: 'alive' }
    const [info, rows] = await Promise.all([
      this.client.request<HerdrPaneProcessInfoResult>('pane.process_info', { pane_id: runtime.paneId }),
      processRows(),
    ])
    if (!info.ok || !rows || info.result.type !== 'pane_process_info'
      || !Number.isSafeInteger(info.result.process_info?.shell_pid)) {
      return { state: 'unknown', reason: 'Herdr process identity could not be verified' }
    }
    const expected = rows.find((row) => row.pid === _expected.processIdentity!.pid)
    if (!expected || expected.startMarker !== _expected.processIdentity.startMarker) {
      return { state: 'gone', reason: 'Herdr engine process identity changed' }
    }
    if (engineProcessMatchScore(expected, _expected.engine) <= 0) {
      return { state: 'gone', reason: 'Herdr process no longer matches the registered engine' }
    }
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    const rootPid = info.result.process_info.shell_pid!
    let pid = expected.pid
    const visited = new Set<number>()
    while (pid > 0 && !visited.has(pid)) {
      if (pid === rootPid) return { state: 'alive' }
      visited.add(pid)
      pid = byPid.get(pid)?.parentPid ?? 0
    }
    return { state: 'gone', reason: 'Herdr engine process is no longer under the terminal root' }
  }

  async capture(runtime: HerdrRuntimeRef, options: TerminalCaptureOptions = {}): Promise<TerminalReadResult<string>> {
    if (!this.owns(runtime)) return { state: 'failed', reason: 'Herdr runtime belongs to another configured endpoint' }
    const result = await this.client.request<HerdrPaneReadResult>('pane.read', {
      pane_id: runtime.paneId,
      source: options.mode ?? 'recent_unwrapped',
      lines: Math.max(20, Math.min(300, Math.floor(options.historyLines ?? 100))),
      format: options.ansi === false ? 'text' : 'ansi',
      strip_ansi: options.ansi === false,
    })
    if (!result.ok) return { state: 'failed', reason: result.reason }
    if (result.result.type !== 'pane_read' || typeof result.result.read?.text !== 'string') {
      return { state: 'failed', reason: 'Herdr pane capture has an incompatible shape' }
    }
    return { state: 'succeeded', value: result.result.read.text }
  }

  async typeLiteral(runtime: HerdrRuntimeRef, text: string): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('pane.send_text', {
      pane_id: runtime.paneId,
      text,
    }, { mutation: 'single_enqueue' }))
  }

  async submitText(runtime: HerdrRuntimeRef, text: string): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('pane.send_input', {
      pane_id: runtime.paneId,
      text: text.replace(/[\r\n]+$/, ''),
      keys: ['Enter'],
    }, { mutation: 'single_enqueue' }))
  }

  async sendKey(runtime: HerdrRuntimeRef, key: TerminalLogicalKey): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('pane.send_keys', {
      pane_id: runtime.paneId,
      keys: [HERDR_KEYS[key]],
    }, { mutation: 'single_key' }))
  }

  async setTitle(runtime: HerdrRuntimeRef, title: string): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('pane.rename', {
      pane_id: runtime.paneId,
      label: title.slice(0, 200),
    }, { mutation: 'other' }))
  }

  async notify(runtime: HerdrRuntimeRef, title: string, body: string): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('notification.show', {
      title: title.slice(0, 200),
      body: body.slice(0, 1_000),
      sound: 'none',
    }, { mutation: 'other' }))
  }
}
