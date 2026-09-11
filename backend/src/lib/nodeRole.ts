/**
 * The NODE ROLE, shared by every backer of a machine.
 *
 * A machine needs exactly one thing on the far side of its `machineId`: something that consumes
 * `down:{machineId}` and publishes back up. Three things play that part —
 *
 *   - `agent-manager`, for a docker agent-node   (`managerWs.ts`, multiplexed, dials in)
 *   - `machine-adapter`, for the user's own machine (`adapterWs.ts`, one socket, dials in)
 *   - `providerLink`,  for a third-party provider endpoint (dials OUT over HTTP+SSE)
 *
 * Everything they share lives here: the down subscription with its two control-frame intercepts, the
 * presence key and its refresh, the `__clients` recompute, and the `node_status` transitions. What
 * differs — how a frame actually reaches the backer, and how the backer is torn down — arrives as
 * callbacks, because that is the only part that is genuinely transport-specific.
 *
 * Extracted from `adapterWs.ts` so `providerLink` does not become a second copy of it.
 */
import {
  clearAgentPresence,
  publishUp,
  setAgentPresence,
  subscribeDown,
} from './bus.js'
import { CLIENTS_DIRTY, recomputeAndSendClients } from './hub.js'
import { REMOTE_BILLING_SUSPENDED_FRAME } from './billingState.js'
import type { DownBusMsg } from './tunnel.js'

/** Presence TTL, refreshed on the backer's own heartbeat. Mirrors the manager cadence. */
export const PRESENCE_TTL_SEC = 30
export const PRESENCE_REFRESH_MS = 15_000

/** Written into `agent:{machineId}:mgr`; tells reads which kind of backer is holding the machine. */
export type NodeRoleOwner = 'remote' | 'provider'

export interface NodeRoleOptions {
  machineId: string
  owner: NodeRoleOwner
  /**
   * Deliver a client frame to the backer. Control frames never reach this — they are handled here.
   * Returning nothing is fine; a dead transport should simply drop.
   */
  deliver: (msg: DownBusMsg) => void
  /**
   * Billing suspended this machine mid-session. A socket-backed role closes the socket; a
   * request-based one has nothing to close and marks itself instead.
   */
  onBillingSuspended: () => void
  /** Extra work on each presence refresh — the adapter renews its one-machine claim here. */
  onHeartbeat?: () => void
  /** Reason attached to the offline `node_status` when the role detaches. */
  offlineReason: string
}

export interface NodeRoleHandle {
  /** Refresh presence now — call from an application-level ping. */
  touch: () => void
  /** Release the down subscription, stop the timer, and mark the machine offline. */
  detach: () => Promise<void>
}

/**
 * Take the node role for one machine.
 *
 * `node_status { online: true }` goes out to web AND device: the device shows an "Offline" badge in
 * place of "Reconnecting…" when its backer is down, so it needs the transitions just as the web does.
 */
export async function attachNodeRole(opts: NodeRoleOptions): Promise<NodeRoleHandle> {
  const { machineId, owner } = opts

  const unsub = await subscribeDown(machineId, (msg: DownBusMsg) => {
    const type = (msg.frame as { type?: string })?.type

    // A client (re)joining pokes B_m to recompute cross-instance client counts. For a machine whose
    // backer is attached HERE, this endpoint *is* B_m — play the part: recompute and emit the summed
    // `__clients` frame. Never forward the poke itself.
    if (type === CLIENTS_DIRTY) {
      void recomputeAndSendClients(machineId)
      return
    }
    if (type === REMOTE_BILLING_SUSPENDED_FRAME) {
      opts.onBillingSuspended()
      return
    }
    opts.deliver(msg)
  })

  await setAgentPresence(machineId, owner, PRESENCE_TTL_SEC)
  void publishUp(machineId, {
    webEligible: true,
    commanderEligible: true,
    frame: { type: 'node_status', payload: { online: true } },
  })
  // Learn the current client counts on attach — a device may already be waiting, and the backer
  // needs them to replay live state to it.
  void recomputeAndSendClients(machineId)

  const timer = setInterval(() => {
    void setAgentPresence(machineId, owner, PRESENCE_TTL_SEC)
    opts.onHeartbeat?.()
    // Periodic B_m resync: re-emit the summed `__clients` so a client-instance crash (its fields
    // expire with no attach/detach poke) or a lost frame converges, instead of leaving the backer on
    // a ghost count. The value is absolute, so re-sending is idempotent.
    void recomputeAndSendClients(machineId)
  }, PRESENCE_REFRESH_MS)

  let detached = false
  return {
    touch: () => {
      void setAgentPresence(machineId, owner, PRESENCE_TTL_SEC)
      opts.onHeartbeat?.()
    },
    detach: async () => {
      if (detached) return
      detached = true
      clearInterval(timer)
      await unsub()
      await clearAgentPresence(machineId)
      void publishUp(machineId, {
        webEligible: true,
        commanderEligible: true,
        frame: { type: 'node_status', payload: { online: false, reason: opts.offlineReason } },
      })
    },
  }
}
