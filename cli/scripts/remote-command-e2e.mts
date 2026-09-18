// End-to-end check of `harness remote` against a RUNNING daemon, over its loopback WS, standing in for
// the desktop: open a terminal tile on THIS machine, type `harness remote` into it, take the named
// machine in the picker, and watch what the window would see — the `remote_terminal_handoff` push
// naming this tile and the new agent, and `agent_created` on the other machine.
//
//   npx tsx scripts/remote-command-e2e.mts <remoteMachineId> [remoteLabel]
//   TILE_MACHINE_ID=<id> …   the tile lives on THAT machine instead of this one (a hop between two
//                            relayed boxes: the push must reach a window that is not on the tile's
//                            machine, which is what `send()` rather than `sendLocal()` is for)
//
// Leaves nothing behind on a pass: both terminals are deleted at the end. Needs the remote machine
// linked here (`harness link list`) — the interactive link is not driven by this script.
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { encodeTerminalLocal, decodeTerminalLocal, TerminalBinaryKind } from '../src/lib/terminalBinary.ts'
import { readAuthSession } from '../src/lib/authSession.ts'

const remoteMachineId = process.argv[2]
const remoteLabel = process.argv[3] ?? remoteMachineId?.slice(0, 8)
if (!remoteMachineId) throw new Error('remoteMachineId required')
const localMachineId = process.env.TILE_MACHINE_ID ?? readAuthSession()?.machineId
if (!localMachineId) throw new Error('not signed in')
const log = (m: string) => console.log(`[e2e] ${new Date().toISOString().slice(11, 19)} ${m}`)
const fail = (m: string): never => { console.error(`[e2e] FAIL ${m}`); process.exit(1) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Client {
  ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')
  frames: Array<Record<string, any>> = []
  output = ''
  private waiters: Array<{ test: (f: Record<string, any>) => boolean; resolve: (f: Record<string, any>) => void }> = []
  constructor(readonly name: string) {
    this.ws.on('close', (code, reason) => log(`${name}: ws closed ${code} ${reason.toString()}`))
    this.ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const f = decodeTerminalLocal(new Uint8Array(raw as Buffer))
        if (f && (f.kind === TerminalBinaryKind.output || f.kind === TerminalBinaryKind.keyframe)) {
          this.output += (f.compressed ? inflateSync(Buffer.from(f.bytes)) : Buffer.from(f.bytes)).toString('utf8')
        }
        return
      }
      const f = JSON.parse(raw.toString()) as Record<string, any>
      this.frames.push(f)
      for (const w of [...this.waiters]) if (w.test(f)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(f) }
    })
  }
  send(type: string, payload: Record<string, unknown>): void { this.ws.send(JSON.stringify({ type, payload })) }
  waitFor(test: (f: Record<string, any>) => boolean, ms = 20_000, what = 'frame'): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const hit = this.frames.find(test)
      if (hit) return resolve(hit)
      const t = setTimeout(() => reject(new Error(`${this.name}: timeout waiting for ${what}`)), ms)
      this.waiters.push({ test, resolve: (f) => { clearTimeout(t); resolve(f) } })
    })
  }
  async rpc(type: string, payload: Record<string, unknown>, ms = 20_000): Promise<Record<string, any>> {
    const requestId = randomUUID()
    this.send(type, { requestId, ...payload })
    const r = await this.waitFor((f) => f.type === `${type}_result` && f.payload?.requestId === requestId, ms, `${type}_result`)
    return r.payload as Record<string, any>
  }
  async select(machineId: string): Promise<void> {
    await new Promise<void>((resolve) => this.ws.on('open', () => resolve()))
    this.send('machine_select', { machineId, localProtocolVersion: 1 })
    await this.waitFor((f) => f.type === 'connected', 20_000, 'connected')
    log(`${this.name}: connected to ${machineId.slice(0, 8)}`)
  }
}

// The window: on this machine, holding the tile `harness remote` is typed in.
const local = new Client('window')
await local.select(localMachineId)
// A second eye on the other machine, for its agent_created.
const remote = new Client('remote')
await remote.select(remoteMachineId)

const created = await local.rpc('agent_create', { engine: 'terminal', bypassPermission: false }, 30_000)
if (created.error) fail(`agent_create → ${created.error} ${created.detail ?? ''}`)
const tileAgentId: string = created.agent.id
log(`tile: terminal agent ${tileAgentId.slice(0, 8)} on ${localMachineId.slice(0, 8)}`)

