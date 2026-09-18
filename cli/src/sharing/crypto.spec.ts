import { describe, expect, it } from 'vitest'
import { b64e, newEphemeral, newIdentity, wrapPayload } from '../lib/e2ee/core.js'
import { observerContext, ObserverCipher, ownerHandshake, recipientHandshake } from './crypto.js'

function pair(machine = 'machine', share = 'share') {
  const identity = newIdentity(), ephemeral = newEphemeral()
  const owner = ownerHandshake(identity, machine, share, b64e(ephemeral.pub))
  const recipient = recipientHandshake(ephemeral, machine, share, b64e(identity.pub), owner.welcome)
  return { identity, ephemeral, owner, recipient }
}
describe('isolated observer encryption', () => {
  it('authenticates the owner and encrypts each direction without a machine group key', () => {
    const p = pair(), input = { type: 'terminal_open', payload: { agentId: 'agent' } }
    const encrypted = p.recipient.seal(input)
    expect(JSON.stringify(encrypted)).not.toContain('agent')
    expect(p.owner.cipher.open(encrypted)).toEqual(input)
    expect(p.recipient.open(p.owner.cipher.seal({ type: 'terminal_output', text: 'hello' }))).toEqual({ type: 'terminal_output', text: 'hello' })
  })
  it('rejects replay, reflection, other recipients, changed ciphertext and grant substitution', () => {
    const p = pair(), other = pair(), packet = p.recipient.seal({ type: 'terminal_open' })
    expect(p.recipient.open(packet)).toBeNull()
    expect(other.owner.cipher.open(packet)).toBeNull()
    const bad = structuredClone(packet); bad.__e2e.ct = b64e(new Uint8Array(32))
    expect(p.owner.cipher.open(bad)).toBeNull()
    expect(p.owner.cipher.open(packet)).toEqual({ type: 'terminal_open' })
    expect(p.owner.cipher.open(packet)).toBeNull()
    expect(() => recipientHandshake(p.ephemeral, 'machine', 'other-share', b64e(p.identity.pub), p.owner.welcome)).toThrow()
    expect(() => recipientHandshake(p.ephemeral, 'machine', 'share', b64e(newIdentity().pub), p.owner.welcome)).toThrow()
  })
  it('rejects malformed handshake keys and envelopes', () => {
    const p = pair()
    expect(() => ownerHandshake(p.identity, 'm', 's', 'bad')).toThrow()
    expect(() => ownerHandshake(p.identity, 'm', 's', b64e(new Uint8Array(32)))).toThrow()
    expect(() => recipientHandshake(p.ephemeral, 'm', 's', 'bad', { ephemeral: 'bad' })).toThrow()
    for (const value of [null, {}, { __e2e: {} }, { __e2e: { v: 2 } },
      { __e2e: { v: 1, k: 'g' } }, { __e2e: { v: 1, k: 'p', n: -1 } },
      { __e2e: { v: 1, k: 'p', n: 0.5 } }, { __e2e: { v: 1, k: 'p', n: 0, ct: 4 } },
      { __e2e: { v: 1, k: 'p', n: 0, ct: 'x'.repeat(3 * 1024 * 1024 + 1) } },
      { __e2e: { v: 1, k: 'p', n: 0, ct: 'invalid' } }]) expect(p.owner.cipher.open(value)).toBeNull()
  })
  it('rejects decrypted values that are not frames and contains malformed getters', () => {
    const key = new Uint8Array(32), context = observerContext('m', 's')
    const cipher = new ObserverCipher(key, key, context)
    for (const value of [null, false, 'text', []]) expect(cipher.open(wrapPayload(key, 'p', 0, 'observer_frame', context, value))).toBeNull()
    expect(cipher.open({ get __e2e() { throw new Error('malformed') } })).toBeNull()
  })
})
