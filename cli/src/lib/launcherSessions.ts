/**
 * The live-machine book — the adapter's source of truth for session lifetime.
 *
 * Every `harness <engine>` launch mints a UUID and holds ONE WebSocket to the daemon for as long as it
 * runs. The socket IS the liveness signal:
 *
 *   an agent exists in the adapter  ⇔  its launcher's socket is open
 *
 * That is why nothing here is polled or persisted. It replaced two polling loops (the launcher probing
 * `GET /api/health` every 3s, and the daemon scanning `ps` for the launcher's pid every 5s), so a
 * disconnect in either direction is now noticed the moment the socket closes instead of up to 5s later.
 *
 * Not persisted on purpose: a daemon restart tears down every socket, and each surviving launcher
 * reconnects and re-announces itself within ~1s. Sessions loaded from `registry.json` at boot are given
 * a short reconnect grace (see cli.ts) before being dropped — that grace is what tells "the daemon just
 * self-updated" apart from "the launcher is gone".
 */

import type { AgentEngine } from '../engines/types.js'
import type { LauncherNoticeFrame } from './launcherProtocol.js'

/** Loopback path the `harness <engine>` launcher upgrades on (same port as the hook server). */
export const MACHINE_WS_PATH = '/api/machine-ws'

/** Only what this module needs from a socket — keeps it trivially testable without `ws`. */
export interface LauncherSocket {
  close(): void
  /** `ws.WebSocket.send`. The callback fires once the frame has left (or failed to leave) this process. */
  send(data: string, cb?: (err?: Error) => void): void
}

export interface LauncherSession {
  launcherId: string
  engine: AgentEngine
  tmuxPane: string
  cwd: string | null
  /** muse only: the data root this launcher's engine actually uses (see LauncherOpenFrame). */
  dataHome: string | null
  socket: LauncherSocket
  openedAt: number
}

export interface LauncherOpenInput {
  launcherId?: string
  engine?: AgentEngine
  tmuxPane?: string
  cwd?: string
  dataHome?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PANE_RE = /^%\d+$/

class LauncherSessionBook {
  private live = new Map<string, LauncherSession>()

  /**
   * Bind a launcher's socket to its machine id. Returns null when the payload is not a usable session.
   *
   * A re-`open` for an id we already hold (the launcher reconnecting after a daemon restart) REPLACES
   * the old entry and closes its stale socket, so a reconnect can never leave two sockets claiming the
   * same session.
   */
  open(input: LauncherOpenInput, socket: LauncherSocket): LauncherSession | null {
    const launcherId = input.launcherId ?? ''
    const pane = input.tmuxPane ?? ''
    if (!UUID_RE.test(launcherId) || !PANE_RE.test(pane) || !input.engine) return null
    const previous = this.live.get(launcherId)
    if (previous && previous.socket !== socket) {
      try { previous.socket.close() } catch { /* already gone */ }
    }
    const entry: LauncherSession = {
      launcherId,
      engine: input.engine,
      tmuxPane: pane,
      cwd: input.cwd ?? null,
      dataHome: typeof input.dataHome === 'string' && input.dataHome ? input.dataHome : null,
      socket,
      openedAt: previous?.openedAt ?? Date.now(),
    }
    this.live.set(launcherId, entry)
    return entry
  }

  close(launcherId: string): boolean {
    return this.live.delete(launcherId)
  }

  /**
   * Drop the session owned by a socket that just closed, returning its machine id (or null when the
   * socket had already been replaced by a reconnect — in that case the NEWER socket owns the id and
   * must not be evicted by the older one's close event).
   */
  closeBySocket(socket: LauncherSocket): string | null {
    for (const [id, s] of this.live) {
      if (s.socket === socket) { this.live.delete(id); return id }
    }
    return null
  }

  has(launcherId: string | undefined): boolean {
    return !!launcherId && this.live.has(launcherId)
  }

  get(launcherId: string): LauncherSession | undefined {
    return this.live.get(launcherId)
  }

  /**
   * The launcher currently holding a tmux pane, if any.
   *
   * Used to adopt a session nobody announced (a resumed agent): the engine's hook never fired, so the
   * only proof that this pane is a machine agent — and the only source of the launcherId that binds a
   * session to a lifetime — is the live launcher socket.
   */
  byPane(tmuxPane: string): LauncherSession | undefined {
    for (const s of this.live.values()) if (s.tmuxPane === tmuxPane) return s
    return undefined
  }

  list(): LauncherSession[] {
    return [...this.live.values()]
  }

  /**
   * Push one notice to every live launcher, and wait — briefly — for it to actually leave this process.
   *
   * The waiting is the point. The only caller so far is the update restart, which tears the daemon down
   * moments later; a fire-and-forget `send` there is a message that may never make it onto the wire. The
   * bound keeps that from turning into a stall: after `timeoutMs` we proceed regardless, because a stuck
   * socket must never be able to hold up a restart.
   *
   * Never throws, never rejects. A broken socket is one launcher missing one notice — it is not a reason
   * for whatever the caller was doing to fail.
   */
  async notifyAll(frame: LauncherNoticeFrame, timeoutMs = 300): Promise<void> {
    const payload = JSON.stringify(frame)
    const sends = [...this.live.values()].map((session) => new Promise<void>((resolve) => {
      try { session.socket.send(payload, () => resolve()) } catch { resolve() }
    }))
    if (!sends.length) return
    await Promise.race([
      Promise.all(sends).then(() => undefined),
      new Promise<void>((resolve) => { const t = setTimeout(resolve, timeoutMs); t.unref?.() }),
    ])
  }
}

export const launcherSessions = new LauncherSessionBook()
