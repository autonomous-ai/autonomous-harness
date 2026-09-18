// End-to-end check of the `terminal` engine against a RUNNING daemon, over its loopback WS — the same
// transport the desktop app uses — for this machine or one it relays to (a docker box, say).
//
//   npx tsx scripts/terminal-engine-e2e.mts <machineId> [label] [cycle|exit|restart]
//
//   cycle    (default) create a terminal → shell answers → type `claude` → the row's engine flips
//            to claude (agent_synced) → /exit → back to `terminal`, row kept → adopt again → stop
//            (agent_delete) → gone. What the desktop's ⌘⇧T tile goes through, without the desktop.
//   exit     create → type `exit` → the pane goes and the row with it (agent_deleted).
//   restart  create → adopt claude → `harness stop; harness start` (LOCAL machine only). Then look:
//            the row must still be claude on the same pane, not a second pane.
//   agent    an ORDINARY agent (agent_create engine=claude) → /exit it → the row becomes `terminal`
//            and stays (the pane is a shell now) → type `claude` → adopted again → stop.
//
// Machine ids: `harness machines --json`. Needs `claude` on the target machine's PATH (the docker
// boxes route it through claude-code-router). Leaves nothing behind on a pass.
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { encodeTerminalLocal, decodeTerminalLocal, TerminalBinaryKind } from '../src/lib/terminalBinary.ts'

const machineId = process.argv[2]
const label = process.argv[3] ?? machineId.slice(0, 8)
const mode = process.argv[4] ?? 'cycle'
if (!machineId) throw new Error('machineId required')
const log = (m: string) => console.log(`[${label}] ${new Date().toISOString().slice(11, 19)} ${m}`)
const fail = (m: string): never => { console.error(`[${label}] FAIL ${m}`); process.exit(1) }

const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')
const frames: Array<Record<string, any>> = []
let output = ''
const waiters: Array<{ test: (f: Record<string, any>) => boolean; resolve: (f: Record<string, any>) => void }> = []
ws.on('close', (code, reason) => log(`ws closed ${code} ${reason.toString()}`))
ws.on('message', (raw, isBinary) => {
  if (isBinary) {
    const f = decodeTerminalLocal(new Uint8Array(raw as Buffer))
    if (f && (f.kind === TerminalBinaryKind.output || f.kind === TerminalBinaryKind.keyframe)) {
      output += (f.compressed ? inflateSync(Buffer.from(f.bytes)) : Buffer.from(f.bytes)).toString('utf8')
    }
    return
  }
  const f = JSON.parse(raw.toString()) as Record<string, any>
  frames.push(f)
  if (f.type === 'terminal_error') log(`terminal_error ${JSON.stringify(f.payload)}`)
  for (const w of [...waiters]) if (w.test(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f) }
})
const send = (type: string, payload: Record<string, unknown>) => ws.send(JSON.stringify({ type, payload }))
const waitFor = (test: (f: Record<string, any>) => boolean, ms = 20_000, what = 'frame'): Promise<Record<string, any>> =>
  new Promise((resolve, reject) => {
    const hit = frames.find(test)
    if (hit) return resolve(hit)
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms)
    waiters.push({ test, resolve: (f) => { clearTimeout(t); resolve(f) } })
  })
const rpc = async (type: string, payload: Record<string, unknown>, ms = 20_000) => {
  const requestId = randomUUID()
  send(type, { requestId, ...payload })
  const r = await waitFor((f) => f.type === `${type}_result` && f.payload?.requestId === requestId, ms, `${type}_result`)
  return r.payload as Record<string, any>
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const engineOf = async (agentId: string): Promise<string | null> => {
  const list = await rpc('agents_list', {})
  const a = (list.agents as any[]).find((x) => x.id === agentId)
  return a ? a.engine : null
}
const pollEngine = async (agentId: string, want: string, ms: number): Promise<void> => {
  const until = Date.now() + ms
  let last: string | null = null
  while (Date.now() < until) {
    last = await engineOf(agentId)
    if (last === want) return
    await sleep(1000)
  }
  fail(`engine did not become ${want} within ${ms}ms (last: ${last}); tail: ${JSON.stringify(output.slice(-400))}`)
}

let streamId = ''
let seq = -1
const type = (text: string) => {
  const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId, seq: ++seq, bytes: Buffer.from(text, 'utf8'), compressed: false })
  if (!frame) fail('could not encode input')
  ws.send(frame, { binary: true })
}

