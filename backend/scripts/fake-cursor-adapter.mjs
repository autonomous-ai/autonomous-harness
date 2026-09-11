#!/usr/bin/env node
//
// A stand-in for the macOS Cursor adapter, so the device path can be exercised before that app exists.
//
// It dials /api/adapter-ws as a remote machine, keeps presence alive, publishes one Cursor-badged agent,
// and lets you toggle Cursor's open/closed/missing state from the keyboard. What you should see on the
// dial's Machines wheel:
//
//     ✓  Kyle's Mac    Cursor · open        <-- press c to flip it to "closed"
//
// Usage:
//   node scripts/fake-cursor-adapter.mjs --token <machine apiKey> [--url wss://harness-api.autonomous.ai]
//   node scripts/fake-cursor-adapter.mjs --token $KEY --url ws://localhost:8085
//
// Keys while running:  o = open   c = closed   m = missing   a = re-publish the agent   q = quit
//
// The token is a REMOTE machine's apiKey (POST /api/machines with a remote plan, or the value behind
// `harness join <token>`). The backend rejects any other authMode with 401, so a managed machine's key
// will not work here — that is the gate at adapterWs.ts, not a bug in this script.
//
// E2EE IS implemented (scripts/lib/e2ee-core.mjs, validated against the device's own golden vectors),
// because a remote machine cannot do anything without it: the backend relays agents_list to the machine
// and expects per-connId ciphertext back, and the device's picker row stays "Not linked" until the
// pairing completes. Pairing needs the 6-character code the DEVICE shows on screen — that is the whole
// security property, so it cannot be automated. Write it to PAIR_CODE_FILE and this adapter continues:
//
//     echo K7P4X9 > /tmp/harness-pair-code

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as E from './lib/e2ee-core.mjs'

// There is no root package.json in this monorepo, so `ws` is resolved out of the backend's own
// node_modules. Node's global WebSocket would avoid the dependency but cannot set request headers and
// does not surface the HTTP status of a failed upgrade — and 401 vs 402 vs 409 is exactly what this
// script exists to let you test.
let WebSocket
try {
  WebSocket = createRequire(new URL('../package.json', import.meta.url))('ws').WebSocket
} catch {
  console.error('cannot resolve `ws` — run `npm install` in the backend repo first')
  process.exit(2)
}

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const token = flag('token')
if (!token) {
  console.error('usage: fake-cursor-adapter.mjs --token <machine apiKey> [--url <ws base>] [--label <name>]')
  process.exit(2)
}
const base = flag('url', 'wss://harness-api.autonomous.ai').replace(/\/$/, '')
const label = flag('label', 'Fake Cursor Mac')
// Stable per invocation of this script on this host. The backend enforces one computer per machine and
// answers 409 for a different one, so reusing the same value lets a restart reclaim its own machine.
const computerId = createHash('sha256').update(`fake-cursor-adapter:${process.env.USER ?? 'anon'}`).digest('hex').slice(0, 32)
const machineId = createHash('sha256').update(token).digest('hex').slice(0, 32)

const AGENT = {
  id: 'fake-composer-0001-0002-0003',
  name: 'Spider research',
  engine: 'cursor',
}

let appState = 'open'
let ws
let pingTimer

const send = (obj) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}

/** Both eligibility flags false: the backend routes this to its machine watchers, never to a client. */
const sendAppState = () => {
  send({ t: 'up', webEligible: false, commanderEligible: false,
         frame: { type: 'machine_app_status', payload: { engine: 'cursor', state: appState } } })
  console.log(`→ machine_app_status  cursor:${appState}`)
}

/** agent_synced is what puts a Cursor badge on the tile — the machine-level engine is pinned to claude. */
const sendAgent = () => {
  send({ t: 'up', webEligible: true, commanderEligible: true,
         frame: { type: 'agent_synced', engine: AGENT.engine,
                  payload: { agent: { id: AGENT.id, name: AGENT.name }, engine: AGENT.engine, status: 'active' } } })
  console.log(`→ agent_synced        ${AGENT.name} (${AGENT.engine})`)
}

// ── E2EE (adapter = CPace INITIATOR; the device is the responder and shows the code) ───────────────
const PAIR_CODE_FILE = '/tmp/harness-pair-code'
const b64 = (b) => Buffer.from(b).toString('base64')
const unb64 = (s) => Buffer.from(String(s ?? ''), 'base64')

