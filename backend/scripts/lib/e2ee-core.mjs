// E2EE crypto core — JS twin of apps/web/src/lib/e2ee/core.ts and
// apps/esp32-square/main/e2ee/e2ee_core.c, for the dev adapter in scripts/.
//
// This is a THIRD implementation of a scheme where every copy must agree byte-for-byte, so it is not
// trusted on inspection: `node scripts/lib/e2ee-core.mjs --selftest` re-derives the golden vectors the
// device's C port is validated against, parsed straight out of e2ee_vectors.h rather than hand-copied.
//
// Node's crypto covers Ed25519 (deterministic, unlike CryptoKit's), X25519, SHA-2, HMAC, HKDF and
// ChaCha20-Poly1305. Only ristretto255 needs @noble.

import { createHash, createHmac, hkdfSync, createPrivateKey, createPublicKey, sign as edSign,
         verify as edVerify, createCipheriv, createDecipheriv, randomBytes, diffieHellman } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../package.json', import.meta.url))
const { ristretto255, ristretto255_hasher } = require('@noble/curves/ed25519.js')

export const CPACE_DSI = 'e2e-cpace-ristretto255-v1'
export const E2E_VERSION = 1

const u8 = (s) => Buffer.from(s, 'utf8')

/** Length-prefixed concat: 4-byte BE length per field. */
export function lvCat(...parts) {
  const chunks = []
  for (const p of parts) {
    const b = Buffer.isBuffer(p) ? p : typeof p === 'string' ? u8(p) : Buffer.from(p)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length, 0)
    chunks.push(len, b)
  }
  return Buffer.concat(chunks)
}

/** expand_message_xmd (RFC 9380 §5.3.1) with SHA-512, 64-byte output. */
export function expandMessageXMD64(msg, dst) {
  const dstB = u8(dst)
  const dstPrime = Buffer.concat([dstB, Buffer.from([dstB.length])])
  const zPad = Buffer.alloc(128)                        // r_in_bytes for SHA-512
  const lIB = Buffer.from([0x00, 0x40])                 // I2OSP(64, 2)
  const b0 = createHash('sha512')
    .update(zPad).update(msg).update(lIB).update(Buffer.from([0])).update(dstPrime).digest()
  return createHash('sha512')
    .update(b0).update(Buffer.from([1])).update(dstPrime).digest()
}

// ── identity (Ed25519) ─────────────────────────────────────────────────────────────────────────────
// Node wants DER/JWK, not raw bytes, so wrap the 32-byte seed in the minimal PKCS#8 prefix.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

export function edKeyFromSeed(seed) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
}
export function edPublicFromSeed(seed) {
  const pub = createPublicKey(edKeyFromSeed(seed)).export({ format: 'der', type: 'spki' })
  return pub.subarray(pub.length - 32)
}
export function sign(seed, msg) { return edSign(null, msg, edKeyFromSeed(seed)) }
export function verify(pub, msg, sig) {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, pub]), format: 'der', type: 'spki' })
    return edVerify(null, msg, key, sig)
  } catch { return false }
}
export function fingerprint(pub) {
  const hex = createHash('sha256').update(pub).digest('hex').slice(0, 16).toUpperCase()
  return [0, 4, 8, 12].map((i) => hex.slice(i, i + 4)).join('·')
}

// ── CPace over ristretto255 ────────────────────────────────────────────────────────────────────────
export function pairContext(machineId, role = 'device') {
  return `autonomous-e2e-pair|agent:${machineId}|a:adapter|b:${role}`
}

export function cpaceGenerator(code, sid, ci) {
  const genStr = lvCat(CPACE_DSI, normalizeCode(code), sid, ci)
  // Same two steps the C does: expand_message_xmd(SHA-512, 64) then the ristretto one-way map.
  const xmd = expandMessageXMD64(genStr, CPACE_DSI)
  return ristretto255_hasher.hashToCurve(genStr, { DST: CPACE_DSI, xmd })
}

const leToBig = (b) => { let x = 0n; for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x }

/** libsodium's crypto_core_ristretto255_scalar_reduce: 64 bytes LITTLE-endian, reduced mod L. */
export function scalarReduce64(b) { return leToBig(b) % ristretto255.Point.Fn.ORDER }

/** Uniform scalar in [1, L). */
export function randScalar() {
  for (;;) {
    const s = scalarReduce64(randomBytes(64))
    if (s !== 0n) return s
  }
}

export function cpaceShared(peerY, y) {
  const P = ristretto255.Point.fromBytes(Buffer.from(peerY))
  const K = P.multiply(y)
  if (K.is0()) throw new Error('cpace: identity shared point')
  return Buffer.from(K.toBytes())
}

