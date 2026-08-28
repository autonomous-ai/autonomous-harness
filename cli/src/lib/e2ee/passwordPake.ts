/**
 * CPace-over-ristretto255 primitives for the persistent "remote password" machine-to-machine link
 * (`harness remote-password set/clear/status` on the target machine, `harness link connect
 * <machineId>` on the joiner) — see manager.ts's onPwPairIntent/onPwPake and relayClient.ts's
 * connectWithPassword for the state machines that use these.
 *
 * This is bookkeeping ONLY: every actual primitive (cpaceStart/cpaceShared/cpaceISK/transcriptHash/
 * kcKeys/macTag/macVerify/pairKey/pairBindSig/pairBindVerify/aeadSeal/aeadOpen) comes unchanged from
 * core.ts. core.ts is a byte-pinned crypto twin shared with the web app (see core.test.ts) and must
 * never be edited for this feature — this module only adds a PARALLEL generator construction and
 * channel-binding context, built the same way core.ts's own cpaceGenerator()/pairContext() are,
 * but kept entirely separate from them:
 *
 *  - Distinct DSI (`PW_DSI` vs core.ts's private `CPACE_DSI`) and a distinct context string
 *    (`pwContext()` vs `pairContext()`) mean the two PAKEs hash into cryptographically unrelated
 *    generator points even given the same machineId/sid — a transcript captured from one flow can
 *    never be replayed or spliced into the other, and the two attempt-counting/lockout regimes
 *    (RATE_MAX=3/5min for the live code, the exponential-backoff lockout here) can never be confused.
 *  - The live pairing code is single-use, ~30 bits of entropy, and expires in 60s, so core.ts's
 *    cpaceGenerator() feeds it through normalizeCode() (uppercase, strip separators, remap look-alike
 *    characters) — correct for a code read off a screen, but WRONG for a password: it would silently
 *    mangle whatever the user actually typed. The remote password is long-lived, human-chosen, and
 *    reused across arbitrarily many attempts, so it needs slow-hash stretching (scrypt) instead —
 *    something the disposable high-entropy code never needed. pwCpaceGenerator() below therefore
 *    takes an already-stretched key and never calls normalizeCode().
 */
import { RistrettoPoint, hashToRistretto255 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'
import { scryptAsync } from '@noble/hashes/scrypt'
import { lvCat, utf8 } from './core.js'

/** Distinct from core.ts's private `CPACE_DSI` ('e2e-cpace-ristretto255-v1'). */
const PW_DSI = 'e2e-cpace-ristretto255-pw-v1'

// scrypt cost parameters for stretching a human-chosen, indefinitely-reused password — deliberately
// expensive (interactive-login class), unlike the disposable high-entropy pairing code, which needs
// no stretching at all. N=2^17/r=8/p=1 costs roughly ~0.5-1s and ~128MB on typical hardware, in line
// with common scrypt interactive-login guidance for a secret that lives until explicitly rotated.
const SCRYPT_N = 2 ** 17
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_DKLEN = 32

/** Slow-hash a persistent remote password into a 32-byte verifier/key-material seed, salted per
 *  machineId so the same password chosen on two different machines derives unrelated verifiers (and
 *  therefore unrelated CPace generators). Deterministic for a given (password, machineId) pair. */
export async function stretchPassword(password: string, machineId: string): Promise<Uint8Array> {
  const salt = sha256(utf8(`e2e-remote-password-salt-v1|${machineId}`))
  return scryptAsync(utf8(password.normalize('NFKC')), salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: SCRYPT_DKLEN })
}

/** Channel-binding string for the password-PAKE — the machine-to-machine counterpart of core.ts's
 *  pairContext(), but permanently distinct from it (never 'web'/'device' roles — the joiner is
 *  always a machine's own CLI identity, not a browser or hardware device). */
export function pwContext(machineId: string): string {
  return `autonomous-e2e-pw-pair|agent:${machineId}|a:adapter|b:machine`
}

/** Generator g = hashToGroup(PW_DSI, stretched, sid, ci). Same construction as core.ts's
 *  cpaceGenerator(code, sid, ci), but over an already-stretched password — never raw user input, and
 *  never routed through normalizeCode(). */
export function pwCpaceGenerator(stretched: Uint8Array, sid: Uint8Array, ci: string): InstanceType<typeof RistrettoPoint> {
  const genStr = lvCat(PW_DSI, stretched, sid, ci)
  return hashToRistretto255(genStr, { DST: PW_DSI })
}
