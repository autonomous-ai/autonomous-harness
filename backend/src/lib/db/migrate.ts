import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { env } from '../../config/env.js'
import { logger } from '../../utils/logger.js'
import { prisma } from '../prisma.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// src/lib/db or dist/lib/db → package root
const root = join(__dirname, '..', '..', '..')

/**
 * Push the Prisma schema to MongoDB before serving. No migration files — `prisma db
 * push` creates the `users` + `agent_bindings` collections + indexes; idempotent. It
 * does NOT touch the manager-owned `agent_nodes`/`managers` collections (they aren't in
 * this schema), so the shared DB is safe.
 */
export function ensureSchema(): void {
  process.env.DATABASE_URL ??= env.DATABASE_URL

  const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js')
  if (!existsSync(prismaCli)) {
    logger.warn('prisma CLI not found — skipping db push', { prismaCli })
    return
  }

  const schema = join(root, 'prisma', 'schema.prisma')
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--schema', schema, '--skip-generate'], {
      stdio: 'inherit',
      env: process.env,
    })
    logger.info('Prisma db push ok (backend schema)')
  } catch (err) {
    logger.error('Prisma db push failed — continuing (collections may already exist)', err)
  }
}

type MongoIndex = { name?: string; key?: Record<string, number>; unique?: boolean }

async function dropLegacyUniqueIndex(collection: string, field: string): Promise<void> {
  try {
    const result = (await prisma.$runCommandRaw({ listIndexes: collection, cursor: {} })) as {
      cursor?: { firstBatch?: MongoIndex[] }
    }
    const index = result.cursor?.firstBatch?.find((candidate) =>
      candidate.unique === true &&
      candidate.key != null &&
      Object.keys(candidate.key).length === 1 &&
      candidate.key[field] === 1)
    if (!index?.name) return
    await prisma.$runCommandRaw({ dropIndexes: collection, index: index.name })
    logger.info('legacy environment-global unique index removed', { collection, index: index.name })
  } catch (err) {
    // NamespaceNotFound is expected on a cold database. Any real failure will also be retried on the
    // next worker boot, while ensureSchema logs whether the replacement indexes could be installed.
    logger.warn('legacy unique index cleanup skipped', { collection, field, error: String(err) })
  }
}

/**
 * Prepare the environment split before Prisma installs the new compound indexes. All rows that
 * predate the split belong to the formerly process-global staging plane. New rows are unaffected:
 * User defaults to prod and every dependent row copies its user/machine environment explicitly.
 */
export async function migrateAutonomousEnvironment(): Promise<void> {
  // This is deliberately not configurable: every row that predates the split was created while
  // staging was process-global. Runtime defaults are production only for records created later.
  const autonomousEnv = 'stag'
  const collections = [
    'users',
    'machines',
    'subscription_plans',
    'machine_checkout_attempts',
    'machine_free_entitlements',
  ]
  for (const collection of collections) {
    try {
      const result = (await prisma.$runCommandRaw({
        update: collection,
        updates: [{
          q: { autonomousEnv: { $exists: false } },
          u: { $set: { autonomousEnv } },
          multi: true,
        }],
      })) as { nModified?: number }
      if (result.nModified) {
        logger.info('Autonomous environment backfilled', { collection, autonomousEnv, modified: result.nModified })
      }
    } catch (err) {
      logger.warn('Autonomous environment backfill skipped', { collection, error: String(err) })
    }
  }

  // The old global constraints prevent storing the same plan name/free entitlement in both planes.
  // Drop only those exact single-field unique indexes; Prisma recreates the compound replacements.
  await dropLegacyUniqueIndex('subscription_plans', 'name')
  await dropLegacyUniqueIndex('machine_free_entitlements', 'userId')
}

const PENDING_EMAIL_SUFFIX = '@pending.harness.invalid'

function migrationEmail(email: string, externalId: string): string {
  const normalized = email.trim().toLowerCase()
  return normalized || `device-${externalId.trim().toLowerCase()}${PENDING_EMAIL_SUFFIX}`
}

/**
 * One-time identity split, before db push installs the unique email index:
 * - normalized email becomes the SSO identity;
 * - the old subject is moved to stagExternalId for staging users;
 * - externalId remains the unique production/device subject slot.
 */
