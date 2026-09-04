import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import * as C from './core.js'
import type { Rng } from './core.js'

// Deterministic RNG for reproducible key material in tests.
function seeded(seed: number): Rng {
  let s = seed >>> 0
  return (n: number) => {
    const o = new Uint8Array(n)
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; o[i] = s & 0xff }
    return o
  }
}

const AGENT = 'f2e0383771b734e4fc00f0bc8ccf060f'

describe('e2ee core — CPace exchange', () => {
  it('adapter and web derive the same ISK from the same code', () => {
    const ci = C.pairContext(AGENT)
    const sid = C.newPairId(seeded(42))
    const code = 'K7P4X9'
    const g = C.cpaceGenerator(code, sid, ci)
    const a = C.cpaceStart(g, seeded(1)) // adapter
    const b = C.cpaceStart(g, seeded(2)) // web
    const Ka = C.cpaceShared(b.Y, a.y)
    const Kb = C.cpaceShared(a.Y, b.y)
    const iskA = C.cpaceISK(sid, Ka, a.Y, b.Y)
    const iskB = C.cpaceISK(sid, Kb, a.Y, b.Y)
    expect(Buffer.from(iskA).equals(Buffer.from(iskB))).toBe(true)
  })

  it('regression vector: fixed seeds → known ISK (guards against crypto-lib drift)', () => {
    const ci = C.pairContext(AGENT)
    const sid = C.newPairId(seeded(42))
    const g = C.cpaceGenerator('K7P4X9', sid, ci)
    const a = C.cpaceStart(g, seeded(1))
    const b = C.cpaceStart(g, seeded(2))
    const isk = C.cpaceISK(sid, C.cpaceShared(b.Y, a.y), a.Y, b.Y)
    expect(Buffer.from(sid).toString('hex')).toBe('1bb891f6f764cd8293d0c9ceeffc85da')
    expect(Buffer.from(isk).toString('hex')).toBe(
      '33fe6d15608411dec3174c7acba71622697b1c93751f934418bba8a9b77ca2913f5e39ed07361df51d550d95e519ad661fa1317764f69fb6bbcb2847fb29095c',
    )
  })

  it('a WRONG code yields a different ISK → confirmation MAC fails', () => {
    const ci = C.pairContext(AGENT)
    const sid = C.newPairId(seeded(42))
    const g = C.cpaceGenerator('K7P4X9', sid, ci)
    const gWrong = C.cpaceGenerator('WRONG1', sid, ci)
    const a = C.cpaceStart(g, seeded(1))
    const bWrong = C.cpaceStart(gWrong, seeded(2))
    const th = C.transcriptHash(sid, ci, a.Y, bWrong.Y)
    // web (wrong code) makes its MAC; adapter (right code) computes ISK its own way → mismatch
    const iskWeb = C.cpaceISK(sid, C.cpaceShared(a.Y, bWrong.y), a.Y, bWrong.Y)
    const iskAdapter = C.cpaceISK(sid, C.cpaceShared(bWrong.Y, a.y), a.Y, bWrong.Y)
    const macWeb = C.macTag(C.kcKeys(iskWeb, ci).web, th)
    expect(C.macVerify(C.kcKeys(iskAdapter, ci).web, th, macWeb)).toBe(false)
  })

  it('full exchange: identity pinning via pairKey + bind signature', () => {
    const ci = C.pairContext(AGENT)
    const sid = C.newPairId(seeded(42))
    const A = C.newIdentity(seeded(10)) // adapter identity
    const B = C.newIdentity(seeded(20)) // web identity
    const g = C.cpaceGenerator('K7P4X9', sid, ci)
    const a = C.cpaceStart(g, seeded(1))
    const b = C.cpaceStart(g, seeded(2))
    const isk = C.cpaceISK(sid, C.cpaceShared(b.Y, a.y), a.Y, b.Y)
    const th = C.transcriptHash(sid, ci, a.Y, b.Y)
    const pk = C.pairKey(isk, ci)
    // adapter seals its identity + bind sig
    const sealed = C.aeadSeal(pk, 3, C.utf8('e2e-id'), C.utf8(JSON.stringify({ id: C.b64e(A.pub), sig: C.b64e(C.pairBindSig(A.priv, th)) })))
    const opened = C.aeadOpen(pk, 3, C.utf8('e2e-id'), sealed)!
    const got = JSON.parse(new TextDecoder().decode(opened)) as { id: string; sig: string }
    expect(C.pairBindVerify(C.b64d(got.id), th, C.b64d(got.sig))).toBe(true)
    // a signature bound to a DIFFERENT transcript is rejected
    const otherTh = C.transcriptHash(C.newPairId(seeded(99)), ci, a.Y, b.Y)
    expect(C.pairBindVerify(C.b64d(got.id), otherTh, C.b64d(got.sig))).toBe(false)
    expect(B).toBeTruthy()
  })
})

