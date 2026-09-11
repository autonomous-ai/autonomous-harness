import type { User } from '@prisma/client'
import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma.js'
import { ADMIN_EMAILS } from '../config/env.js'
import { hashPassword } from '../lib/password.js'
import { ConflictError, NotFoundError } from '../errors/index.js'
import type { AutonomousEnvironment } from '../lib/autonomousEnvironment.js'

export type PublicUser = Omit<User, 'passwordHash'>

function toPublic(u: User): PublicUser {
  const { passwordHash: _omit, ...rest } = u
  return rest
}

function roleForEmail(email: string): string {
  return ADMIN_EMAILS.has(email.toLowerCase()) ? 'admin' : 'user'
}

const PROVISIONAL_EMAIL_DOMAIN = 'pending.harness.invalid'

export function normalizeUserEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function provisionalEmailForExternalId(externalId: string): string {
  return `device-${externalId.trim().toLowerCase()}@${PROVISIONAL_EMAIL_DOMAIN}`
}

export function isProvisionalUserEmail(email: string): boolean {
  return normalizeUserEmail(email).endsWith(`@${PROVISIONAL_EMAIL_DOMAIN}`)
}

interface SsoUserInput {
  externalId: string
  email: string
  autonomousEnv: AutonomousEnvironment
  name?: string
  roles?: string[]
}

async function mergeProdProvisionalUser(provisional: User, user: User): Promise<void> {
  if (provisional.id === user.id) return
  if (!isProvisionalUserEmail(provisional.email)) {
    throw new Error('Production SSO subject is already assigned to another user')
  }
  await prisma.$transaction([
    prisma.deviceBinding.updateMany({
      where: { userId: provisional.id },
      data: { userId: user.id },
    }),
    prisma.user.delete({ where: { id: provisional.id } }),
  ])
}