// Persisted, because the device PINS this identity: a fresh seed each run makes every restart look like
// an adapter that rotated its key, so the device unpins and demands the code again — which turns a
// one-line edit into a re-pair. Keyed by machine so two machines don't share an identity.
const IDENTITY_FILE = `/tmp/harness-adapter-identity-${machineId}.json`
let store = { seed: null, pinned: null }
try { store = { ...store, ...JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')) } } catch { /* first run */ }
const identitySeed = store.seed ? Buffer.from(store.seed, 'base64') : randomBytes(32)
const identityPub = E.edPublicFromSeed(identitySeed)
const persist = () => {
  try {
    writeFileSync(IDENTITY_FILE, JSON.stringify({
      seed: identitySeed.toString('base64'),
      pinned: pinnedDevicePub ? pinnedDevicePub.toString('base64') : null,
    }), { mode: 0o600 })
  } catch { /* dev convenience only */ }
}
const ci = E.pairContext(machineId, 'device')
const groupKey = randomBytes(32)
const epoch = randomBytes(4).toString('hex')

let pinnedDevicePub = store.pinned ? Buffer.from(store.pinned, 'base64') : null
let pair = null                                          // in-flight CPace state
const sessions = new Map()                               // connId → {c2s, s2c, sendCtr}

const sendFrame = (type, payload, connId) =>
  send({ t: 'up', commanderEligible: true, webEligible: false, targetConnId: connId,
         frame: { type, payload } })

function onE2eFrame(type, p, connId) {
  if (type === 'e2e_status') {
    // Must answer within 6s: the device falls back to plaintext after that, and for a REMOTE machine the
    // backend then refuses every RPC — an empty machine with no explanation.
    const paired = !!pinnedDevicePub && pinnedDevicePub.equals(unb64(p.identityPub))
    console.log(`← e2e_status          → supported:true paired:${paired}`)
    return sendFrame('e2e_status_result', { supported: true, paired }, connId)
  }

  if (type === 'e2e_pair_intent') {
    const pairId = unb64(p.pairId)
    pair = { pairIdB64: p.pairId, pairId, connId }
    console.log(`\n← e2e_pair_intent     PAIRING NEEDED`)
    console.log(`  Read the 6-character code off the dial, then:`)
    console.log(`     echo <CODE> > ${PAIR_CODE_FILE}\n`)
    waitForCode()
    return
  }

  if (type === 'e2e_pake' && pair && p.pairId === pair.pairIdB64) return onPake(p, connId)
  if (type === 'e2e_hello') return onHello(p, connId)
}

function waitForCode() {
  // The device rotates its code every 60s with a fresh pairId, so intents repeat. One waiter at a time,
  // or a later code could restart CPace on top of an in-flight exchange.
  if (pair.waiting) return
  pair.waiting = true
  const deadline = Date.now() + 120_000
  const tick = setInterval(() => {
    if (!pair) return clearInterval(tick)
    if (Date.now() > deadline) { clearInterval(tick); console.log('✗ pairing timed out'); pair = null; return }
    if (!existsSync(PAIR_CODE_FILE)) return
    const code = readFileSync(PAIR_CODE_FILE, 'utf8').trim()
    try { unlinkSync(PAIR_CODE_FILE) } catch { /* ignore */ }
    if (!code) return
    clearInterval(tick)
    startCpace(code)
  }, 400)
}

function startCpace(code) {
  console.log(`→ e2e_pake round 1     code="${code}"`)
  const g = E.cpaceGenerator(code, pair.pairId, ci)
  pair.y = E.randScalar()
  pair.Ya = Buffer.from(g.multiply(pair.y).toBytes())
  sendFrame('e2e_pake', { pairId: pair.pairIdB64, round: 1, ya: b64(pair.Ya) }, pair.connId)
}

function onPake(p, connId) {
  if (p.round === 2) {
    pair.Yb = unb64(p.yb)
    let K
    try { K = E.cpaceShared(pair.Yb, pair.y) } catch { console.log('✗ bad Yb'); pair = null; return }
    pair.isk = E.cpaceISK(pair.pairId, K, pair.Ya, pair.Yb)
    pair.th = E.transcriptHash(pair.pairId, ci, pair.Ya, pair.Yb)
    const kc = E.kcKeys(pair.isk, ci)
    // The device proves it derived the same ISK — i.e. that it knew the code. A wrong code dies here.
    if (!E.macTag(kc.responder, pair.th).equals(unb64(p.mac))) {
      console.log('✗ wrong code — device MAC mismatch'); pair = null; return
    }
    const pk = E.pairKey(pair.isk, ci)
    const me = JSON.stringify({ id: b64(identityPub), sig: b64(E.pairBindSig(identitySeed, pair.th)) })
    // Identity exchange rides inside the PAKE: literal "e2e-id" AAD, counters 3 and 4 (not the frame AAD).
    const enc = E.aeadSeal(pk, 3, Buffer.from('e2e-id'), Buffer.from(me))
    console.log('→ e2e_pake round 3     code accepted, sending identity')
    return sendFrame('e2e_pake', { pairId: pair.pairIdB64, round: 3, mac: b64(E.macTag(kc.adapter, pair.th)), enc: b64(enc) }, connId)
  }

  if (p.round === 4) {
    const pk = E.pairKey(pair.isk, ci)
    const pt = E.aeadOpen(pk, 4, Buffer.from('e2e-id'), unb64(p.enc))
    if (!pt) { console.log('✗ cannot open device identity'); pair = null; return }
    const { id, sig } = JSON.parse(pt.toString())
    const devPub = unb64(id)
    if (!E.pairBindVerify(devPub, pair.th, unb64(sig))) { console.log('✗ device bind sig invalid'); pair = null; return }
    pinnedDevicePub = devPub
    persist()
    console.log(`→ e2e_pake round 5     PAIRED  device=${E.fingerprint(devPub)}`)
    console.log(`                       adapter=${E.fingerprint(identityPub)}`)
    sendFrame('e2e_pake', { pairId: pair.pairIdB64, round: 5, ok: true }, connId)
    pair = null
  }
}

function onHello(p, connId) {
  const devIdPub = unb64(p.identityPub)
  const devEphPub = unb64(p.ephPub)
  if (!E.helloVerify(devIdPub, machineId, devEphPub, unb64(p.sig))) { console.log('✗ hello sig invalid'); return }
  const ephSeed = randomBytes(32)
  const ephPub = E.xPublicFromSeed(ephSeed)
  // Both sides pass the SAME ordering: (responder=device eph, initiator=adapter eph).
  const { c2s, s2c } = E.sessionKeys(ephSeed, devEphPub, machineId, devEphPub, ephPub)
  sessions.set(connId, { c2s, s2c, sendCtr: 1 })   // 0 is spent by the welcome below
  const enc = E.aeadSeal(s2c, 0, Buffer.from('e2e-welcome'),
                         Buffer.from(JSON.stringify({ groupKey: b64(groupKey), epoch })))
  console.log(`→ e2e_welcome          session up (epoch ${epoch})`)
  sendFrame('e2e_welcome', {
    ephPub: b64(ephPub),
    webEphPub: b64(devEphPub),                      // echo — proves we answered THIS hello
    sig: b64(E.welcomeSig(identitySeed, machineId, devEphPub, ephPub)),
    enc: b64(enc),
  }, connId)
}

/** A protected RPC from the device: ciphertext in, ciphertext out, per connId. */
function onDataFrame(type, frame, connId) {
  const sess = sessions.get(connId)
  const env = frame.payload?.__e2e
  let payload = frame.payload
  if (env && sess) {
    const pt = E.aeadOpen(env.k === 'g' ? groupKey : sess.c2s, env.n,
                          E.aad(type, frame.dbSessionId, env.k, env.epoch), Buffer.from(env.ct, 'base64'))
    if (!pt) { console.log(`✗ cannot decrypt ${type}`); return }
    payload = JSON.parse(pt.toString())
  }
  console.log(`← ${type}${env ? ' (encrypted)' : ''}`)

  if (type === 'agents_list' && sess) {
    const result = { requestId: payload?.requestId, agents: [{ id: AGENT.id, name: AGENT.name, engine: AGENT.engine }] }
    return sendEncrypted('agents_list_result', result, connId)
  }

  if (type === 'agent_recent' && sess) {
    // The tile's last-activity line. `summary` is the kind the device renders as a recap card (and the
    // kind it beeps on); `recap` is the short headline, `text` the body behind tap-to-read.
    return sendEncrypted('agent_recent_result', {
      requestId: payload?.requestId,
      agentId: payload?.agentId ?? AGENT.id,
      events: [{ kind: 'summary', recap: 'Mapped the spider dataset', text: 'Went through the spider dataset and pulled out the three columns that actually matter.' }],
    }, connId)
  }
}

function sendEncrypted(type, payload, connId) {
  const sess = sessions.get(connId)
  if (!sess) return
  // Pairwise frames carry NO epoch — present-but-empty would change the AAD and fail to open.
  const wrapped = E.wrapPayload(sess.s2c, 'p', sess.sendCtr++, type, undefined, payload)
  console.log(`→ ${type} (encrypted)`)
  sendFrame(type, wrapped, connId)
}

function connect() {
  const url = `${base}/api/adapter-ws?label=${encodeURIComponent(label)}&computer=${computerId}`
  console.log(`connecting  machineId=${machineId}\n            ${url}`)
  // The apiKey travels as the FIRST websocket subprotocol; x-api-key is accepted too and sent as a belt.
  ws = new WebSocket(url, [token], { headers: { 'x-api-key': token } })

  ws.on('unexpected-response', (_req, res) => {
    // These three are genuinely different and a real adapter must not conflate them: 401 means the
    // token is dead (wipe it), 402 means billing (keep it, retry), 409 means another computer holds
    // this machine (keep it, do not fight).
    const why = { 401: 'not a remote machine, or the token was revoked — do NOT retry with this token',
                  402: 'subscription required — keep the token and retry later',
                  409: 'another computer already holds this machine' }[res.statusCode]
    console.error(`✗ HTTP ${res.statusCode}${why ? ` — ${why}` : ''}`)
    process.exit(1)
  })

  ws.on('open', () => {
    console.log('✓ connected\n  keys: o=open  c=closed  m=missing  a=agent  q=quit\n')
    sendAgent()
    sendAppState()
    // Refreshes presence AND renews the one-computer claim; the backend's own key TTL is 30s.
    pingTimer = setInterval(() => send({ t: 'ping' }), 15_000)
  })

  ws.on('message', (raw) => {
    let env
    try { env = JSON.parse(raw.toString()) } catch { return }
    if (env.t !== 'down') return
    const type = env.frame?.type
    if (type === 'machine_meta') { console.log(`← machine_meta        name="${env.frame.payload?.name ?? ''}"`); return }
    if (type === '__clients') {
      const p = env.frame.payload ?? {}
      console.log(`← __clients           ui=${p.ui ?? 0} commander=${p.commander ?? 0} active=${p.commanderActive ?? 0}`)
      return
    }
    if (type?.startsWith('e2e_')) return onE2eFrame(type, env.frame.payload ?? {}, env.connId)
    return onDataFrame(type, env.frame, env.connId)
  })

  ws.on('close', (code, reason) => {
    clearInterval(pingTimer)
    const note = code === 4000 ? ' (superseded — another adapter took this machine)'
      : code === 4003 ? ' (subscription required)' : ''
    console.error(`✗ closed ${code}${note} ${reason?.toString() ?? ''}`)
    process.exit(1)
  })
  ws.on('error', (err) => console.error('✗ socket error', err.message))
}

// Same idea as the pairing code: a file, so the state can be flipped while this runs detached.
//     echo closed > /tmp/harness-cursor-state
const STATE_FILE = '/tmp/harness-cursor-state'
setInterval(() => {
  if (!existsSync(STATE_FILE)) return
  let next
  try { next = readFileSync(STATE_FILE, 'utf8').trim(); unlinkSync(STATE_FILE) } catch { return }
  if (!['open', 'closed', 'missing'].includes(next) || next === appState) return
  appState = next
  sendAppState()
}, 400)

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (buf) => {
    const k = buf.toString()
    if (k === 'q' || k === '') { console.log('bye'); process.exit(0) }
    if (k === 'a') return sendAgent()
    const next = { o: 'open', c: 'closed', m: 'missing' }[k]
    if (!next) return
    appState = next
    sendAppState()
  })
}

connect()