export function cpaceISK(sid, K, Ya, Yb) {
  return createHash('sha512').update(
    lvCat(`${CPACE_DSI}_ISK`, sid, K, lvCat(Ya, 'a'), lvCat(Yb, 'b')),
  ).digest()
}
export function transcriptHash(sid, ci, Ya, Yb) {
  return createHash('sha512').update(lvCat(sid, ci, lvCat(Ya, 'a'), lvCat(Yb, 'b'))).digest()
}
const hkdf32 = (ikm, salt, info, len) =>
  Buffer.from(hkdfSync('sha256', ikm, salt, u8(info), len))

export function kcKeys(isk, ci) {
  const kc = hkdf32(isk, u8(ci), 'e2e-kc-v1', 64)
  return { adapter: kc.subarray(0, 32), responder: kc.subarray(32, 64) }
}
export function macTag(key, th) { return createHmac('sha256', key).update(th).digest() }
export function pairKey(isk, ci) { return hkdf32(isk, u8(ci), 'e2e-id-v1', 32) }
export function pairBindSig(seed, th) { return sign(seed, Buffer.concat([u8('e2e-pair-bind'), th])) }
export function pairBindVerify(pub, th, sig) {
  return verify(pub, Buffer.concat([u8('e2e-pair-bind'), th]), sig)
}

// ── per-connection session (X25519 → HKDF) ─────────────────────────────────────────────────────────
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')

export function xKeyFromSeed(seed) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, seed]), format: 'der', type: 'pkcs8' })
}
export function xPublicFromSeed(seed) {
  const pub = createPublicKey(xKeyFromSeed(seed)).export({ format: 'der', type: 'spki' })
  return pub.subarray(pub.length - 32)
}
export function sessionKeys(ephPriv, peerEphPub, machineId, responderEphPub, initiatorEphPub) {
  const shared = diffieHellman({
    privateKey: xKeyFromSeed(ephPriv),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, Buffer.from(peerEphPub)]), format: 'der', type: 'spki' }),
  })
  const salt = lvCat(machineId, responderEphPub, initiatorEphPub)
  const sess = hkdf32(shared, salt, 'e2e-sess-v1', 64)
  return { c2s: sess.subarray(0, 32), s2c: sess.subarray(32, 64) }
}
export function helloVerify(pub, machineId, ephPub, sig) {
  return verify(pub, lvCat('e2e-hello-v1', machineId, ephPub), sig)
}
export function welcomeSig(seed, machineId, responderEphPub, initiatorEphPub) {
  return sign(seed, lvCat('e2e-welcome-v1', machineId, responderEphPub, initiatorEphPub))
}

// ── AEAD ───────────────────────────────────────────────────────────────────────────────────────────
export function counterNonce(counter) {
  const n = Buffer.alloc(12)
  n.writeBigUInt64BE(BigInt(counter), 0)   // 8-byte BE counter ‖ 4 zero bytes
  return n
}
export function aeadSeal(key, counter, aad, pt) {
  const c = createCipheriv('chacha20-poly1305', key, counterNonce(counter), { authTagLength: 16 })
  c.setAAD(aad)
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()])   // ct ‖ tag, NOT nonce-prefixed
}
export function aeadOpen(key, counter, aad, ct) {
  try {
    const body = ct.subarray(0, ct.length - 16)
    const tag = ct.subarray(ct.length - 16)
    const d = createDecipheriv('chacha20-poly1305', key, counterNonce(counter), { authTagLength: 16 })
    d.setAAD(aad)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()])
  } catch { return null }
}
/** Absent fields are the EMPTY STRING, never omitted — a missing separator changes the AAD. */
export function aad(frameType, dbSessionId, k, epoch) {
  return u8(`${E2E_VERSION}|${frameType ?? ''}|${dbSessionId ?? ''}|${k}|${epoch ?? ''}`)
}
export function wrapPayload(key, k, counter, frameType, dbSessionId, payload, epoch) {
  const ct = aeadSeal(key, counter, aad(frameType, dbSessionId, k, epoch), u8(JSON.stringify(payload ?? null)))
  const env = { v: E2E_VERSION, k, n: counter, ct: ct.toString('base64') }
  if (epoch !== undefined) env.epoch = epoch          // omitted for pairwise frames — it is in the AAD
  return { __e2e: env }
}

// ── pairing code ───────────────────────────────────────────────────────────────────────────────────
export function normalizeCode(code) {
  return code.toUpperCase().replace(/[\s\-·_]/g, '')
    .replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/U/g, 'V')
}