export async function migrateUserIdentityByEmail(): Promise<void> {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      externalId: true,
      stagExternalId: true,
      autonomousEnv: true,
    },
  })

  const owners = new Map<string, string>()
  const prepared = users.map((user) => {
    const email = migrationEmail(user.email, user.externalId)
    const duplicate = owners.get(email)
    if (duplicate && duplicate !== user.id) {
      throw new Error(`Cannot migrate users to email identity: duplicate normalized email ${email}`)
    }
    owners.set(email, user.id)
    const staging = user.autonomousEnv === 'stag'
    return {
      user,
      email,
      externalId: staging && !user.stagExternalId ? `local-prod-${user.id}` : user.externalId,
      stagExternalId: staging ? (user.stagExternalId || user.externalId) : user.stagExternalId,
    }
  })

  for (const next of prepared) {
    const data = {
      ...(next.user.email !== next.email ? { email: next.email } : {}),
      ...(next.user.externalId !== next.externalId ? { externalId: next.externalId } : {}),
      ...(next.user.stagExternalId !== next.stagExternalId
        ? { stagExternalId: next.stagExternalId }
        : {}),
    }
    if (Object.keys(data).length) {
      await prisma.user.update({ where: { id: next.user.id }, data })
    }
  }

  if (prepared.length) {
    logger.info('user email identity migration complete', { users: prepared.length })
  }
}

/**
 * One-time (idempotent) backfill: legacy `machines` rows created before `authMode` was
 * denormalized get it stamped from their plan (no-planId rows → 'self'). Runs at boot on the
 * pushing instance, after ensureSchema/ensurePlans and BEFORE the server accepts connections, so
 * every read site can rely on `binding.authMode` alone (the plan is never consulted for authMode).
 * Raw `$exists: false` is required — Prisma-Mongo `where: { authMode: null }` does NOT match
 * documents where the field is absent.
 */
export async function backfillMachineAuthMode(): Promise<void> {
  try {
    const plans = await prisma.subscriptionPlan.findMany()
    const updates = plans.map((p) => ({
      q: { planId: p.id, authMode: { $exists: false } },
      u: { $set: { authMode: p.authMode } },
      multi: true,
    }))
    // Catch-all last: anything still missing (no/unknown planId) defaults to 'self'.
    updates.push({ q: { authMode: { $exists: false } } as never, u: { $set: { authMode: 'self' } }, multi: true })
    const res = (await prisma.$runCommandRaw({ update: 'machines', updates })) as { nModified?: number }
    if (res.nModified) logger.info('machines authMode backfilled', { modified: res.nModified })
  } catch (err) {
    logger.error('authMode backfill failed — continuing (legacy rows read as self until next boot)', err)
  }
}

/**
 * Drop every device row that predates computer-backed devices, and the pairing-code collection with it.
 *
 * `/api/device-ws` is SSO-only now: a row is resolved from `userId + autonomousEnv + computerId`, and the
 * device token that authenticated the old rows is not accepted anywhere. Nothing can ever connect as one
 * of them again, but left in place they would show forever in `GET /api/devices` and in the mobile
 * overview as permanently-offline devices the user cannot explain or get rid of.
 *
 * Raw `$exists: false` is required — Prisma-Mongo `where: { computerId: null }` does NOT match documents
 * where the field is absent, which is exactly the shape every legacy row has.
 */
export async function pruneLegacyDeviceBindings(): Promise<void> {
  try {
    const res = (await prisma.$runCommandRaw({
      delete: 'device_bindings',
      deletes: [{ q: { computerId: { $exists: false } }, limit: 0 }],
    } as never)) as { n?: number }
    if (res.n) logger.info('legacy device bindings pruned', { deleted: res.n })
    // `db push` drops the model's indexes but leaves the collection itself behind.
    await prisma.$runCommandRaw({ drop: 'pairing_codes' } as never).catch(() => {})
  } catch (err) {
    logger.error('legacy device binding prune failed — continuing (stale rows read as offline devices)', err)
  }
}

// ── Machine rename migration (one-time, idempotent) ────────────────────────────────────────────────
// The entity formerly called a "harness" is now a MACHINE. Renamed collections are COPIED (the old
// ones are kept as the rollback and cleaned up by hand later); collections that keep their name get
// an in-place field rename.
//
// Idempotency is a MARKER, deliberately not "is the target populated?" — the HTTP server is a
// cluster that boots independently of this worker, so it can write one fresh row into `machines`
// before the migration runs. A populated-target guard would then read that as "already migrated" and
// silently strand every legacy row. `$merge` matches on `_id`, so a concurrent new row is harmless.

