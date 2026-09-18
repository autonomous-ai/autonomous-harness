/**
 * `harness remote` — from inside one of the app's terminal tiles, open a terminal on ANOTHER of your
 * machines and have the window swap this tile over to it.
 *
 * Typed in a tile, it lists the account's other machines, takes one with ↑/↓ and Enter, creates a
 * `terminal` agent there through the daemon's loopback socket (the daemon relays to the other machine
 * the way it does for the desktop), then asks the daemon to tell the window: `remote_terminal_handoff`
 * names this tile by its tmux pane — `$TMUX_PANE`, the one fact a shell has about itself — and the
 * window swaps the tile to the new agent and ends this shell.
 *
 * Only a Harness tile qualifies. Another terminal app, or a tmux of the user's own, has no tile for
 * the window to swap, so the command says so and does nothing. A machine not linked to this computer
 * yet is linked on the spot — the remote password is asked for, as `harness link connect` asks — and
 * an offline machine is listed but cannot be taken: there is nothing there to open a shell on.
 */
import { randomUUID } from 'node:crypto'
import { emitKeypressEvents } from 'node:readline'
import { WebSocket } from 'ws'
import { TMUX_PANE_RE } from './lib/terminalHandoff.js'

export interface RemoteMachineChoice {
  machineId: string
  /** What the row says: the machine's name, else its hostname. */
  label: string
  /** As the control plane reports it: `running`, `offline`, … */
  status: string
  /** This computer — never offered, since the tile is already here. */
  current: boolean
}

/** The words the control plane uses for a machine that is up — the same set the desktop reads. */
const ONLINE_STATUSES = new Set(['running', 'online', 'connected', 'ready'])
export const isOnline = (choice: RemoteMachineChoice): boolean => ONLINE_STATUSES.has(choice.status.trim().toLowerCase())

/** The picker's order: the machines a terminal can open on first, each group as the account lists it. */
export function orderForPicker(choices: RemoteMachineChoice[]): RemoteMachineChoice[] {
  return [...choices.filter(isOnline), ...choices.filter((choice) => !isOnline(choice))]
}

export interface RemoteCommandDeps {
  /** `process.env.TMUX_PANE` — set by tmux in every pane, `%N`. */
  tmuxPane: string | undefined
  /** This machine's id, from the SSO session; null when not signed in. */
  localMachineId: string | null
  /** The daemon's loopback port, and whether it is up at all. */
  port: number
  daemonRunning: () => boolean
  listMachines: () => Promise<RemoteMachineChoice[]>
  /** Whether this computer holds [machineId]'s peer pin (`harness link list`). */
  isLinked: (machineId: string) => boolean
  /** `harness link connect`, as a call: proves the remote password, pins the peer. */
  link: (machineId: string, password: string) => Promise<{ ok: true; fingerprint: string } | { ok: false; message: string }>
  promptPassword: (prompt: string) => Promise<string>
  input: NodeJS.ReadStream & { isTTY?: boolean }
  output: NodeJS.WriteStream & { isTTY?: boolean }
  error: (line: string) => void
  /** Test seam: what opens a loopback socket. */
  connect?: (url: string) => LoopbackSocket
}

/** The slice of `ws.WebSocket` the loopback client uses — a test stands one in. */
export interface LoopbackSocket {
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (raw: unknown, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer | string) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  send(data: string): void
  close(): void
}

/** How a loopback call ended, in the daemon's words. */
export class LoopbackError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ?? code)
  }
}

/**
 * Pick one of [choices] on a tty, in the order given (the command passes them online first): ↑/↓
 * (or k/j) move, Enter takes, Esc / q / Ctrl-C leave with null. Every row says Online or Offline;
 * Enter on an offline one says why it cannot be taken and stays.
 * Drawn in place — the rows are rewritten on every move, never scrolled.
 */