// ── self-test against the device's golden vectors ──────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('e2ee-core.mjs') && process.argv.includes('--selftest')) {
  const { existsSync, readFileSync } = await import('node:fs')
  const vectorCandidates = [
    process.env.E2EE_VECTORS_PATH,
    new URL('../../../autonomous-code/apps/esp32-square/main/e2ee/e2ee_vectors.h', import.meta.url).pathname,
    new URL('../../../autonomous-code/apps/esp32-square-s3/main/e2ee/e2ee_vectors.h', import.meta.url).pathname,
    new URL('../../apps/esp32-square/main/e2ee/e2ee_vectors.h', import.meta.url).pathname,
    new URL('../../apps/esp32-square-s3/main/e2ee/e2ee_vectors.h', import.meta.url).pathname,
  ].filter(Boolean)
  const vectorPath = vectorCandidates.find((path) => existsSync(path))
  if (!vectorPath) {
    console.error(`cannot find e2ee_vectors.h; tried:\n${vectorCandidates.map((path) => `  ${path}`).join('\n')}`)
    process.exit(1)
  }
  const src = readFileSync(vectorPath, 'utf8')
  const V = {}
  for (const [, k, v] of src.matchAll(/#define\s+(E2EV_\w+)\s+"([^"]*)"/g)) V[k] = v
  for (const [, k, body] of src.matchAll(/static const uint8_t\s+(E2EV_\w+)\[\]\s*=\s*\{([^}]*)\}/g)) {
    V[k] = Buffer.from(body.split(',').map((s) => s.trim()).filter(Boolean).map(Number))
  }
  let pass = 0, fail = 0
  const eq = (name, a, b) => {
    const ok = Buffer.isBuffer(a) ? a.equals(b) : a === b
    ok ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name))
  }
  // Deterministic LCG — byte-identical to the C suite and core.test.ts seeded().
  let S = 0
  const lcg = (seed, n) => { S = seed; return Buffer.from(Array.from({ length: n }, () => {
    S = (Math.imul(S, 1103515245) + 12345) & 0x7fffffff; return S & 0xff })) }

  eq('expand_message_xmd', expandMessageXMD64(V.E2EV_GENSTR, CPACE_DSI), V.E2EV_XMD64)
  const g = cpaceGenerator(V.E2EV_CODE, V.E2EV_SID, V.E2EV_CI)
  eq('cpace_generator', Buffer.from(g.toBytes()), V.E2EV_GENERATOR)
  const ya = scalarReduce64(lcg(1, 64))
  const yb = scalarReduce64(lcg(2, 64))
  eq('cpace Ya', Buffer.from(g.multiply(ya).toBytes()), V.E2EV_YA)
  eq('cpace Yb', Buffer.from(g.multiply(yb).toBytes()), V.E2EV_YB)
  const K = cpaceShared(V.E2EV_YA, yb)
  eq('cpace K', K, V.E2EV_K)
  const isk = cpaceISK(V.E2EV_SID, K, V.E2EV_YA, V.E2EV_YB)
  eq('cpace_isk', isk, V.E2EV_ISK)
  const th = transcriptHash(V.E2EV_SID, V.E2EV_CI, V.E2EV_YA, V.E2EV_YB)
  eq('transcript_hash', th, V.E2EV_TH)
  const kc = kcKeys(isk, V.E2EV_CI)
  eq('kc_adapter', kc.adapter, V.E2EV_KC_ADAPTER)
  eq('kc_responder', kc.responder, V.E2EV_KC_RESPONDER)
  eq('mac_A', macTag(kc.adapter, th), V.E2EV_MAC_A)
  eq('mac_B', macTag(kc.responder, th), V.E2EV_MAC_B)
  eq('pair_key', pairKey(isk, V.E2EV_CI), V.E2EV_PAIRKEY)
  const seedB = lcg(20, 32)
  eq('identity pub', edPublicFromSeed(seedB), V.E2EV_IDB_PUB)
  eq('pair_bind_sig', pairBindSig(seedB, th), V.E2EV_IDB_BINDSIG)
  eq('fingerprint', fingerprint(edPublicFromSeed(seedB)), V.E2EV_IDB_FP)
  const ephB = lcg(4, 32)
  eq('ephB pub', xPublicFromSeed(ephB), V.E2EV_EPHB_PUB)
  const sess = sessionKeys(ephB, V.E2EV_EPHA_PUB, V.E2EV_AGENT, V.E2EV_EPHB_PUB, V.E2EV_EPHA_PUB)
  eq('session c2s', sess.c2s, V.E2EV_C2S)
  eq('session s2c', sess.s2c, V.E2EV_S2C)
  const ct = Buffer.from(V.E2EV_AEAD_CT_B64, 'base64')
  const a = aad('commander_event', 'sess1', 'g', V.E2EV_AEAD_EPOCH)
  eq('aead_open', aeadOpen(V.E2EV_GROUPKEY, 0, a, ct).toString(), '{"kind":"processing","text":"hi"}')
  eq('aead_seal', aeadSeal(V.E2EV_GROUPKEY, 0, a, Buffer.from('{"kind":"processing","text":"hi"}')), ct)
  eq('normalizeCode', normalizeCode('k7p-4x9'), 'K7P4X9')
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
