import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket from 'ws'
import { LampTransport, type LampFrame } from './transport.js'
import { LampStore } from './store.js'
import { lampContext, signFrame, verifyFrame } from './crypto.js'
import { aeadOpen, aeadSeal, b64d, b64e, cpaceGenerator, cpaceISK, cpaceShared, cpaceStart, kcKeys, macTag, macVerify, newEphemeral, newIdentity, newPairId, pairBindSig, pairBindVerify, pairKey, sessionKeys, transcriptHash, unwrapPayload, utf8, wrapPayload, type Identity } from '../e2ee/core.js'

const dirs: string[] = [], servers: LampTransport[] = [], sockets: WebSocket[] = []
afterEach(async () => { for (const ws of sockets.splice(0)) ws.terminate(); await Promise.all(servers.splice(0).map(s => s.stop())); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function inbox(ws: WebSocket) {
  const queue: LampFrame[] = [], waiters: Array<(f: LampFrame) => void> = []
  ws.on('message', raw => { const f = JSON.parse(raw.toString()) as LampFrame; const waiter = waiters.shift(); if (waiter) waiter(f); else queue.push(f) })
  return () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<LampFrame>(resolve => waiters.push(resolve))
}
async function socket(server: LampTransport) { const ws = new WebSocket(`ws://127.0.0.1:${server.status().port}/api/lamp-ws`); sockets.push(ws); const next = inbox(ws); await once(ws, 'open'); return { ws, next } }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lamp-')); dirs.push(dir)
  const identity = newIdentity(), onRequest = vi.fn(), onRevoked = vi.fn()
  const server = new LampTransport({ machineId: 'machine', machineName: 'Computer', identity, dataDir: dir, serverInstanceId: 'instance', bind: '127.0.0.1', port: 0, capabilities: ['turn.send'], onRequest, onRevoked })
  servers.push(server); return { server, identity, dir, onRequest, onRevoked }
}
async function pair(server: LampTransport, code: string, client: Identity) {
  const { ws, next } = await socket(server), sid = newPairId(), pairId = b64e(sid), ci = lampContext('machine')
  ws.send(JSON.stringify({ type: 'lamp_pair_intent', role: 'lamp', label: 'Kitchen', pairId }))
  expect((await next()).accepted).toBe(true)
  const one = await next(), ya = b64d(one.ya as string), start = cpaceStart(cpaceGenerator(code, sid, ci))
  const isk = cpaceISK(sid, cpaceShared(ya, start.y), ya, start.Y), th = transcriptHash(sid, ci, ya, start.Y), kc = kcKeys(isk, ci), key = pairKey(isk, ci)
  ws.send(JSON.stringify({ type: 'lamp_pake', pairId, round: 2, yb: b64e(start.Y), mac: b64e(macTag(kc.web, th)) }))
  const three = await next()
  if (three.type === 'lamp_pair_error') return { ws, next, error: three }
  expect(macVerify(kc.adapter, th, b64d(three.mac as string))).toBe(true)
  const peer = JSON.parse(new TextDecoder().decode(aeadOpen(key, 3, utf8('e2e-id'), b64d(three.enc as string))!))
  expect(pairBindVerify(b64d(peer.id), th, b64d(peer.sig))).toBe(true)
  ws.send(JSON.stringify({ type: 'lamp_pake', pairId, round: 4, enc: b64e(aeadSeal(key, 4, utf8('e2e-id'), utf8(JSON.stringify({ id: b64e(client.pub), sig: b64e(pairBindSig(client.priv, th)) })))) }))
  expect((await next()).ok).toBe(true)
  return { ws, next }
}
async function handshake(server: LampTransport, client: Identity, serverIdentity: Identity, finish = true) {
  const { ws, next } = await socket(server), eph = newEphemeral()
  const hello: LampFrame = { type: 'lamp_hello', proto: 1, machineId: 'machine', lampId: b64e(client.pub), ephPub: b64e(eph.pub), capabilities: ['turn.send'] }
  hello.sig = signFrame('hello', 'machine', hello, client.priv); ws.send(JSON.stringify(hello))
  const welcome = await next()
  expect(verifyFrame('welcome', 'machine', welcome, serverIdentity.pub, eph.pub)).toBe(true)
  const keys = sessionKeys(eph.priv, b64d(welcome.ephPub as string), 'machine', eph.pub, b64d(welcome.ephPub as string))
  let counter = 0
  const seal = (frame: LampFrame) => ({ type: frame.type, ...(frame.agentId ? { agentId: frame.agentId } : {}), payload: wrapPayload(keys.c2s, 'p', counter++, frame.type as string, frame.agentId as string | undefined, frame) })
  const finished = () => ws.send(JSON.stringify(seal({ type: 'lamp_finished', challenge: welcome.challenge })))
  if (finish) { finished(); expect((await next()).type).toBe('lamp_ready') }
  return { ws, next, keys, seal, finished, hello }
}
describe('lamp LAN trust and encryption', () => {
  it('pairs, persists private trust, dispatches only encrypted untampered requests, and revokes', async () => {
    const { server, dir, identity, onRequest, onRevoked } = fixture(), client = newIdentity()
    const window = await server.pairStart(); await pair(server, window.code as string, client)
    expect(server.store.paired()).toBeNull()
    const c = await handshake(server, client, identity)
    expect(new LampStore(dir).paired()?.id).toBe(b64e(client.pub))
    expect(statSync(join(dir, 'e2e', 'lamps.json')).mode & 0o777).toBe(0o600)
    const frame = c.seal({ type: 'turn.send', agentId: 'agent', text: 'private prompt' })
    c.ws.send(JSON.stringify({ ...frame, agentId: 'other' }))
    c.ws.send(JSON.stringify(frame)); c.ws.send(JSON.stringify(frame))
    await vi.waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))
    expect(onRequest.mock.calls[0][1]).toMatchObject({ agentId: 'agent', text: 'private prompt' })
    const close = once(c.ws, 'close'); expect(server.revoke(b64e(client.pub))).toBe(1)
    expect((await close)[0]).toBe(4403); expect(onRevoked).toHaveBeenCalledWith(b64e(client.pub))
    const denied = await socket(server); denied.ws.send(JSON.stringify(c.hello))
    expect((await denied.next()).error).toMatchObject({ code: 'UNKNOWN_LAMP' })
  })
  it('preserves incumbent through wrong code and replacement until encrypted finished', async () => {
    const { server, identity } = fixture(), old = newIdentity(), replacement = newIdentity()
    let window = await server.pairStart(); await pair(server, window.code as string, old)
    const incumbent = await handshake(server, old, identity)
    await expect(server.pairStart()).rejects.toMatchObject({ code: 'ALREADY_PAIRED' })
    window = await server.pairStart({ replace: true })
    expect((await pair(server, 'ZZZZZZ', replacement)).error).toBeDefined()
    expect(server.store.paired()?.id).toBe(b64e(old.pub)); server.pairCancel()
    window = await server.pairStart({ replace: true }); await pair(server, window.code as string, replacement)
    const candidate = await handshake(server, replacement, identity, false)
    expect(server.store.paired()?.id).toBe(b64e(old.pub))
    const closed = once(incumbent.ws, 'close'); candidate.finished(); await candidate.next()
    expect((await closed)[0]).toBe(4410); expect(server.store.paired()?.id).toBe(b64e(replacement.pub))
  })
  it('does not supersede an active socket for a replayed signed hello without key confirmation', async () => {
    const { server, identity } = fixture(), client = newIdentity()
    const window = await server.pairStart(); await pair(server, window.code as string, client)
    const incumbent = await handshake(server, client, identity)
    const attacker = await socket(server); attacker.ws.send(JSON.stringify(incumbent.hello)); await attacker.next()
    expect(incumbent.ws.readyState).toBe(WebSocket.OPEN)
    const next = await handshake(server, client, identity, false), closed = once(incumbent.ws, 'close')
    next.finished(); await next.next(); expect((await closed)[0]).toBe(4408)
    expect(server.send({ type: 'status', text: 'secret' })).toBe(true)
    const wire = await next.next()
    expect(JSON.stringify(wire)).not.toContain('secret')
    expect(unwrapPayload(next.keys.s2c, (wire.payload as { __e2e: Parameters<typeof unwrapPayload>[1] }).__e2e, 'status', undefined)).toMatchObject({ text: 'secret' })
  })
})