export const userService = {
  toPublic,

  /** Production subject lookup used by the prod-only SDS device plane. */
  findByExternal(externalId: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { externalId } })
  },

  /** SSO identity lookup. All callers must normalize through this boundary. */
  findByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email: normalizeUserEmail(email) } })
  },

  /**
   * Mirror an authenticated SSO profile. Email is the account identity; the selected environment
   * decides which SSO subject field is refreshed. Production additionally claims a device-created
   * provisional row whose externalId already equals the authenticated subject.
   */
  async upsertFromSso(input: SsoUserInput): Promise<User> {
    const externalId = input.externalId.trim()
    const em = normalizeUserEmail(input.email)
    if (!externalId || !em) throw new Error('SSO profile is missing its subject or email')
    const wantAdmin = input.roles?.includes('admin') || ADMIN_EMAILS.has(em)
    let existing = await prisma.user.findUnique({ where: { email: em } })

    if (!existing && input.autonomousEnv === 'prod') {
      const byExternal = await prisma.user.findUnique({ where: { externalId } })
      if (byExternal && isProvisionalUserEmail(byExternal.email)) existing = byExternal
    }

    if (existing) {
      if (input.autonomousEnv === 'prod' && existing.externalId !== externalId) {
        const currentOwner = await prisma.user.findUnique({ where: { externalId } })
        if (currentOwner && currentOwner.id !== existing.id) {
          await mergeProdProvisionalUser(currentOwner, existing)
        }
      }
      const role = existing.role === 'admin' || wantAdmin ? 'admin' : 'user'
      const data = {
        ...(existing.email !== em ? { email: em } : {}),
        ...(input.name && existing.name !== input.name ? { name: input.name } : {}),
        ...(existing.role !== role ? { role } : {}),
        ...(input.autonomousEnv === 'prod' && existing.externalId !== externalId ? { externalId } : {}),
        ...(input.autonomousEnv === 'stag' && existing.stagExternalId !== externalId
          ? { stagExternalId: externalId }
          : {}),
      }
      // SSO profile auth runs on every control-plane request. Avoid turning that validation into a
      // write-per-request DB hot path when the mirrored user record is already current.
      if (Object.keys(data).length === 0) return existing
      return prisma.user.update({
        where: { id: existing.id },
        data,
      })
    }

    const data = {
      email: em,
      externalId: input.autonomousEnv === 'prod' ? externalId : `local-prod-${randomUUID()}`,
      ...(input.autonomousEnv === 'stag' ? { stagExternalId: externalId } : {}),
      name: input.name,
      role: wantAdmin ? 'admin' : 'user',
      autonomousEnv: input.autonomousEnv,
    }
    try {
      return await prisma.user.create({ data })
    } catch (err) {
      // REST and web-ws validate the same fresh token concurrently. Unique email/prod-subject indexes
      // elect one creator; the loser re-reads and applies the same idempotent mirror update.
      const racedByEmail = await prisma.user.findUnique({ where: { email: em } })
      if (racedByEmail) return this.upsertFromSso(input)
      if (input.autonomousEnv === 'prod') {
        const racedByExternal = await prisma.user.findUnique({ where: { externalId } })
        if (racedByExternal && isProvisionalUserEmail(racedByExternal.email)) {
          return this.upsertFromSso(input)
        }
        if (racedByExternal) {
          throw new Error('Production SSO subject is already assigned to another email')
        }
      }
      throw err
    }
  },

  /**
   * Resolve the authoritative identity pair returned by the campaign device API before the owner has
   * necessarily signed in to Machine. Reuse the same email-keyed merge path as production SSO so a later
   * sign-in claims this exact row instead of creating a second user.
   */
  async findOrCreateProdDeviceOwner(externalId: string, email: string): Promise<User> {
    return this.upsertFromSso({
      externalId,
      email,
      autonomousEnv: 'prod',
    })
  },

  /** Prod-only device ownership: create a claimable user before its first SSO login. */
  async findOrCreateProdProvisional(externalId: string): Promise<User> {
    const subject = externalId.trim()
    const existing = await prisma.user.findUnique({ where: { externalId: subject } })
    if (existing) return existing
    try {
      return await prisma.user.create({
        data: {
          externalId: subject,
          email: provisionalEmailForExternalId(subject),
          role: 'user',
          autonomousEnv: 'prod',
        },
      })
    } catch (err) {
      const raced = await prisma.user.findUnique({ where: { externalId: subject } })
      if (raced) return raced
      throw err
    }
  },

  get(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } })
  },

  list(): Promise<User[]> {
    return prisma.user.findMany({ orderBy: { createdAt: 'desc' } })
  },

  async create(input: { email: string; password: string; name?: string; role?: string; autonomousEnv?: AutonomousEnvironment }): Promise<User> {
    const email = normalizeUserEmail(input.email)
    if (await prisma.user.findUnique({ where: { email } })) {
      throw new ConflictError('Email already exists')
    }
    return prisma.user.create({
      data: {
        // Locally-created (non-SSO) accounts still need the identity key. Mint a namespaced one so it
        // can never collide with an Autonomous SSO subject, and so two of them can coexist (a MISSING
        // field would collide on Mongo's unique index — absent counts as a value there).
        externalId: `local-${randomUUID()}`,
        email,
        passwordHash: hashPassword(input.password),
        name: input.name,
        role: input.role ?? roleForEmail(email),
        autonomousEnv: input.autonomousEnv ?? 'prod',
      },
    })
  },

  async update(id: string, input: { name?: string; password?: string; role?: string; autonomousEnv?: AutonomousEnvironment }): Promise<User> {
    if (!(await prisma.user.findUnique({ where: { id } }))) throw new NotFoundError('User')
    return prisma.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.autonomousEnv !== undefined ? { autonomousEnv: input.autonomousEnv } : {}),
        ...(input.password ? { passwordHash: hashPassword(input.password) } : {}),
      },
    })
  },

  async remove(id: string): Promise<void> {
    if (!(await prisma.user.findUnique({ where: { id } }))) throw new NotFoundError('User')
    await prisma.user.delete({ where: { id } })
  },
}
