import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const emailSchema = z.string().trim().toLowerCase().email().max(254)
export const inviteSchema = z.object({
  emails: z.array(emailSchema).min(1).max(20),
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
})
const grantSchema = z.object({
  id: z.string().uuid(), machineId: z.string().min(1), agentId: z.string().min(1),
  recipientEmail: emailSchema, name: z.string(), engine: z.string().nullable(),
  ownerPublicKey: z.string(), expiresAt: z.string().datetime(), createdAt: z.string().datetime(),
  revoked: z.boolean().default(false), pending: z.boolean().default(false),
  publicationError: z.string().nullable().default(null),
})
export type HarnessGrant = z.infer<typeof grantSchema>

/** Durable owner-side authority. Revocation is saved before it can close observers or call a relay. */
export class HarnessGrantStore {
  private grants: HarnessGrant[]
  constructor(private readonly path: string, private readonly now = () => Date.now()) {
    try { this.grants = z.array(grantSchema).parse(JSON.parse(readFileSync(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The harness sharing permissions file could not be read.')
      this.grants = []
    }
  }
  private save(next: HarnessGrant[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.path)
    this.grants = next
  }
  all(): HarnessGrant[] { return this.grants.map(g => ({ ...g })) }
  active(id: string, email: string, machineId: string): HarnessGrant | null {
    const grant = this.grants.find(g => g.id === id && g.machineId === machineId
      && g.recipientEmail === email && !g.revoked && !g.publicationError && Date.parse(g.expiresAt) > this.now())
    return grant ? { ...grant } : null
  }
  list(machineId: string, agentId: string): HarnessGrant[] {
    return this.all().filter(g => g.machineId === machineId && g.agentId === agentId && !g.revoked)
  }
  invite(input: Omit<HarnessGrant, 'id' | 'createdAt' | 'pending' | 'revoked' | 'publicationError'>): HarnessGrant {
    const previous = this.grants.find(g => g.machineId === input.machineId && g.agentId === input.agentId
      && g.recipientEmail === input.recipientEmail)
    const grant = grantSchema.parse({ ...input, id: previous?.id ?? randomUUID(),
      createdAt: previous?.createdAt ?? new Date(this.now()).toISOString(), pending: true, revoked: false, publicationError: null })
    this.save([...this.grants.filter(g => g.id !== grant.id), grant])
    return { ...grant }
  }
  synced(id: string): void {
    this.save(this.grants.map(g => g.id === id ? { ...g, pending: false } : g))
  }
  failed(id: string, publicationError: string): void {
    this.save(this.grants.map(g => g.id === id ? { ...g, pending: false, publicationError } : g))
  }
  revoke(id: string, machineId: string, agentId: string): boolean {
    const found = this.grants.some(g => g.id === id && g.machineId === machineId && g.agentId === agentId)
    if (found) this.save(this.grants.map(g => g.id === id ? { ...g, revoked: true, pending: true } : g))
    return found
  }
}
