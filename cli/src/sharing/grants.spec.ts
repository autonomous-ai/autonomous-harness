import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessGrantStore, inviteSchema } from './grants.js'

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-share-grants-')); roots.push(root)
  const path = join(root, 'permissions.json')
  let now = Date.now()
  const store = new HarnessGrantStore(path, () => now)
  const input = { machineId: 'machine', agentId: 'agent', recipientEmail: 'ken@example.test',
    name: 'CAD prototype', engine: 'codex', ownerPublicKey: 'public', expiresAt: new Date(now + 1000).toISOString() }
  return { store, path, input, advance: () => { now += 1001 } }
}
describe('durable harness sharing permissions', () => {
  it('normalizes emails and constrains invitation batches and expiry', () => {
    expect(inviteSchema.parse({ emails: ['  Ken@Example.Test '] })).toEqual({ emails: ['ken@example.test'], days: 30 })
    for (const invalid of [{ emails: [] }, { emails: ['bad'] }, { emails: ['a@example.test'], days: 365 },
      { emails: Array(21).fill('a@example.test') }]) expect(inviteSchema.safeParse(invalid).success).toBe(false)
  })
  it('persists private grants and admits only the matching recipient, machine and live grant', () => {
    const f = fixture(); expect(f.store.all()).toEqual([])
    const grant = f.store.invite(f.input)
    expect(statSync(f.path).mode & 0o777).toBe(0o600)
    expect(new HarnessGrantStore(f.path).list('machine', 'agent')).toEqual([grant])
    expect(f.store.active(grant.id, 'ken@example.test', 'machine')).toEqual(grant)
    expect(f.store.active(grant.id, 'diego@example.test', 'machine')).toBeNull()
    expect(f.store.active(grant.id, 'ken@example.test', 'another-machine')).toBeNull()
    expect(f.store.active('missing', 'ken@example.test', 'machine')).toBeNull()
    expect(f.store.list('machine', 'another-agent')).toEqual([])
    f.advance(); expect(f.store.active(grant.id, 'ken@example.test', 'machine')).toBeNull()
  })
  it('renews idempotently, isolates permissions, and durably revokes before sync', () => {
    const f = fixture(), ken = f.store.invite(f.input)
    const diego = f.store.invite({ ...f.input, recipientEmail: 'diego@example.test' })
    f.store.synced(ken.id); expect(f.store.all().find(g => g.id === ken.id)?.pending).toBe(false)
    const renewed = f.store.invite({ ...f.input, name: 'Renamed' })
    expect(renewed.id).toBe(ken.id); expect(f.store.all()).toHaveLength(2)
    expect(f.store.revoke(ken.id, 'another-machine', 'agent')).toBe(false)
    expect(f.store.revoke(ken.id, 'machine', 'another-agent')).toBe(false)
    expect(f.store.revoke(ken.id, 'machine', 'agent')).toBe(true)
    expect(f.store.active(ken.id, ken.recipientEmail, 'machine')).toBeNull()
    expect(new HarnessGrantStore(f.path).list('machine', 'agent')).toEqual([diego])
    expect(JSON.parse(readFileSync(f.path, 'utf8')).find((g: { id: string }) => g.id === ken.id)).toMatchObject({ revoked: true, pending: true })
    const copy = f.store.all(); copy[0].name = 'tampered'
    expect(f.store.all()[0].name).not.toBe('tampered')
  })
  it('fails closed on corrupt state instead of silently forgetting permissions', () => {
    const f = fixture(); writeFileSync(f.path, '{broken')
    expect(() => new HarnessGrantStore(f.path)).toThrow('permissions file could not be read')
  })
})
