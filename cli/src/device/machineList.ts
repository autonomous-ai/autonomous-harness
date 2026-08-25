// The owner's machines, and which of them is this computer.
//
// A REST read, not a socket subscription — and that is the point. `GET /api/machines` is already proxied
// by this daemon with its own SSO session (cli.ts `proxyBackend`), which is exactly what the desktop app
// consumes; reusing it means the dial's wheel and the app's machine list cannot disagree, and it means the
// wheel exists before any lane to another machine does.
//
// The cache is SYNCHRONOUS to read. The cable session ticks every second and must never await a network
// call to decide whether to redraw a list that has not changed.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { env } from '../config/env.js'
import type { FleetMachine } from '../cable/machineFleet.js'

/** What `GET /api/machines` returns per row (MachineService.toOwner). Only the fields the dial uses. */
interface OwnerMachine {
  machineId?: unknown
  computerId?: unknown
  name?: unknown
  hostname?: unknown
  status?: unknown
  authMode?: unknown
}

/** A fleet row plus the flag the wheel needs; `local` is derived here and nowhere else. */
export type ListedMachine = FleetMachine & { local: boolean }

/**
 * Compare two computer ids the way the backend stores them.
 *
 * BOTH sides must be normalized and it is not defensive padding: this CLI mints a dashed `randomUUID()`
 * while the backend de-dashes and lowercases before storing, so a raw `===` never matches and every
 * machine — including this computer's own — reads as remote.
 */
export function sameComputer(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase().replace(/-/g, '')
  const na = norm(a)
  return na.length > 0 && na === norm(b)
}

export type MachineSource = 'backend' | 'local' | 'signed-out'

function stateOf(status: string): FleetMachine['state'] {
  // `toOwner.status` is resolved live for computer-backed machines (`applyRemoteStatus`), so it is a real
  // presence signal for exactly the machines where presence is a question.
  if (status === 'running') return 'ready'
  if (status === 'stopped' || status === 'offline') return 'offline'
  return 'unknown'
}

export class MachineListCache {
  private machines: ListedMachine[] = []
  private source: MachineSource = 'local'
  private readonly path: string

  constructor(
    private readonly fetchMachines: () => Promise<{ status: number; body: Record<string, unknown> }>,
    private readonly localComputerId: () => string,
    private readonly log: (line: string) => void,
    dataDir = env.ADAPTER_DATA_DIR,
  ) {
    this.path = join(dataDir, 'machines.json')
    this.loadCache()
  }

  /** Synchronous by contract — see the file header. */
  list(): { machines: ListedMachine[]; source: MachineSource } {
    return { machines: this.machines, source: this.source }
  }

  find(machineId: string): ListedMachine | undefined {
    return this.machines.find((m) => m.machineId === machineId)
  }

  /**
   * Re-read the list.
   *
   * Never throws. A daemon that cannot reach the backend still has one machine that works perfectly — the
   * one on the other end of the cable — so an outage downgrades `source` and keeps the last known rows
   * rather than emptying the wheel.
   */
  async refresh(): Promise<void> {
    let res: { status: number; body: Record<string, unknown> }
    try {
      res = await this.fetchMachines()
    } catch (err) {
      this.degrade(`unreachable (${(err as Error).message})`)
      return
    }
    if (res.status === 401 || res.status === 403) { this.signedOut(); return }
    if (res.status >= 400) { this.degrade(`HTTP ${res.status}`); return }

    const raw = (res.body?.machines ?? (res.body?.data as Record<string, unknown> | undefined)?.machines) as unknown
    if (!Array.isArray(raw)) { this.degrade('no machines in the response'); return }

    const mine = this.localComputerId()
    this.machines = raw.map((r) => this.toListed(r as OwnerMachine, mine)).filter((m) => m.machineId)
    this.source = 'backend'
    this.saveCache()
  }

  private toListed(r: OwnerMachine, mine: string): ListedMachine {
    const machineId = typeof r.machineId === 'string' ? r.machineId : ''
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim()
      : typeof r.hostname === 'string' && r.hostname.trim() ? r.hostname.trim()
        : `machine-${machineId.slice(0, 6)}`
    const authMode = r.authMode === 'managed' || r.authMode === 'remote' || r.authMode === 'provider' ? r.authMode : 'self'
    return {
      machineId,
      name,
      state: stateOf(typeof r.status === 'string' ? r.status : ''),
      authMode,
      // Derived, never declared — the same rule the desktop app follows.
      local: sameComputer(typeof r.computerId === 'string' ? r.computerId : '', mine),
    }
  }

  /**
   * Overlay live presence from a `machines_status` frame.
   *
   * The REST list is a SNAPSHOT — it is re-read on a timer, so on its own a machine that just came up
   * stays grey for up to a minute. This is the stream that fixes that, and it is why the socket is worth
   * holding while the dial is plugged in.
   *
   * Presence only: the name, the auth mode and which row is local all keep coming from REST, which is the
   * source that knows them. Returns true when something actually changed, so the caller can push a wheel
   * that differs and stay silent about one that does not.
   */
  applyLive(rows: Array<{ machineId?: unknown; online?: unknown }>): boolean {
    let changed = false
    let unknown = false
    for (const r of rows) {
      const id = typeof r.machineId === 'string' ? r.machineId : ''
      if (!id) continue
      const row = this.machines.find((m) => m.machineId === id)
      if (!row) { unknown = true; continue }
      const next = r.online === true ? 'ready' : 'offline'
      if (row.state !== next) { row.state = next; changed = true }
    }
    // A machine nobody has heard of means the account gained one since the last read. Go and find out
    // what it is called rather than inventing a row from a presence frame.
    if (unknown) void this.refresh()
    return changed
  }

  /** The list is stale but not wrong: keep the rows, stop claiming they are live. */
  private degrade(why: string): void {
    if (this.source !== 'local') this.log(`machines: ${why} — showing the last known list`)
    this.source = 'local'
    for (const m of this.machines) m.state = 'unknown'
  }

  private signedOut(): void {
    if (this.source !== 'signed-out') this.log('machines: not signed in')
    this.source = 'signed-out'
    this.machines = []
  }

  /** So a daemon that starts offline still draws the list the user saw last time. */
  private loadCache(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { machines?: ListedMachine[] }
      if (Array.isArray(parsed.machines)) {
        this.machines = parsed.machines.map((m) => ({ ...m, state: 'unknown' as const }))
      }
    } catch { /* no cache yet, or unreadable — an empty wheel plus the local row is correct */ }
  }

  private saveCache(): void {
    try { writeFileSync(this.path, JSON.stringify({ machines: this.machines }), { mode: 0o600 }) } catch { /* best effort */ }
  }
}