await new Promise<void>((resolve) => ws.on('open', () => resolve()))
send('machine_select', { machineId, localProtocolVersion: 1 })
await waitFor((f) => f.type === 'connected', 15_000, 'connected')
log('connected')

if (mode === 'agent') {
  // An agent the app launched: `claude` exec'd by the daemon, not typed by a person.
  const created = await rpc('agent_create', { engine: 'claude', cwd: process.env.E2E_CWD ?? '/tmp', bypassPermission: false }, 30_000)
  if (created.error) fail(`agent_create → ${created.error} ${created.detail ?? ''}`)
  const agentId: string = created.agent.id
  log(`created claude agent ${agentId.slice(0, 8)} · launch=${created.agent.launch?.state}`)
  await pollEngine(agentId, 'claude', 45_000)
  const openId = randomUUID()
  send('terminal_open', { requestId: openId, agentId, cols: 120, rows: 40, protocolVersion: 3 })
  const ready = await waitFor((f) => (f.type === 'terminal_ready' || f.type === 'terminal_error') && f.payload?.requestId === openId, 15_000, 'terminal_ready')
  if (ready.type === 'terminal_error') fail(`terminal_open → ${JSON.stringify(ready.payload)}`)
  streamId = ready.payload.streamId
  // Wait until the launch is confirmed ready (engine process seen), then leave claude.
  const until = Date.now() + 45_000
  while (Date.now() < until) {
    const list = await rpc('agents_list', {})
    const a = (list.agents as any[]).find((x) => x.id === agentId)
    if (a?.launch?.state === 'ready') break
    await sleep(1000)
  }
  await sleep(4000)
  type('\r'); await sleep(2500); type('/exit\r'); await sleep(1500); type('\x03\x03')
  await pollEngine(agentId, 'terminal', 40_000)
  log('claude exited → engine=terminal, row kept')
  await sleep(2000)
  type('echo HARNESS_E2E_SHELL\r')
  await sleep(1500)
  if (!output.includes('HARNESS_E2E_SHELL')) fail(`no shell after the engine left; tail: ${JSON.stringify(output.slice(-300))}`)
  log('shell answers in the same pane')
  type('claude\r')
  await pollEngine(agentId, 'claude', 45_000)
  log('typed claude → adopted again')
  await sleep(3000)
  type('\r'); await sleep(2000); type('/exit\r'); await sleep(1500); type('\x03\x03')
  await pollEngine(agentId, 'terminal', 40_000)
  const deleted = await rpc('agent_delete', { agentId })
  if (!deleted.deleted) fail(`agent_delete → ${JSON.stringify(deleted)}`)
  await waitFor((f) => f.type === 'agent_deleted' && f.payload?.agentId === agentId, 15_000, 'agent_deleted')
  await sleep(1500)
  if (await engineOf(agentId) !== null) fail('agent still listed after delete')
  log('deleted · gone')
  console.log(`[${label}] PASS (agent)`)
  process.exit(0)
}

// 1. create
const created = await rpc('agent_create', { engine: 'terminal' }, 30_000)
if (created.error) fail(`agent_create → ${created.error} ${created.detail ?? ''}`)
const agent = created.agent
const agentId: string = agent.id
if (agent.engine !== 'terminal') fail(`created engine ${agent.engine}`)
if (agent.launch?.state !== 'ready') fail(`launch ${JSON.stringify(agent.launch)}`)
log(`created terminal ${agentId.slice(0, 8)} · name=${agent.name} · cwd=${agent.project?.cwd ?? '?'} · launch=${agent.launch?.state}`)
if (await engineOf(agentId) !== 'terminal') fail('agents_list does not list the terminal')

