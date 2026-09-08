/** Regenerate public interoperability fixtures: npx tsx src/lib/lamp/vectors/generate.ts. */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as C from '../../e2ee/core.js'
import { canonical, lampContext, signFrame, signingMessage } from '../crypto.js'
const bytes = (start: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 255)
const rng = (start: number): C.Rng => n => bytes(start, n)
const hex = (v: Uint8Array) => Buffer.from(v).toString('hex')
const machineId = 'lamp-vector-machine', code = 'K7P4X9', sid = bytes(0, 16), ci = lampContext(machineId)
const g = C.cpaceGenerator(code, sid, ci), a = C.cpaceStart(g, rng(1)), b = C.cpaceStart(g, rng(65))
const shared = C.cpaceShared(b.Y, a.y), isk = C.cpaceISK(sid, shared, a.Y, b.Y), th = C.transcriptHash(sid, ci, a.Y, b.Y), kc = C.kcKeys(isk, ci), pairKey = C.pairKey(isk, ci)
const adapter = C.newIdentity(rng(129)), lamp = C.newIdentity(rng(161))
const adapterEph = C.newEphemeral(rng(193)), lampEph = C.newEphemeral(rng(225))
const hello: Record<string, unknown> = { type: 'lamp_hello', proto: 1, machineId, lampId: C.b64e(lamp.pub), ephPub: C.b64e(lampEph.pub), capabilities: ['agents.list', 'turn.send', 'receipt.get'], client: { name: 'autonomous-lamp', version: '1' }, resume: { serverInstanceId: 'previous', cursor: 4 } }
hello.sig = signFrame('hello', machineId, hello, lamp.priv)
const welcome: Record<string, unknown> = { type: 'lamp_welcome', proto: 1, machineId, machineName: 'Vector machine', ephPub: C.b64e(adapterEph.pub), serverInstanceId: 'instance', capabilities: ['agents.list', 'turn.send', 'receipt.get'], limits: { maxFrameBytes: 65536 }, resumed: false, cursor: 0, challenge: '00000000-0000-4000-8000-000000000001' }
welcome.sig = signFrame('welcome', machineId, welcome, adapter.priv, lampEph.pub)
const keys = C.sessionKeys(adapterEph.priv, lampEph.pub, machineId, lampEph.pub, adapterEph.pub)
const identity = { id: C.b64e(adapter.pub), sig: C.b64e(C.pairBindSig(adapter.priv, th)) }
const finished = { type: 'lamp_finished', challenge: welcome.challenge }
const ready = { type: 'lamp_ready', serverInstanceId: welcome.serverInstanceId }
const request = { type: 'turn.send', requestId: '00000000-0000-4000-8000-000000000002', idempotencyKey: 'lamp-vector-1', machineId, agentId: 'agent-vector', text: 'Xin chào lamp' }
const vectors = {
  v: 1, note: 'Public deterministic test-only keys. All byte strings base64 unless named Hex. CPace uses noble hashToRistretto255 (XMD SHA-512), not IETF draft wire format.',
  pairing: { machineId, code, pairId: C.b64e(sid), ci, generator: C.b64e(g.toRawBytes()), aScalarLEHex: hex(Uint8Array.from({ length: 32 }, (_, i) => Number((a.y >> BigInt(8 * i)) & 255n))), bScalarLEHex: hex(Uint8Array.from({ length: 32 }, (_, i) => Number((b.y >> BigInt(8 * i)) & 255n))), ya: C.b64e(a.Y), yb: C.b64e(b.Y), shared: C.b64e(shared), isk: C.b64e(isk), transcriptHash: C.b64e(th), kcAdapter: C.b64e(kc.adapter), kcLamp: C.b64e(kc.web), macAdapter: C.b64e(C.macTag(kc.adapter, th)), macLamp: C.b64e(C.macTag(kc.web, th)), pairKey: C.b64e(pairKey), round3Plaintext: identity, round3Enc: C.b64e(C.aeadSeal(pairKey, 3, C.utf8('e2e-id'), C.utf8(JSON.stringify(identity)))) },
  identity: { adapterPriv: C.b64e(adapter.priv), adapterPub: C.b64e(adapter.pub), lampPriv: C.b64e(lamp.priv), lampPub: C.b64e(lamp.pub) },
  session: { adapterEphPriv: C.b64e(adapterEph.priv), adapterEphPub: C.b64e(adapterEph.pub), lampEphPriv: C.b64e(lampEph.priv), lampEphPub: C.b64e(lampEph.pub), hello, helloSigningMessage: C.b64e(signingMessage('hello', machineId, hello)), welcome, welcomeSigningMessage: C.b64e(signingMessage('welcome', machineId, welcome, lampEph.pub)), c2s: C.b64e(keys.c2s), s2c: C.b64e(keys.s2c), finished, finishedEnvelope: C.wrapPayload(keys.c2s, 'p', 0, 'lamp_finished', undefined, finished), ready, readyEnvelope: C.wrapPayload(keys.s2c, 'p', 0, 'lamp_ready', undefined, ready), request, requestEnvelope: C.wrapPayload(keys.c2s, 'p', 1, 'turn.send', 'agent-vector', request) },
  canonical: { input: { z: 1, a: { sig: 'nested sig must remain', b: [true, null, 'lamp'] } }, output: canonical({ z: 1, a: { sig: 'nested sig must remain', b: [true, null, 'lamp'] } }) },
}
writeFileSync(fileURLToPath(new URL('./lamp-protocol.json', import.meta.url)), JSON.stringify(vectors, null, 2) + '\n')
