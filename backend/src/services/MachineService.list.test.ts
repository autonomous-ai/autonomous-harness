/**
 * The soft-delete filter on the machine list.
 *
 * This is the one line standing between a deleted machine and an app-store binary: `/api/mobile/v1/overview`
 * builds its whole machine list from `machineService.listForUser` (routes/mobile.ts), and the mobile route's
 * own test mocks that call away — so nothing else in the suite proves a deleted machine cannot reach it.
 *
 * `prisma.machine.findMany` is mocked to genuinely EVALUATE the where-clause with Mongo semantics rather
 * than echo it back, because the bug this guards against is exactly the semantic Prisma+Mongo gets wrong:
 * a MISSING field is not null, so `{deletedAt: null}` alone silently drops every legacy row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.hoisted(() => vi.fn())
const groupBy = vi.hoisted(() => vi.fn())
const planFindMany = vi.hoisted(() => vi.fn())
const runCommandRaw = vi.hoisted(() => vi.fn())
const getAgentPresence = vi.hoisted(() => vi.fn())

vi.mock('../lib/prisma.js', () => ({
  // The REAL helper — the thing under test is whether listForUser applies it, so stubbing it would
  // test the stub.
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
  prisma: {
    machine: { findMany },
    machineAgent: { groupBy },
    subscriptionPlan: { findMany: planFindMany },
    $runCommandRaw: runCommandRaw,
  },
}))
vi.mock('../lib/bus.js', () => ({
  getAgentPresence,
  clearAgentPresence: vi.fn(),
  publishDown: vi.fn(),
  publishDeviceMachineListChanged: vi.fn(),
}))
vi.mock('../config/env.js', () => ({ env: { HARNESS_BILLING_ENABLED: true, HARNESS_CAMPAIGN_CODE: 'ai-harness-device' } }))
vi.mock('../lib/managers.js', () => ({ selectManagerId: vi.fn() }))
vi.mock('../lib/provision.js', () => ({ provisionViaManager: vi.fn() }))
vi.mock('../lib/machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(), publishMachineLifecycle: vi.fn() }))
vi.mock('../lib/machineCredential.js', () => ({ encryptMachineCredential: vi.fn() }))
vi.mock('./MachineBillingService.js', () => ({ machineBillingService: {} }))

const { machineService } = await import('./MachineService.js')

type Row = Record<string, unknown>
type Where = Record<string, unknown>

/**
 * Mongo matching semantics, deliberately faithful on the one point that matters: an ABSENT key is not
 * null. `{deletedAt: null}` matches an explicit null only — which is why `machineAlive` is an OR.
 */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((c) => matches(row, c))
    if (key === 'AND') return (cond as Where[]).every((c) => matches(row, c))
    const present = key in row
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>
      if ('isSet' in c) return c.isSet === present
      if ('in' in c) return present && (c.in as unknown[]).includes(row[key])
    }
    if (cond === null) return present && row[key] === null
    return present && row[key] === cond
  })
}

const base = { authMode: 'self', billingStatus: 'active', planId: null, createdAt: new Date('2026-01-01') }

/** One of each shape a real collection holds after years of schema drift. */
const ROWS: Row[] = [
  // Legacy: the field was never written. This is the row `{deletedAt: null}` alone would lose.
  { ...base, machineId: 'legacy', userId: 'u1' },
  { ...base, machineId: 'explicit-null', userId: 'u1', deletedAt: null },
  { ...base, machineId: 'deleted', userId: 'u1', deletedAt: new Date('2026-08-01') },
  { ...base, machineId: 'someone-else', userId: 'u2' },
]

beforeEach(() => {
  vi.clearAllMocks()
  findMany.mockImplementation(async ({ where }: { where: Where }) => ROWS.filter((r) => matches(r, where)))
  groupBy.mockResolvedValue([])
  planFindMany.mockResolvedValue([])
  runCommandRaw.mockResolvedValue({ cursor: { firstBatch: [] } })
  getAgentPresence.mockResolvedValue(null)
})

const listedIds = async (env?: 'prod' | 'stag') =>
  (await machineService.listForUser('u1', env)).map((m) => m.machineId)

describe('listForUser — what the mobile app is allowed to see', () => {
  it('never returns a soft-deleted machine', async () => {
    expect(await listedIds()).not.toContain('deleted')
  })

  it('still returns a legacy row that has no deletedAt field at all', async () => {
    // The regression that filtering with a bare `{deletedAt: null}` would cause: every pre-soft-delete
    // machine vanishes from the list, which reads to the owner as their machines being gone.
    expect(await listedIds()).toContain('legacy')
  })

  it('returns a row whose deletedAt is an explicit null', async () => {
    expect(await listedIds()).toContain('explicit-null')
  })

  it('returns exactly the caller-s live machines', async () => {
    expect((await listedIds()).sort()).toEqual(['explicit-null', 'legacy'])
  })

  it('keeps the delete filter when an environment filter is also applied', async () => {
    // Both are spread into one where-clause; the alive filter is an OR, so a future sibling OR would
    // silently overwrite it. Assert the combination, not just the simple case.
    await listedIds('prod')
    const where = findMany.mock.calls[0]![0].where as Where
    expect(where.autonomousEnv).toBe('prod')
    expect(where.OR).toEqual([{ deletedAt: null }, { deletedAt: { isSet: false } }])
  })
})
