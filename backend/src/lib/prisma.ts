import { PrismaClient, type Prisma } from '@prisma/client'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'

// The Prisma CLI (db push) reads env("DATABASE_URL"); keep it in sync for any manual run.
process.env.DATABASE_URL ??= env.DATABASE_URL

export const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
})

/** "Not soft-deleted" filter for Machine findMany where-clauses. Mongo-Prisma gotcha: legacy
 *  rows have NO `deletedAt` field and `{deletedAt: null}` matches only an explicit null, so the
 *  filter must accept both null and absent. `findUnique` can't take this — post-check
 *  `binding.deletedAt` instead. */
export const machineAlive: Prisma.MachineWhereInput = { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] }

/* Second Mongo-Prisma gotcha, sibling of the one above: an atomic `{ increment: n }` on a document
 * that LACKS the field stores `null` (it is a pipeline `$add`, and missing + n = null), and stays
 * null on every later increment — no error, and reads still return the schema default. So a numeric
 * counter added to an existing collection needs a one-time raw `$set` backfill for legacy rows
 * before any code increments it (see lib/db/migrate.ts backfillMachinePresenceTurnsStarted). */

const gracefulShutdown = async () => {
  logger.info('Disconnecting Prisma client...')
  await prisma.$disconnect().catch(() => { /* ignore */ })
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)