// 2. open the stream
const openId = randomUUID()
send('terminal_open', { requestId: openId, agentId, cols: 120, rows: 40, protocolVersion: 3 })
const ready = await waitFor((f) => (f.type === 'terminal_ready' || f.type === 'terminal_error') && f.payload?.requestId === openId, 15_000, 'terminal_ready')
if (ready.type === 'terminal_error') fail(`terminal_open → ${JSON.stringify(ready.payload)}`)
streamId = ready.payload.streamId
if (ready.payload.engineId !== 'terminal') fail(`terminal_ready engineId ${ready.payload.engineId}`)
log(`terminal_ready · engineId=${ready.payload.engineId}`)
await sleep(2500)
type('echo HARNESS_E2E_$((40+2))\r')
await sleep(1500)
if (!output.includes('HARNESS_E2E_42')) fail(`shell did not echo; tail: ${JSON.stringify(output.slice(-300))}`)
log('shell answers')

if (mode === 'exit') {
  // Typing `exit` closes the terminal: the pane goes, and with it the row.
  type('exit\r')
  const until = Date.now() + 25_000
  while (Date.now() < until && await engineOf(agentId) !== null) await sleep(1000)
  if (await engineOf(agentId) !== null) fail('row still listed 25s after the shell exited')
  await waitFor((f) => f.type === 'agent_deleted' && f.payload?.agentId === agentId, 5_000, 'agent_deleted')
  log('shell exit → agent_deleted, row gone')
  console.log(`[${label}] PASS (exit)`)
  process.exit(0)
}
if (mode === 'restart') {
  // Adopt claude, then restart the daemon (local only): the row must come back as claude if the
  // process survived, and the pane must not be duplicated; then exit claude → terminal again.
  type('claude\r')
  await pollEngine(agentId, 'claude', 45_000)
  log('engine → claude; restarting the daemon')
  const { execSync } = await import('node:child_process')
  execSync(`${process.env.HOME}/.local/bin/harness stop >/dev/null 2>&1; ${process.env.HOME}/.local/bin/harness start >/dev/null 2>&1`, { stdio: 'ignore' })
  process.exit(0)
}

// 3. claude inside → engine flips
type('claude\r')
await pollEngine(agentId, 'claude', 45_000)
log('engine → claude')
const synced = frames.filter((f) => f.type === 'agent_synced' && f.payload?.agent?.id === agentId).map((f) => f.payload.agent.engine)
log(`agent_synced engines so far: ${synced.join(',')}`)
// A possible trust prompt: Enter accepts; then /exit leaves.
await sleep(4000)
type('\r')
await sleep(2500)
type('/exit\r')
await sleep(1500)
type('\x03\x03')

// 4. back to terminal, still listed
await pollEngine(agentId, 'terminal', 40_000)
log('engine → terminal (row kept)')
await sleep(1500)
type('echo HARNESS_E2E_AGAIN\r')
await sleep(1500)
if (!output.includes('HARNESS_E2E_AGAIN')) fail('shell prompt did not come back')
log('shell answers again')

// 5. adopt again
type('claude\r')
await pollEngine(agentId, 'claude', 45_000)
log('engine → claude (second adoption)')
await sleep(3000)
type('\r'); await sleep(2000); type('/exit\r'); await sleep(1500); type('\x03\x03')
await pollEngine(agentId, 'terminal', 40_000)
log('engine → terminal again')

// 6. stop
const deleted = await rpc('agent_delete', { agentId })
if (!deleted.deleted) fail(`agent_delete → ${JSON.stringify(deleted)}`)
await waitFor((f) => f.type === 'agent_deleted' && f.payload?.agentId === agentId, 15_000, 'agent_deleted')
await sleep(1500)
if (await engineOf(agentId) !== null) fail('agent still listed after delete')
log('deleted · gone from agents_list')
console.log(`[${label}] PASS`)
ws.close()
process.exit(0)
