#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromBackend = createRequire(new URL('../package.json', import.meta.url))
const { PrismaClient } = requireFromBackend('@prisma/client')

const apiKey = process.env.LOCAL_TERMINAL_E2E_API_KEY ?? ''
if (!/^[a-f0-9]{64}$/.test(apiKey)) {
  console.error('LOCAL_TERMINAL_E2E_API_KEY must be exactly 64 lowercase hex characters')
  process.exit(64)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(64)
}

const machineId = createHash('sha256').update(apiKey).digest('hex').slice(0, 32)
const externalId = `local-terminal-e2e-${machineId}`
const email = `${externalId}@local.invalid`
const prisma = new PrismaClient()

try {
  const user = await prisma.user.upsert({
    where: { email },
    update: { externalId, autonomousEnv: 'prod' },
    create: { email, externalId, autonomousEnv: 'prod', name: 'Local terminal E2E' },
  })
  await prisma.machine.upsert({
    where: { machineId },
    update: {
      userId: user.id,
      apiKey,
      managerId: 'local-terminal-e2e',
      autonomousEnv: 'prod',
      authMode: 'remote',
      billingStatus: 'not_required',
      deletedAt: null,
      name: 'local-terminal-e2e',
    },
    create: {
      userId: user.id,
      machineId,
      apiKey,
      managerId: 'local-terminal-e2e',
      autonomousEnv: 'prod',
      authMode: 'remote',
      billingStatus: 'not_required',
      name: 'local-terminal-e2e',
    },
  })
  process.stdout.write(`${JSON.stringify({ machineId, machineName: 'local-terminal-e2e' })}\n`)
} finally {
  await prisma.$disconnect()
}
