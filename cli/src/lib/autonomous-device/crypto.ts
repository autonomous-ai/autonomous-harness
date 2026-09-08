import { sha256 } from '@noble/hashes/sha2'
import { b64d, b64e, lvCat, sign, utf8, verify } from '../e2ee/core.js'

/** Only the top-level signature is omitted; nested fields remain authenticated. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])])) : v
  return JSON.stringify(sort(value))
}
export function autonomousDeviceContext(machineId: string): string {
  return `autonomous-e2e-pair|agent:${machineId}|a:adapter|b:autonomous-device`
}
export function signingMessage(kind: 'hello' | 'welcome', machineId: string, frame: Record<string, unknown>, deviceEph?: Uint8Array): Uint8Array {
  const { sig: _sig, ...body } = frame
  const parts: Array<string | Uint8Array> = [`autonomous-device-${kind}-v1`, machineId, sha256(utf8(canonical(body)))]
  if (kind === 'welcome') {
    if (!deviceEph) throw new Error('device welcome requires client ephemeral')
    parts.push(deviceEph)
  }
  return lvCat(...parts)
}
export function signFrame(kind: 'hello' | 'welcome', machineId: string, frame: Record<string, unknown>, priv: Uint8Array, deviceEph?: Uint8Array): string {
  return b64e(sign(priv, signingMessage(kind, machineId, frame, deviceEph)))
}
export function verifyFrame(kind: 'hello' | 'welcome', machineId: string, frame: Record<string, unknown>, pub: Uint8Array, deviceEph?: Uint8Array): boolean {
  return typeof frame.sig === 'string' && verify(pub, signingMessage(kind, machineId, frame, deviceEph), b64d(frame.sig))
}
export function decodeFixed(value: unknown, size: number): Uint8Array {
  if (typeof value !== 'string') throw new Error('invalid encoding')
  const result = b64d(value)
  if (result.length !== size || b64e(result) !== value) throw new Error('invalid encoding')
  return result
}