describe('e2ee core — session + AEAD envelope', () => {
  it('X25519 session keys agree between both ends', () => {
    const eW = C.newEphemeral(seeded(3)), eA = C.newEphemeral(seeded(4))
    const w = C.sessionKeys(eW.priv, eA.pub, AGENT, eW.pub, eA.pub)
    const s = C.sessionKeys(eA.priv, eW.pub, AGENT, eW.pub, eA.pub)
    expect(Buffer.from(w.c2s).equals(Buffer.from(s.c2s))).toBe(true)
    expect(Buffer.from(w.s2c).equals(Buffer.from(s.s2c))).toBe(true)
  })

  it('group envelope round-trips and is bound to (type, dbSessionId, epoch) via AAD', () => {
    const key = seeded(5)(32)
    const wrapped = C.wrapPayload(key, 'g', 0, 'text_delta', 'sess1', { content: 'hi user' }, 'ab12cd34')
    expect(C.isWrapped(wrapped)).toBe(true)
    expect(C.unwrapPayload(key, wrapped.__e2e, 'text_delta', 'sess1')).toEqual({ content: 'hi user' })
    // AAD mismatch (wrong frame type / session / epoch) → cannot open
    expect(C.unwrapPayload(key, wrapped.__e2e, 'tool_start', 'sess1')).toBeNull()
    expect(C.unwrapPayload(key, wrapped.__e2e, 'text_delta', 'other')).toBeNull()
    const tampered = { ...wrapped.__e2e, epoch: 'ffffffff' }
    expect(C.unwrapPayload(key, tampered, 'text_delta', 'sess1')).toBeNull()
  })

  it('ciphertext tamper is rejected', () => {
    const key = seeded(6)(32)
    const w = C.wrapPayload(key, 'p', 1, 'session_get_result', undefined, { ok: true })
    const bad = { ...w.__e2e, ct: C.b64e(new Uint8Array(C.b64d(w.__e2e.ct).map((x, i) => (i === 0 ? x ^ 1 : x)))) }
    expect(C.unwrapPayload(key, bad, 'session_get_result', undefined)).toBeNull()
  })

  it('counter nonce is distinct per counter', () => {
    expect(Buffer.from(C.counterNonce(0)).equals(Buffer.from(C.counterNonce(1)))).toBe(false)
  })
})

describe('e2ee core — codes + fingerprint + classification', () => {
  it('normalizeCode maps look-alikes and strips separators', () => {
    expect(C.normalizeCode('k7p-4x9')).toBe('K7P4X9')
    expect(C.normalizeCode('IL O U')).toBe('110V')
  })
  it('fingerprint is stable, grouped', () => {
    const id = C.newIdentity(seeded(11))
    expect(C.fingerprint(id.pub)).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}·[0-9A-F]{4}$/)
  })
  it('frame classification', () => {
    expect(C.isEncryptedUpType('text_delta')).toBe(true)
    expect(C.isEncryptedUpType('agent_synced')).toBe(true)
    expect(C.isEncryptedUpType('node_status')).toBe(false)
    expect(C.isEncryptedDownType('agents_list')).toBe(true)
    expect(C.isEncryptedDownType('agent_update')).toBe(true)
    expect(C.ENCRYPTED_RPC_RESULT_TYPES.has('session_get_result')).toBe(true)
    expect(C.ENCRYPTED_RPC_RESULT_TYPES.has('agents_list_result')).toBe(true)
    expect(C.ENCRYPTED_RPC_RESULT_TYPES.has('agent_update_result')).toBe(true)
    expect(C.isEncryptedDownType('models_list')).toBe(true)
    expect(C.ENCRYPTED_RPC_RESULT_TYPES.has('models_list_result')).toBe(true)
    expect(C.isEncryptedDownType('terminal_input')).toBe(true)
  })

  it('gates question_response, which the device encrypts', () => {
    // Regression. The firmware wraps this frame because an AskUserQuestion answer is user content, but the
    // type was missing from ENCRYPTED_DOWN_TYPES, so dispatchDown never unwrapped it. The failure was
    // silent in the worst way: no decrypt error, just a payload that still held the {__e2e} envelope, so
    // requestId/sessionId/answers all read undefined and the answer was discarded as malformed. The device
    // returned to its tiles believing it had answered, and the CLI sat on question 1 until killed.
    expect(C.isEncryptedDownType('question_response')).toBe(true)

    const key = seeded(29)(32)
    const wrapped = C.wrapPayload(key, 'p', 1, 'question_response', undefined, {
      requestId: 'q_f5809c62', sessionId: 's1', answers: { color: 'Xanh' },
    })
    expect(wrapped).not.toHaveProperty('answers')   // the answer text must not travel in the clear
    expect(C.unwrapPayload(key, wrapped.__e2e, 'question_response', undefined)).toEqual({
      requestId: 'q_f5809c62', sessionId: 's1', answers: { color: 'Xanh' },
    })
  })

  it('round trips runtime catalog request and result only as pairwise ciphertext', () => {
    const key = seeded(23)(32)
    const request = C.wrapPayload(key, 'p', 1, 'models_list', undefined, { requestId: 'models-1' })
    expect(request).not.toHaveProperty('requestId')
    expect(C.unwrapPayload(key, request.__e2e, 'models_list', undefined)).toEqual({ requestId: 'models-1' })

    const result = C.wrapPayload(key, 'p', 2, 'models_list_result', undefined, {
      requestId: 'models-1', models: [{ id: 'runtime-v1:s1:codex:gpt@high' }],
    })
    expect(result).not.toHaveProperty('models')
    expect(C.unwrapPayload(key, result.__e2e, 'models_list_result', undefined)).toEqual({
      requestId: 'models-1', models: [{ id: 'runtime-v1:s1:codex:gpt@high' }],
    })
  })
})

/**
 * Interop keystone.
 *
 * This file is one end of a three-way contract: the same protocol is implemented by the browser client
 * (TypeScript) and by a paired hardware device (C). Those live in other repositories, so nothing here can
 * compare bytes with them directly — instead every implementation pins the SAME hash of this file. Change
 * `core.ts` and this test goes red; update the hash here and the other implementations go red until they
 * are re-derived from it. A silent divergence would break every already-paired client, with no error.
 */
describe('e2ee core — interop keystone', () => {
  it('core.ts still hashes to the pinned value shared with the other implementations', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const actual = createHash('sha256').update(readFileSync(join(here, 'core.ts'))).digest('hex')
    expect(actual).toBe('99737b4f286931f4b7cc9956ab069012d818b109458992a6a331ca44811dfc38')
  })
})
