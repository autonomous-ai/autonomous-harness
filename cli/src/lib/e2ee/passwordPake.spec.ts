import { describe, expect, it } from 'vitest'
import { RistrettoPoint } from '@noble/curves/ed25519'
import * as C from './core.js'
import { pwCpaceGenerator, pwContext, stretchPassword } from './passwordPake.js'

const MACHINE_A = 'f2e0383771b734e4fc00f0bc8ccf060f'
const MACHINE_B = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('stretchPassword', () => {
  it('is deterministic for the same (password, machineId)', async () => {
    const a = await stretchPassword('correct horse battery staple', MACHINE_A)
    const b = await stretchPassword('correct horse battery staple', MACHINE_A)
    expect(C.b64e(a)).toBe(C.b64e(b))
    expect(a.length).toBe(32)
  })

  it('differs for a different machineId (same password)', async () => {
    const a = await stretchPassword('correct horse battery staple', MACHINE_A)
    const b = await stretchPassword('correct horse battery staple', MACHINE_B)
    expect(C.b64e(a)).not.toBe(C.b64e(b))
  })

  it('differs for a different password (same machineId)', async () => {
    const a = await stretchPassword('correct horse battery staple', MACHINE_A)
    const b = await stretchPassword('a totally different password', MACHINE_A)
    expect(C.b64e(a)).not.toBe(C.b64e(b))
  })

  it('normalizes the password (NFKC) before stretching, so visually-identical inputs match', async () => {
    // 'é' as one codepoint (U+00E9) vs 'e' + combining acute (U+0065 U+0301) — NFKC folds them to the
    // same sequence, so a password typed either way must derive the same verifier.
    const composed = await stretchPassword('café', MACHINE_A)
    const decomposed = await stretchPassword('café', MACHINE_A)
    expect(composed).not.toBe(decomposed) // sanity: the raw JS strings really are different
    expect(C.b64e(composed)).toBe(C.b64e(decomposed))
  })
})

describe('pwContext', () => {
  it('is distinct from core.ts\'s pairContext for the same machineId', () => {
    expect(pwContext(MACHINE_A)).not.toBe(C.pairContext(MACHINE_A))
    expect(pwContext(MACHINE_A)).not.toBe(C.pairContext(MACHINE_A, 'device'))
  })

  it('varies by machineId', () => {
    expect(pwContext(MACHINE_A)).not.toBe(pwContext(MACHINE_B))
  })
})

describe('pwCpaceGenerator', () => {
  it('produces a valid, non-identity ristretto255 point', async () => {
    const stretched = await stretchPassword('correct horse battery staple', MACHINE_A)
    const sid = C.newPairId()
    const g = pwCpaceGenerator(stretched, sid, pwContext(MACHINE_A))
    expect(g.equals(RistrettoPoint.ZERO)).toBe(false)
    // Round-trips through raw bytes cleanly (i.e. is a well-formed group element).
    expect(RistrettoPoint.fromHex(g.toRawBytes()).equals(g)).toBe(true)
  })

  it('is deterministic for the same (stretched, sid, ci) and varies with each input', async () => {
    const stretched = await stretchPassword('correct horse battery staple', MACHINE_A)
    const sid = C.newPairId()
    const ci = pwContext(MACHINE_A)
    const g1 = pwCpaceGenerator(stretched, sid, ci)
    const g2 = pwCpaceGenerator(stretched, sid, ci)
    expect(g1.equals(g2)).toBe(true)

    const otherSid = C.newPairId()
    expect(g1.equals(pwCpaceGenerator(stretched, otherSid, ci))).toBe(false)
    expect(g1.equals(pwCpaceGenerator(stretched, sid, pwContext(MACHINE_B)))).toBe(false)

    const otherStretched = await stretchPassword('a different password entirely', MACHINE_A)
    expect(g1.equals(pwCpaceGenerator(otherStretched, sid, ci))).toBe(false)
  })

  it('never collides with core.ts\'s live-code cpaceGenerator for the same sid/machineId, even if the ' +
    'stretched password happens to equal the (padded) code bytes', () => {
    const sid = C.newPairId()
    // Feed the SAME raw bytes into both constructions (bypassing stretchPassword/normalizeCode) to
    // isolate the DSI/context separation as the only thing keeping the two flows apart.
    const sharedSecretBytes = new Uint8Array(32).fill(7)
    const pwGenerator = pwCpaceGenerator(sharedSecretBytes, sid, pwContext(MACHINE_A))
    const codeGenerator = C.cpaceGenerator('AAAAAA', sid, C.pairContext(MACHINE_A))
    expect(pwGenerator.equals(codeGenerator)).toBe(false)
  })
})

describe('full CPace flow with a wrong password', () => {
  it('the responder\'s confirmation MAC fails to verify when the two sides stretch different passwords', async () => {
    const sid = C.newPairId()
    const ciA = pwContext(MACHINE_A)

    // "A" side (has the real password) starts CPace, exactly as manager.ts's onPwPairIntent does.
    const realStretched = await stretchPassword('correct horse battery staple', MACHINE_A)
    const gA = pwCpaceGenerator(realStretched, sid, ciA)
    const { y: yA, Y: Ya } = C.cpaceStart(gA)

    // "B" side (guesses wrong) derives its own generator from a DIFFERENT stretched password — the
    // two therefore land on different ristretto255 points despite sharing sid/context.
    const wrongStretched = await stretchPassword('a wrong guess', MACHINE_A)
    const gB = pwCpaceGenerator(wrongStretched, sid, ciA)
    const { y: yB, Y: Yb } = C.cpaceStart(gB)
    expect(gA.equals(gB)).toBe(false)

    const kB = C.cpaceShared(Ya, yB)
    const iskB = C.cpaceISK(sid, kB, Ya, Yb)
    const thB = C.transcriptHash(sid, ciA, Ya, Yb)
    const kcB = C.kcKeys(iskB, ciA)
    const macFromB = C.macTag(kcB.web, thB)

    // "A" independently derives its own isk/th/kc from ITS shared point — mismatched because gA != gB
    // means K_A = Yb^y_A != K_B = Ya^y_B in general (different groups' worth of exponentiation).
    const kA = C.cpaceShared(Yb, yA)
    const iskA = C.cpaceISK(sid, kA, Ya, Yb)
    const thA = C.transcriptHash(sid, ciA, Ya, Yb)
    const kcA = C.kcKeys(iskA, ciA)

    expect(C.macVerify(kcA.web, thA, macFromB)).toBe(false)
  })
})
