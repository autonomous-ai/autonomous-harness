/**
 * Backend-side "call the node and await its reply" — the server analogue of the web's
 * `wsClient.request`, over the hub. Used by device flows (deviceWs) that need a node result
 * synchronously (agent list/create/recent) without the old REST `/proxy` round-trip.
 *
 * Flow: publishDown a `{ type, payload:{ ...payload, requestId } }` frame → node handles it and replies
 * with an `<x>_result` up-frame (webEligible) → we match it on `up:{machineId}` by requestId. The reply
 * also fans out to any real web clients of the agent, which harmlessly ignore an unknown requestId.
 */
import { randomUUID } from 'crypto'
import { subscribeUp, publishDown } from './bus.js'
import { routeDown } from './providerLink.js'
import type { UpBusMsg } from './tunnel.js'

export function nodeRequest<T = unknown>(
  machineId: string,
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<T> {
  const requestId = randomUUID()
  return new Promise<T>((resolve, reject) => {
    let unsub: (() => void) | null = null
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      if (unsub) unsub()
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`node rpc timed out: ${type} (agent ${machineId})`))),
      timeoutMs,
    )
    subscribeUp(machineId, (msg: UpBusMsg) => {
      const f = msg.frame as { payload?: { requestId?: string; error?: unknown } }
      if (f?.payload?.requestId !== requestId) return
      finish(() =>
        f.payload!.error != null
          ? reject(new Error(String(f.payload!.error)))
          : resolve(f.payload as T),
      )
    })
      .then((u) => {
        if (done) { u(); return }
        unsub = u
        // Publish only AFTER the subscription is live, else a fast reply is missed.
        const down = { connId: '', frame: { type, payload: { ...payload, requestId } } }
        void routeDown(machineId, down, () => publishDown(machineId, down))
      })
      .catch((err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
  })
}
