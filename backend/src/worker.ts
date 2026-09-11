import 'dotenv/config'
import { closeBus } from './lib/bus.js'
import { backfillMachineFreeEntitlements } from './lib/db/freeEntitlement.js'
import {
  backfillMachineAuthMode,
  ensureSchema,
  migrateAutonomousEnvironment,
  migrateMachineRename,
  migrateUserIdentityByEmail,
  pruneLegacyDeviceBindings,
} from './lib/db/migrate.js'
import { ensurePlans } from './lib/db/seed.js'
import { prisma } from './lib/prisma.js'
import { machineBillingWorkerService } from './services/MachineBillingWorkerService.js'
import { logger } from './utils/logger.js'

// Singleton background process. HTTP/WS server.ts runs as a PM2 cluster and must never own schema
// writes, catalog syncs, migrations or periodic jobs; otherwise every live server worker races them.
async function start(): Promise<void> {
  // Existing production data was created against staging upstreams. Stamp it before Prisma swaps
  // the old global unique indexes for their per-environment replacements.
  await migrateAutonomousEnvironment()
  await migrateUserIdentityByEmail()
  ensureSchema()
  // AFTER the push: it creates the new collections + their unique indexes, and the copy uses $merge
  // so those indexes survive. Copying first would leave the unique index build to fail silently.
  await migrateMachineRename()
  // The copy can materialize rows from a collection the first pass never saw — stamp those too.
  await migrateAutonomousEnvironment()
  await ensurePlans()
  await backfillMachineAuthMode()
  await pruneLegacyDeviceBindings()
  await backfillMachineFreeEntitlements()

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, stopping backend worker...`)
    const hardExit = setTimeout(() => process.exit(0), 5000)
    hardExit.unref()
    machineBillingWorkerService.stop()
    void Promise.allSettled([prisma.$disconnect(), closeBus()]).finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  machineBillingWorkerService.start()
  // PM2 wait_ready gates the singleton worker's "online" state on schema/catalog/backfill startup.
  // Plain node/tsx runs do not provide process.send and simply continue.
  process.send?.('ready')
  logger.info('backend worker started')
}

start().catch((err) => {
  logger.error('Failed to start backend worker', err)
  process.exit(1)
})
