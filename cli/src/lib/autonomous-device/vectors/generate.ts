/** Regenerate public interoperability fixtures: npx tsx src/lib/autonomous-device/vectors/generate.ts. */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as C from '../../e2ee/core.js'
import { canonical, autonomousDeviceContext, signFrame, signingMessage } from '../crypto.js'
const bytes = (start: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 255)
const rng = (start: number): C.Rng => n => bytes(start, n)
const hex = (v: Uint8Array) => Buffer.from(v).toString('hex')
const machineId = 'device-vector-machine', code = 'K7P4X9', sid = bytes(0, 16), ci = autonomousDeviceContext(machineId)
const g = C.cpaceGenerator(code, sid, ci), a = C.cpaceStart(g, rng(1)), b = C.cpaceStart(g, rng(65))
const shared = C.cpaceShared(b.Y, a.y), isk = C.cpaceISK(sid, shared, a.Y, b.Y), th = C.transcriptHash(sid, ci, a.Y, b.Y), kc = C.kcKeys(isk, ci), pairKey = C.pairKey(isk, ci)
const adapter = C.newIdentity(rng(129)), device = C.newIdentity(rng(161))
const adapterEph = C.newEphemeral(rng(193)), deviceEph = C.newEphemeral(rng(225))
const hello: Record<string, unknown> = { type: 'autonomous_device_hello', proto: 1, machineId, deviceId: C.b64e(device.pub), ephPub: C.b64e(deviceEph.pub), capabilities: ['agents.list', 'turn.send', 'receipt.get'], client: { name: 'autonomous-device', version: '1' }, resume: { serverInstanceId: 'previous', cursor: 4 } }
hello.sig = signFrame('hello', machineId, hello, device.priv)
const welcome: Record<string, unknown> = { type: 'autonomous_device_welcome', proto: 1, machineId, machineName: 'Vector machine', ephPub: C.b64e(adapterEph.pub), serverInstanceId: 'instance', capabilities: ['agents.list', 'turn.send', 'receipt.get'], limits: { maxFrameBytes: 65536 }, resumed: false, cursor: 0, challenge: '00000000-0000-4000-8000-000000000001' }
welcome.sig = signFrame('welcome', machineId, welcome, adapter.priv, deviceEph.pub)
const keys = C.sessionKeys(adapterEph.priv, deviceEph.pub, machineId, deviceEph.pub, adapterEph.pub)
const identity = { id: C.b64e(adapter.pub), sig: C.b64e(C.pairBindSig(adapter.priv, th)) }
const finished = { type: 'autonomous_device_finished', challenge: welcome.challenge }
const ready = { type: 'autonomous_device_ready', serverInstanceId: welcome.serverInstanceId }
const request = { type: 'turn.send', requestId: '00000000-0000-4000-8000-000000000002', idempotencyKey: 'device-vector-1', machineId, agentId: 'agent-vector', text: 'Xin chào device' }
const vectors = {
  v: 1, note: 'Public deterministic test-only keys. All byte strings base64 unless named Hex. CPace uses noble hashToRistretto255 (XMD SHA-512), not IETF draft wire format.',
  pairing: { machineId, code, pairId: C.b64e(sid), ci, generator: C.b64e(g.toRawBytes()), aScalarLEHex: hex(Uint8Array.from({ length: 32 }, (_, i) => Number((a.y >> BigInt(8 * i)) & 255n))), bScalarLEHex: hex(Uint8Array.from({ length: 32 }, (_, i) => Number((b.y >> BigInt(8 * i)) & 255n))), ya: C.b64e(a.Y), yb: C.b64e(b.Y), shared: C.b64e(shared), isk: C.b64e(isk), transcriptHash: C.b64e(th), kcAdapter: C.b64e(kc.adapter), kcDevice: C.b64e(kc.web), macAdapter: C.b64e(C.macTag(kc.adapter, th)), macDevice: C.b64e(C.macTag(kc.web, th)), pairKey: C.b64e(pairKey), round3Plaintext: identity, round3Enc: C.b64e(C.aeadSeal(pairKey, 3, C.utf8('e2e-id'), C.utf8(JSON.stringify(identity)))) },
  identity: { adapterPriv: C.b64e(adapter.priv), adapterPub: C.b64e(adapter.pub), devicePriv: C.b64e(device.priv), devicePub: C.b64e(device.pub) },
  session: { adapterEphPriv: C.b64e(adapterEph.priv), adapterEphPub: C.b64e(adapterEph.pub), deviceEphPriv: C.b64e(deviceEph.priv), deviceEphPub: C.b64e(deviceEph.pub), hello, helloSigningMessage: C.b64e(signingMessage('hello', machineId, hello)), welcome, welcomeSigningMessage: C.b64e(signingMessage('welcome', machineId, welcome, deviceEph.pub)), c2s: C.b64e(keys.c2s), s2c: C.b64e(keys.s2c), finished, finishedEnvelope: C.wrapPayload(keys.c2s, 'p', 0, 'autonomous_device_finished', undefined, finished), ready, readyEnvelope: C.wrapPayload(keys.s2c, 'p', 0, 'autonomous_device_ready', undefined, ready), request, requestEnvelope: C.wrapPayload(keys.c2s, 'p', 1, 'turn.send', 'agent-vector', request) },
  canonical: { input: { z: 1, a: { sig: 'nested sig must remain', b: [true, null, 'device'] } }, output: canonical({ z: 1, a: { sig: 'nested sig must remain', b: [true, null, 'device'] } }) },
}
writeFileSync(fileURLToPath(new URL('./autonomous-device-protocol.json', import.meta.url)), JSON.stringify(vectors, null, 2) + '\n')
