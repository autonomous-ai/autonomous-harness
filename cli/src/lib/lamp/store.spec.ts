import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { b64e, newIdentity } from '../e2ee/core.js'
import { LampStore } from './store.js'
const dirs: string[] = []
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'lamp-store-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('lamp durable private trust', () => {
  it('preserves an incumbent until a candidate confirms and expires pending across restart', () => {
    const dir = fixture(), store = new LampStore(dir), old = b64e(newIdentity().pub), next = b64e(newIdentity().pub)
    store.stage(old, 'Old'); store.confirm(old); store.stage(next, 'Next')
    const restored = new LampStore(dir)
    expect(restored.paired()?.id).toBe(old); expect(restored.pending()?.id).toBe(next)
    restored.expire(Date.now() + 300_001)
    expect(new LampStore(dir).pending()).toBeNull(); expect(new LampStore(dir).paired()?.id).toBe(old)
    expect(statSync(join(dir, 'e2e', 'lamps.json')).mode & 0o777).toBe(0o600)
  })
  it('refuses a symlink trust file without modifying the target', () => {
    const dir = fixture(); new LampStore(dir)
    const target = join(dir, 'target'); writeFileSync(target, 'do not change', { mode: 0o600 })
    symlinkSync(target, join(dir, 'e2e', 'lamps.json'))
    expect(() => new LampStore(dir)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('do not change')
  })
  it('refuses a symlink directory and group-writable existing state', () => {
    const dir = fixture(), target = fixture()
    symlinkSync(target, join(dir, 'e2e'))
    expect(() => new LampStore(dir)).toThrow()
    rmSync(join(dir, 'e2e')); mkdirSync(join(dir, 'e2e'), { mode: 0o700 })
    chmodSync(join(dir, 'e2e'), 0o770)
    expect(() => new LampStore(dir)).toThrow(/writable/)
  })
  it('refuses an unsafe replacement target on an existing loaded store', () => {
    const dir = fixture(), store = new LampStore(dir), pub = b64e(newIdentity().pub)
    store.stage(pub, 'Lamp'); chmodSync(join(dir, 'e2e', 'lamps.json'), 0o666)
    expect(() => store.confirm(pub)).toThrow(/writable/)
    expect(store.paired()).toBeNull()
  })
})