export function pickMachine(
  choices: RemoteMachineChoice[],
  io: { input: RemoteCommandDeps['input']; output: RemoteCommandDeps['output'] },
): Promise<RemoteMachineChoice | null> {
  const { input, output } = io
  return new Promise((resolve) => {
    let index = Math.max(0, choices.findIndex(isOnline))
    let drawn = 0
    let note = ''
    const width = Math.max(...choices.map((choice) => choice.label.length))
    const draw = (): void => {
      if (drawn) output.write(`\x1b[${drawn}A\x1b[J`)
      const lines = [
        '  Open a terminal on another machine   ↑/↓ choose · Enter open · Esc cancel',
        ...choices.map((choice, at) => {
          const mark = at === index ? '❯' : ' '
          const status = isOnline(choice) ? 'Online' : 'Offline'
          return `  ${mark} ${choice.label.padEnd(width)}  ${status}`
        }),
        ...(note ? [`  ${note}`] : []),
      ]
      output.write(lines.join('\n') + '\n')
      drawn = lines.length
    }
    const finish = (choice: RemoteMachineChoice | null): void => {
      input.off('keypress', onKey)
      if (input.isTTY) input.setRawMode(false)
      input.pause()
      resolve(choice)
    }
    const onKey = (_text: string | undefined, key: { name?: string; ctrl?: boolean } = {}): void => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') { finish(null); return }
      if (key.name === 'return' || key.name === 'enter') {
        const choice = choices[index]
        if (choice && !isOnline(choice)) { note = `${choice.label} is offline. Run \`harness start\` there, or choose an online machine.`; draw(); return }
        finish(choice ?? null); return
      }
      if (key.name === 'up' || key.name === 'k') index = (index - 1 + choices.length) % choices.length
      else if (key.name === 'down' || key.name === 'j') index = (index + 1) % choices.length
      else return
      note = ''
      draw()
    }
    emitKeypressEvents(input)
    if (input.isTTY) input.setRawMode(true)
    input.resume()
    input.on('keypress', onKey)
    draw()
  })
}

/**
 * One connection to the daemon's loopback socket, selected onto one machine — this one, or one the
 * daemon relays to — with the request/reply shape every local client uses (`<type>_result` carrying
 * the request's id).
 */
export class LoopbackClient {
  private readonly frames: Array<{ type: string; payload: Record<string, unknown> }> = []
  private readonly waiters: Array<{ test: (frame: { type: string; payload: Record<string, unknown> }) => boolean; resolve: (frame: { type: string; payload: Record<string, unknown> }) => void }> = []
  private closed: { code: number; reason: string } | null = null
  private readonly socket: LoopbackSocket
  private readonly opened: Promise<void>

  constructor(url: string, connect: (url: string) => LoopbackSocket = (target) => new WebSocket(target) as unknown as LoopbackSocket) {
    this.socket = connect(url)
    this.opened = new Promise((resolve, reject) => {
      this.socket.on('open', () => resolve())
      this.socket.on('error', (error) => reject(new LoopbackError('DAEMON_UNREACHABLE', error.message)))
    })
    this.socket.on('message', (raw, isBinary) => {
      if (isBinary) return
      let frame: { type?: unknown; payload?: unknown }
      try { frame = JSON.parse(String(raw)) as { type?: unknown; payload?: unknown } } catch { return }
      if (typeof frame.type !== 'string') return
      const parsed = { type: frame.type, payload: (frame.payload ?? {}) as Record<string, unknown> }
      this.frames.push(parsed)
      for (const waiter of [...this.waiters]) {
        if (waiter.test(parsed)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(parsed) }
      }
    })
    this.socket.on('close', (code, reason) => { this.closed = { code, reason: String(reason) } })
  }