type FieldRenames = Record<string, string>

async function count(coll: string, query: Record<string, unknown> = {}): Promise<number> {
  const r = (await prisma.$runCommandRaw({ count: coll, query } as never)) as { n?: number }
  return r.n ?? 0
}

/** Has this migration id already been applied? Missing `migrations` collection reads as "no". */
async function migrationApplied(id: string): Promise<boolean> {
  return (await count('migrations', { _id: id })) > 0
}

async function markMigrationApplied(id: string): Promise<void> {
  await prisma.$runCommandRaw({
    insert: 'migrations',
    documents: [{ _id: id, appliedAt: new Date().toISOString() }],
  } as never)
}

/** Copy `from` → `into`, applying `renames`. `$merge` (not `$out`) so the indexes `db push` just
 *  created survive — `$out` drops and recreates the namespace. `whenMatched:'fail'` turns a partial
 *  re-run into a loud error instead of silent duplication. */
async function copyRenamed(from: string, into: string, renames: FieldRenames): Promise<void> {
  const n = await count(from)
  if (n === 0) { logger.info('machine-rename: skip (source empty)', { from }); return }
  const added: Record<string, string> = {}
  for (const [oldName, newName] of Object.entries(renames)) added[newName] = `$${oldName}`
  const pipeline: Record<string, unknown>[] = [
    { $addFields: added },
    { $unset: Object.keys(renames) },
    { $merge: { into, whenMatched: 'fail' } },
  ]
  await prisma.$runCommandRaw({ aggregate: from, pipeline, cursor: {} } as never)
  logger.info('machine-rename: copied', { from, into, docs: n })
}

/** In-place field rename for a collection that keeps its name. One update per pair, each guarded on
 *  "old present AND new absent" so a re-run is a no-op and a half-applied run resumes. */
async function renameFieldsInPlace(coll: string, renames: FieldRenames): Promise<void> {
  let modified = 0
  for (const [oldName, newName] of Object.entries(renames)) {
    const res = (await prisma.$runCommandRaw({
      update: coll,
      updates: [{
        q: { [oldName]: { $exists: true }, [newName]: { $exists: false } },
        u: { $rename: { [oldName]: newName } },
        multi: true,
      }],
    } as never)) as { nModified?: number }
    modified += res.nModified ?? 0
  }
  if (modified) logger.info('machine-rename: fields renamed in place', { coll, modified })
}

const MACHINE_RENAME_ID = 'machine-rename-v1'

/** Run AFTER ensureSchema (db push created the new collections + their indexes), before serving. */
export async function migrateMachineRename(): Promise<void> {
  try {
    if (await migrationApplied(MACHINE_RENAME_ID)) return

    const idOnly: FieldRenames = { harnessId: 'machineId' }
    await copyRenamed('harness_bindings', 'machines', { harnessId: 'machineId', machineName: 'name' })
    await copyRenamed('harness_agents', 'machine_agents', idOnly)
    await copyRenamed('harness_free_entitlements', 'machine_free_entitlements', idOnly)
    await copyRenamed('harness_voice_daily_usage', 'machine_voice_daily_usage', idOnly)
    await copyRenamed('harness_voice_reservations', 'machine_voice_reservations', idOnly)
    await copyRenamed('harness_checkout_attempts', 'machine_checkout_attempts', idOnly)

    await renameFieldsInPlace('device_bindings', { harnessId: 'machineId', activeHarnessId: 'activeMachineId' })
    await renameFieldsInPlace('subdomains', idOnly)
    await renameFieldsInPlace('subscription_plans', { maxProjects: 'maxAgents' })

    // `harness_join_codes` is deliberately left alone — its model was deleted, and the collection is
    // the rollback copy. `Machine.hostname` is deliberately NOT backfilled: it is the connecting
    // computer's hostname and self-heals on the next adapter connect.
    await markMigrationApplied(MACHINE_RENAME_ID)
    logger.info('machine-rename: complete')
  } catch (err) {
    // Not marked → the next boot retries. Leaving the legacy collections in place is the rollback.
    logger.error('machine-rename migration failed — continuing (legacy data stays in harness_* collections)', err)
  }
}
