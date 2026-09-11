/**
 * Provisioning RPC over the manager socket (Phase 3) — replaces the backend→manager control HTTP
 * (`lib/manager.ts` create/destroy), so the backend no longer needs `Manager.publicHost`.
 *
 * Flow (works across backend instances behind a LB): the requesting backend publishes the command to
 * `mgr:{managerId}` and waits on `mgrreply:{requestId}`. Whichever backend holds a socket to that
 * manager (subscribed in managerWs) forwards it over the socket; the manager runs it and replies, which
 * that backend republishes to `mgrreply:{requestId}`. The manager op is idempotent on machineId, so if
 * multiple cluster sockets forward it, the duplicate simply errors and the first reply wins.
 */
import { randomUUID } from 'crypto'
import { publishMgr, subscribeReply } from './bus.js'

const PROVISION_TIMEOUT_MS = 60_000

/** No reply arrived before the deadline — the manager op's outcome is UNKNOWN (it may still be
 *  running / the container may still come up). Callers that fire-and-forget a `create` use this to
 *  avoid rolling back a binding whose container might yet register. A definitive failure (manager
 *  replied `ok:false`) rejects with a plain Error instead. */
export class ProvisionTimeoutError extends Error {
  readonly code = 'TIMEOUT' as const
  constructor(message: string) {
    super(message)
    this.name = 'ProvisionTimeoutError'
  }
}

export function provisionViaManager(
  managerId: string,
  cmd: 'create' | 'start' | 'stop' | 'destroy' | 'app_create' | 'app_delete',
  payload: Record<string, unknown>,
): Promise<unknown> {
  const requestId = randomUUID()
  return new Promise<unknown>((resolve, reject) => {
    let done = false
    let unsub: (() => void) | null = null
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      if (unsub) unsub()
      clearTimeout(timer)
      fn()
    }
    // Cold-start can include Docker boot + agent health + restoring a deployed app port.
    const timeoutMs = cmd === 'start' ? 125_000 : PROVISION_TIMEOUT_MS
    const timer = setTimeout(
      () => finish(() => reject(new ProvisionTimeoutError(`provision ${cmd} timed out (manager ${managerId} unreachable)`))),
      timeoutMs,
    )
    void subscribeReply(requestId, (msg) => {
      const r = msg as { ok?: boolean; data?: unknown; error?: string }
      finish(() => (r?.ok ? resolve(r.data) : reject(new Error(r?.error || 'provision failed'))))
    })
      .then((u) => {
        if (done) { u(); return }
        unsub = u
        void publishMgr(managerId, { requestId, cmd, payload })
          .catch((err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
      })
      .catch((err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
  })
}
