import { closeSync, constants, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decodeFixed } from './crypto.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from '../secureState.js'

export interface LampRecord {
  id: string; identityPub: string; label: string; pairedAt: number; lastSeenAt: number | null
  enabled: true; pendingFirstSession: boolean
}
interface Stored { v: 1; paired: LampRecord | null; pending: LampRecord | null }
export class LampStore {
  private state: Stored = { v: 1, paired: null, pending: null }
  private readonly file: string
  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'e2e', 'lamps.json')
    this.secureDirectory()
    if (hardenPrivateStateFileIfPresent(this.file, 16_384)) {
      const raw = JSON.parse(readPrivateStateFile(this.file, 16_384)) as Stored
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1 || !('paired' in raw) || !('pending' in raw)) throw new Error('Invalid lamp trust store')
      for (const row of [raw.paired, raw.pending]) if (row !== null) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid lamp trust record')
        decodeFixed(row.identityPub, 32)
        if (row.id !== LampStore.id(row.identityPub) || typeof row.label !== 'string' || !Number.isFinite(row.pairedAt) || row.enabled !== true || typeof row.pendingFirstSession !== 'boolean' || (row.lastSeenAt !== null && !Number.isFinite(row.lastSeenAt))) throw new Error('Invalid lamp trust record')
      }
      this.state = raw
    }
    this.expire()
  }
  static id(pub: string): string { decodeFixed(pub, 32); return pub }
  private secureDirectory(): void {
    secureStateDirectory(this.dataDir)
    secureStateDirectory(join(this.dataDir, 'e2e'))
  }
  private write(next: Stored): void {
    this.secureDirectory()
    // Refuse preexisting symlinks, foreign ownership and writable-by-others state before replacement.
    hardenPrivateStateFileIfPresent(this.file, 16_384)
    const dir = join(this.dataDir, 'e2e'), temp = `${this.file}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, JSON.stringify(next))
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      renameSync(temp, this.file)
      const directory = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
      this.state = next
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }
  expire(now = Date.now()): void {
    if (this.state.pending && now - this.state.pending.pairedAt >= 5 * 60_000) this.write({ ...this.state, pending: null })
  }
  paired(): LampRecord | null { return this.state.paired ? { ...this.state.paired } : null }
  pending(): LampRecord | null { this.expire(); return this.state.pending ? { ...this.state.pending } : null }
  find(pub: string): LampRecord | null { return [this.paired(), this.pending()].find(r => r?.identityPub === pub) ?? null }
  stage(pub: string, label: string): LampRecord {
    decodeFixed(pub, 32)
    const row: LampRecord = { id: LampStore.id(pub), identityPub: pub, label, pairedAt: Date.now(), lastSeenAt: null, enabled: true, pendingFirstSession: true }
    this.write({ ...this.state, pending: row }); return row
  }
  confirm(pub: string): LampRecord {
    const row = this.find(pub)
    if (!row) throw new Error('Lamp is no longer trusted')
    const next = { ...row, pendingFirstSession: false, lastSeenAt: Date.now() }
    this.write({ v: 1, paired: next, pending: this.state.pending?.identityPub === pub ? null : this.state.pending })
    return next
  }
  clearPending(): void { if (this.state.pending) this.write({ ...this.state, pending: null }) }
  revoke(id: string): number {
    const paired = this.state.paired && (id === 'all' || id === this.state.paired.id) ? null : this.state.paired
    const pending = this.state.pending && (id === 'all' || id === this.state.pending.id) ? null : this.state.pending
    const count = Number(!!this.state.paired && !paired) + Number(!!this.state.pending && !pending)
    if (count) this.write({ v: 1, paired, pending })
    return count
  }
}