const openId = randomUUID()
local.send('terminal_open', { requestId: openId, agentId: tileAgentId, cols: 120, rows: 40, protocolVersion: 3 })
const ready = await local.waitFor((f) => (f.type === 'terminal_ready' || f.type === 'terminal_error') && f.payload?.requestId === openId, 15_000, 'terminal_ready')
if (ready.type === 'terminal_error') fail(`terminal_open → ${JSON.stringify(ready.payload)}`)
const streamId: string = ready.payload.streamId
let seq = -1
const type = (text: string) => {
  const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId, seq: ++seq, bytes: Buffer.from(text, 'utf8'), compressed: false })
  if (!frame) fail('could not encode input')
  local.ws.send(frame, { binary: true })
}
await sleep(2500) // the shell's prompt

type('harness remote\r')
const until = Date.now() + 20_000
while (Date.now() < until && !local.output.includes('Open a terminal on:')) await sleep(250)
if (!local.output.includes('Open a terminal on:')) fail(`picker did not draw; tail: ${JSON.stringify(local.output.slice(-600))}`)
log('picker drew:\n' + local.output.split('Open a terminal on:')[1].split('\n').slice(0, 10).map((l) => '    ' + l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).join('\n'))
log(`first-terminal hint shown: ${local.output.includes('harness remote') && local.output.includes('pick the machine')}`)
if (!local.output.includes('Online') || !local.output.includes('Offline')) log('note: expected both Online and Offline rows in this account')

// Walk to the wanted row: ↓ until the ❯ line names it, then Enter.
const cursorLine = (): string => {
  const lines = local.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')
  return lines.filter((l) => l.includes('❯')).at(-1) ?? ''
}
for (let i = 0; i < 12 && !cursorLine().includes(remoteLabel); i++) { type('\x1b[B'); await sleep(200) }
if (!cursorLine().includes(remoteLabel)) fail(`could not reach ${remoteLabel} in the picker; cursor: ${cursorLine()}`)
log(`cursor on: ${cursorLine().trim()}`)
type('\r')

const handoff = await local.waitFor((f) => f.type === 'remote_terminal_handoff', 60_000, 'remote_terminal_handoff push')
log(`window got remote_terminal_handoff ${JSON.stringify(handoff.payload)}`)
if (handoff.payload.fromAgentId !== tileAgentId) fail(`fromAgentId ${handoff.payload.fromAgentId} is not the tile's ${tileAgentId}`)
if (handoff.payload.machineId !== remoteMachineId) fail(`machineId ${handoff.payload.machineId} is not ${remoteMachineId}`)
const remoteAgentId: string = handoff.payload.agentId
// The other machine lists it (the push may or may not reach a second relay session; the window
// re-asks the list either way, see AppNotifier._awaitAgent).
let row: Record<string, any> | undefined
for (let i = 0; i < 20 && !row; i++) {
  const list = await remote.rpc('agents_list', {})
  row = (list.agents as any[] | undefined)?.find((a) => a.id === remoteAgentId)
  if (!row) await sleep(1000)
}
if (!row) fail('the remote machine does not list the new agent')
const pushed = remote.frames.some((f) => f.type === 'agent_created' && f.payload?.agent?.id === remoteAgentId)
log(`remote lists agent ${remoteAgentId.slice(0, 8)} engine=${row.engine} (agent_created push seen by the second session: ${pushed})`)
if (row.engine !== 'terminal') fail('the remote agent is not a terminal')
await sleep(1500)
const said = local.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
if (!said.includes('Switching this tile to')) fail(`the command did not say it switched; tail: ${JSON.stringify(said.slice(-400))}`)
log('the command said: ' + said.split('\n').filter((l) => l.includes('✓')).join(' | ').trim())

// What the window then does: end the old shell (the tile is the remote's now). Both go here.
const del = await local.rpc('agent_delete', { agentId: tileAgentId })
if (del.error) fail(`agent_delete (tile) → ${del.error}`)
const delRemote = await remote.rpc('agent_delete', { agentId: remoteAgentId })
if (delRemote.error) fail(`agent_delete (remote) → ${delRemote.error}`)
log('PASS — both terminals deleted')
process.exit(0)