  private send(type: string, payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ type, payload }))
  }

  private waitFor(test: (frame: { type: string; payload: Record<string, unknown> }) => boolean, ms: number, what: string): Promise<{ type: string; payload: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const hit = this.frames.find(test)
      if (hit) { resolve(hit); return }
      // Every way out clears the other two: a timer or an interval left behind would hold the
      // process open after the command has already said its last line.
      const waiter = { test, resolve: (frame: { type: string; payload: Record<string, unknown> }) => { settle(); resolve(frame) } }
      const timer = setTimeout(() => { settle(); reject(new LoopbackError('TIMEOUT', `no ${what} from the daemon within ${ms / 1000}s`)) }, ms)
      const poll = setInterval(() => {
        if (!this.closed) return
        settle()
        // The daemon's close codes are its answer: 4404 is a machine that has never been linked.
        const code = this.closed.code === 4404 ? 'NO_PEER_LINK' : this.closed.code === 4403 ? 'MACHINE_UNAVAILABLE' : 'DISCONNECTED'
        reject(new LoopbackError(code, this.closed.reason || `the daemon closed the connection (${this.closed.code})`))
      }, 50)
      const settle = (): void => {
        clearTimeout(timer)
        clearInterval(poll)
        const at = this.waiters.indexOf(waiter)
        if (at >= 0) this.waiters.splice(at, 1)
      }
      this.waiters.push(waiter)
    })
  }

  /** Select [machineId]; resolves once the daemon (or the machine it relays to) has answered. */
  async select(machineId: string, ms = 20_000): Promise<void> {
    await this.opened
    this.send('machine_select', { machineId, localProtocolVersion: 1 })
    const answer = await this.waitFor((frame) => frame.type === 'connected' || frame.type === 'machine_select_error', ms, 'machine_select answer')
    if (answer.type === 'machine_select_error') {
      const error = typeof answer.payload.error === 'string' ? answer.payload.error : 'MACHINE_UNAVAILABLE'
      throw new LoopbackError(error, typeof answer.payload.detail === 'string' ? answer.payload.detail : undefined)
    }
  }

  /** A request and its `<type>_result`; an `error` field in the reply is thrown as a LoopbackError. */
  async rpc(type: string, payload: Record<string, unknown>, ms = 30_000): Promise<Record<string, unknown>> {
    const requestId = randomUUID()
    this.send(type, { requestId, ...payload })
    const reply = await this.waitFor((frame) => frame.type === `${type}_result` && frame.payload.requestId === requestId, ms, `${type}_result`)
    if (typeof reply.payload.error === 'string') {
      throw new LoopbackError(reply.payload.error, typeof reply.payload.detail === 'string' ? reply.payload.detail : undefined)
    }
    return reply.payload
  }

  close(): void {
    try { this.socket.close() } catch { /* already gone */ }
  }
}

export function loopbackUrl(port: number): string {
  return `ws://127.0.0.1:${port}/api/local-ws`
}

/** A `terminal` agent on [machineId], created the way the desktop's ⌘⇧T creates one: at home. */
export async function openRemoteTerminal(deps: Pick<RemoteCommandDeps, 'port' | 'connect'>, machineId: string): Promise<string> {
  const client = new LoopbackClient(loopbackUrl(deps.port), deps.connect)
  try {
    await client.select(machineId)
    const created = await client.rpc('agent_create', { engine: 'terminal', bypassPermission: false })
    const agent = created.agent as { id?: unknown } | undefined
    if (!agent || typeof agent.id !== 'string' || !agent.id) throw new LoopbackError('INTERNAL', 'the machine created no agent')
    return agent.id
  } finally {
    client.close()
  }
}

/** Tell the window to swap this tile over; how many windows heard it comes back. */
export async function handoffTerminal(
  deps: Pick<RemoteCommandDeps, 'port' | 'connect'>,
  localMachineId: string,
  handoff: { tmuxPane: string; machineId: string; agentId: string },
): Promise<{ fromAgentId: string; windows: number }> {
  const client = new LoopbackClient(loopbackUrl(deps.port), deps.connect)
  try {
    await client.select(localMachineId)
    const reply = await client.rpc('remote_terminal_handoff', handoff, 10_000)
    return { fromAgentId: String(reply.fromAgentId ?? ''), windows: Number(reply.windows ?? 0) }
  } finally {
    client.close()
  }
}

