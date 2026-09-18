import {
  b64d, b64e, newEphemeral, sessionKeys, welcomeSig, welcomeVerify,
  wrapPayload, unwrapPayload, type Ephemeral, type Identity, type WrappedPayload,
} from '../lib/e2ee/core.js'

/** Domain separation also binds the invitation: ciphertext cannot move between grants or directions. */
export function observerContext(machineId: string, shareId: string): string {
  return `harness-observer-v1:${machineId}:${shareId}`
}
export class ObserverCipher {
  private tx = 0
  private rx = -1
  constructor(private readonly sendKey: Uint8Array, private readonly receiveKey: Uint8Array,
    private readonly context: string) {}
  seal(frame: unknown): WrappedPayload {
    return wrapPayload(this.sendKey, 'p', this.tx++, 'observer_frame', this.context, frame)
  }
  open(value: unknown): Record<string, unknown> | null {
    try {
      const e = (value as WrappedPayload)?.__e2e
      if (!e || e.v !== 1 || e.k !== 'p' || !Number.isSafeInteger(e.n) || e.n <= this.rx
        || typeof e.ct !== 'string' || e.ct.length > 3 * 1024 * 1024) return null
      const frame = unwrapPayload(this.receiveKey, e, 'observer_frame', this.context)
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
      this.rx = e.n
      return frame as Record<string, unknown>
    } catch { return null }
  }
}

export function ownerHandshake(identity: Identity, machineId: string, shareId: string, peer: string) {
  const publicKey = b64d(peer)
  if (publicKey.length !== 32) throw new Error('Invalid observer key')
  const ephemeral = newEphemeral()
  const context = observerContext(machineId, shareId)
  const keys = sessionKeys(ephemeral.priv, publicKey, context, publicKey, ephemeral.pub)
  return { cipher: new ObserverCipher(keys.s2c, keys.c2s, context),
    welcome: { ephemeral: b64e(ephemeral.pub),
      signature: b64e(welcomeSig(identity.priv, context, publicKey, ephemeral.pub)) } }
}

export function recipientHandshake(ephemeral: Ephemeral, machineId: string, shareId: string,
  ownerPublicKey: string, welcome: Record<string, unknown>): ObserverCipher {
  const publicKey = b64d(String(welcome.ephemeral))
  const context = observerContext(machineId, shareId)
  if (publicKey.length !== 32 || !welcomeVerify(b64d(ownerPublicKey), context, ephemeral.pub,
    publicKey, b64d(String(welcome.signature)))) throw new Error('The shared harness identity could not be verified.')
  const keys = sessionKeys(ephemeral.priv, publicKey, context, ephemeral.pub, publicKey)
  return new ObserverCipher(keys.c2s, keys.s2c, context)
}
