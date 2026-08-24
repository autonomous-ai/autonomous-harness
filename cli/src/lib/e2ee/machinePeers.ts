/**
 * Persistence for the "this machine trusts machine X" relation — a third E2EE trust relation distinct
 * from browser↔this-machine (`E2eeStore`/`paired.json`). Established via `harness link create` (on the
 * peer) + `harness link import <token>` (here), never via the live 6-digit CPace code — see
 * relayClient.ts for the session this pin then bootstraps. Same file-permission conventions as
 * `E2eeStore`: ${ADAPTER_DATA_DIR}/e2e/, 0700 dir / 0600 file.
 *
 * Deliberately NOT cached in memory: `harness link import` runs as its own short-lived process,
 * independent of the daemon — the daemon's `RemoteRelayPool` must see a link the moment `link import`
 * writes it, not only after a restart. The file is tiny and read rarely (once per fresh relay dial),
 * so reading fresh every time costs nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../../config/env.js'
import { b64d, fingerprint } from './core.js'

const DIR = join(env.ADAPTER_DATA_DIR, 'e2e')
const FILE = join(DIR, 'machinePeers.json')

export interface MachinePeer {
  machineId: string
  pub: string // base64 Ed25519 pubkey of the peer machine's own identity
  label: string
  linkedAt: number
}

function readAll(): Map<string, MachinePeer> {
  const peers = new Map<string, MachinePeer>()
  try {
    const arr = JSON.parse(readFileSync(FILE, 'utf-8')) as MachinePeer[]
    for (const p of arr) {
      if (p?.machineId && p?.pub) peers.set(p.machineId, p)
    }
  } catch { /* none yet */ }
  return peers
}

function writeAll(peers: Map<string, MachinePeer>): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(FILE, JSON.stringify([...peers.values()], null, 2), { mode: 0o600 })
}

export class MachinePeerStore {
  get(machineId: string): MachinePeer | null {
    return readAll().get(machineId) ?? null
  }

  pin(machineId: string, pub: string, label: string, at = Date.now()): void {
    const peers = readAll()
    peers.set(machineId, { machineId, pub, label, linkedAt: at })
    writeAll(peers)
  }

  unlink(machineId: string): boolean {
    const peers = readAll()
    if (!peers.delete(machineId)) return false
    writeAll(peers)
    return true
  }

  list(): Array<MachinePeer & { fingerprint: string }> {
    return [...readAll().values()]
      .map((p) => ({ ...p, fingerprint: fingerprint(b64d(p.pub)) }))
      .sort((a, b) => b.linkedAt - a.linkedAt)
  }
}