/** What an error on the way is worth saying, in one line the tile shows. */
export function remoteFailureLine(error: unknown, machine: RemoteMachineChoice): string {
  if (error instanceof LoopbackError) {
    switch (error.code) {
      case 'NO_PEER_LINK': return `${machine.label} is not linked to this computer yet. Run: harness link connect ${machine.machineId}`
      case 'DAEMON_UNREACHABLE': return 'The Harness daemon is not answering. Run `harness start` and try again.'
      case 'MACHINE_UNAVAILABLE': return `${machine.label} cannot be reached right now (${error.message}).`
      case 'NOT_A_HARNESS_PANE': return 'This shell is not one of the app\'s terminal tiles, so there is no tile to switch. Run `harness remote` inside a Harness terminal.'
      case 'TIMEOUT': return `${machine.label} did not answer in time (${error.message}).`
      default: return `${error.code}${error.message && error.message !== error.code ? `: ${error.message}` : ''}`
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/** Link [choice] now, the way `harness link connect` does: its remote password, proved, pins it. */
async function linkNow(deps: RemoteCommandDeps, choice: RemoteMachineChoice): Promise<boolean> {
  const { output, error } = deps
  output.write(`  ${choice.label} is not linked to this computer yet.\n`)
  output.write('  Enter that machine\'s remote password (set there with `harness remote-password set`).\n')
  const password = (await deps.promptPassword(`  Remote password for ${choice.label}: `)).trim()
  if (!password) { error('  ✗ No password entered; nothing was linked.'); return false }
  const linked = await deps.link(choice.machineId, password)
  if (!linked.ok) { error(`  ✗ ${linked.message}`); return false }
  output.write(`  ✓ Linked ${choice.label} (fingerprint ${linked.fingerprint})\n`)
  return true
}

/** Exit code: 0 when the tile was handed over (or the person cancelled), 1 otherwise. */
export async function remoteCommand(deps: RemoteCommandDeps): Promise<number> {
  const { tmuxPane, output, error } = deps
  if (!tmuxPane || !TMUX_PANE_RE.test(tmuxPane)) {
    error('`harness remote` runs inside a Harness terminal tile (⌘⇧T, or New Harness ▸ Terminal).')
    error('Open one and run it there.')
    return 1
  }
  if (!deps.input.isTTY || !output.isTTY) { error('`harness remote` needs a terminal to choose a machine in.'); return 1 }
  if (!deps.localMachineId) { error('Not signed in. Run `harness login`.'); return 1 }
  if (!deps.daemonRunning()) { error('The Harness daemon is not running. Run `harness start`.'); return 1 }
  let machines: RemoteMachineChoice[]
  try { machines = await deps.listMachines() } catch (failure) {
    error(failure instanceof Error ? failure.message : String(failure))
    return 1
  }
  const others = machines.filter((machine) => !machine.current)
  if (!others.length) {
    error('No other machines on this account. Run `harness start` on another computer to connect it.')
    return 1
  }
  if (!others.some(isOnline)) {
    error(`No other machine is online right now (${others.map((machine) => machine.label).join(', ')}). Run \`harness start\` there first.`)
    return 1
  }
  const choice = await pickMachine(orderForPicker(others), deps)
  if (!choice) { output.write('  Cancelled.\n'); return 0 }
  // Linked first, when it is not: the relay refuses a machine this computer has no peer pin for.
  if (!deps.isLinked(choice.machineId) && !(await linkNow(deps, choice))) return 1
  output.write(`  Opening a terminal on ${choice.label}…\n`)
  let agentId: string
  try { agentId = await openRemoteTerminal(deps, choice.machineId) } catch (failure) {
    // The pin this computer holds is not one the daemon accepts (rotated on the other side, say):
    // link again, once, and retry.
    if (failure instanceof LoopbackError && failure.code === 'NO_PEER_LINK' && await linkNow(deps, choice)) {
      try { agentId = await openRemoteTerminal(deps, choice.machineId) } catch (again) {
        error(`  ✗ ${remoteFailureLine(again, choice)}`)
        return 1
      }
    } else {
      error(`  ✗ ${remoteFailureLine(failure, choice)}`)
      return 1
    }
  }
  try {
    const { windows } = await handoffTerminal(deps, deps.localMachineId, { tmuxPane, machineId: choice.machineId, agentId })
    if (windows === 0) {
      output.write(`  ✓ Terminal opened on ${choice.label}. No Harness window is open here to switch this tile — find it in the app's agent list.\n`)
      return 0
    }
    output.write(`  ✓ Terminal opened on ${choice.label}. Switching this tile…\n`)
    return 0
  } catch (failure) {
    error(`  ✗ ${remoteFailureLine(failure, choice)}`)
    error(`    The terminal is open on ${choice.label} all the same (agent ${agentId.slice(0, 8)}) — find it in the app's agent list.`)
    return 1
  }
}
