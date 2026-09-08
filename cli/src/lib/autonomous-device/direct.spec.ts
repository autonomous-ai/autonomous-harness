import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { b64e, fingerprint, newIdentity } from '../e2ee/core.js'
import { AutonomousDeviceDirect, type DirectDeviceHost } from './direct.js'
const clean: Array<() => void> = []
afterEach(() => { for (const fn of clean.splice(0)) fn() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'autonomous-direct-')); clean.push(() => rmSync(dir, { recursive: true, force: true }))
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(wss, 'listening')
  clean.push(() => { for (const ws of wss.clients) ws.terminate(); wss.close() })
  const row = { id: 'device._autonomous._tcp.local', name: 'Device', host: '127.0.0.1', port: (wss.address() as { port: number }).port }
  const identity = newIdentity(), fp = fingerprint(identity.pub)
  let pending: string | null = null, authenticated: string | null = null, attempts = 0
  const receive = vi.fn(async (connId: string, frame: Record<string, unknown>) => { if (frame.type === 'e2e_pair_intent') pending = connId; if (frame.type === 'e2e_hello') authenticated = fp })
  const host: DirectDeviceHost = { machineId: 'machine', label: 'Mac', receive, attach: () => {}, detach: () => { pending = null; authenticated = null },
    pending: () => pending ? { pairId: 'pair', role: 'device' } : null, pendingConnection: () => pending,
    pair: async code => { attempts++; if (code === 'WRONG1') return { ok: false, error: 'CODE_MISMATCH' }; authenticated = fp; return { ok: true, label: 'Device', fingerprint: 'computer-fingerprint' } },
    authenticatedFingerprint: () => authenticated, pairedFingerprint: () => fp, paired: () => [{ role: 'device', fingerprint: fp }] }
  wss.on('connection', ws => ws.once('message', () => ws.send(JSON.stringify({ type: 'e2e_pair_intent', payload: {} }))))
  const discovery = vi.fn(async () => [row])
  const direct = new AutonomousDeviceDirect(host, dir, discovery); clean.unshift(() => direct.stop())
  return { direct, host, wss, row, identity, fp, receive, dir, discovery, attempts: () => attempts }
}
describe('direct Autonomous device endpoint selection', () => {
  it('only pairs a discovered selected device and starts a fresh socket after a wrong code', async () => {
    const f = await fixture()
    await expect(f.direct.pair('manual-host', 'CODE12')).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' })
    expect(f.attempts()).toBe(0)
    await expect(f.direct.pair(f.row.id, 'WRONG1')).rejects.toMatchObject({ code: 'CODE_MISMATCH' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await f.direct.pair(f.row.id, 'CODE12')).toMatchObject({ state: 'paired', fingerprint: f.fp })
    expect(f.attempts()).toBe(2)
    f.direct.revoked(f.fp)
    expect(f.direct.connected()).toBe(0)
  })
  it('does not persist success if PAKE identity has not authenticated its session', async () => {
    const f = await fixture()
    f.host.pair = async () => { for (const ws of f.wss.clients) ws.close(); return { ok: true, label: 'Device', fingerprint: 'computer' } }
    await expect(f.direct.pair(f.row.id, 'CODE12')).rejects.toThrow('session did not authenticate')
    expect(f.direct.connected()).toBe(0)
  })
  it('refuses a reconnect identity different from the saved discovered association', async () => {
    const f = await fixture(); await f.direct.pair(f.row.id, 'CODE12'); f.direct.stop()
    await new Promise(resolve => setTimeout(resolve, 20)); f.receive.mockClear()
    f.wss.removeAllListeners('connection')
    const impostor = b64e(newIdentity().pub)
    f.wss.on('connection', ws => ws.once('message', () => ws.send(JSON.stringify({ type: 'e2e_hello', payload: { identityPub: impostor } }))))
    const next = new AutonomousDeviceDirect(f.host, f.dir, f.discovery); clean.unshift(() => next.stop()); next.start()
    await vi.waitFor(() => expect(f.discovery).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(f.receive).not.toHaveBeenCalled()
  })
})
