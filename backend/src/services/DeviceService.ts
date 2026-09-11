import type { DeviceBinding } from '@prisma/client'
import { prisma, machineAlive } from '../lib/prisma.js'
import { sha256hex } from '../utils/crypto.js'
import { logger } from '../utils/logger.js'
import { machineBillingAllowsDataPlane } from '../lib/billingState.js'
import { getDevicePresence } from '../lib/bus.js'

export interface DeviceView {
  deviceId: string
  name: string
  // LEGACY per-machine pairing pinned the device to this ONE machine. Null for per-user devices, which pick
  // machines themselves at runtime — kept only so the web can show a legacy device's origin.
  machineId: string | null
  lastSeenAt: Date | null
  createdAt: Date
}

/**
 * Everything a client can know about a device WITHOUT holding a socket of its own.
 *
 * Distinct from `DeviceView` on purpose. `DeviceView` is the web's shape and carries the LEGACY
 * `machineId` (the immutable pairing origin, null for every per-user device); this one carries
 * `activeMachineId`, which is where the device is attached right now. Conflating the two is the
 * single easiest mistake to make against this model, so they never appear in the same object.
 */
export interface DeviceDetail {
  deviceId: string
  name: string
  /** Live: the backend is holding this device's socket. NOT derived from `lastSeenAt`. */
  online: boolean
  lastSeenAt: Date | null
  createdAt: Date
  macAddress: string | null
  firmwareVersion: string | null
  chip: string | null
  ssid: string | null
  rssi: number | null
  activeMachineId: string | null
}

/** Fallback label for a machine on the device machine-picker when it has no display name yet
 *  (`Machine.name`, the user-editable display name) — mirrors the web's fallback. */
function machineDisplayName(machineId: string): string {
  return `machine-${machineId.slice(0, 6)}`
}

/** Exported so the mobile surface labels a machine exactly like the device's own picker does. */
export { machineDisplayName }

function toDeviceView(d: DeviceBinding): DeviceView {
  return { deviceId: d.deviceId, name: d.name, machineId: d.machineId, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt }
}

function toDeviceDetail(d: DeviceBinding, online: boolean): DeviceDetail {
  return {
    deviceId: d.deviceId,
    name: d.name,
    online,
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
    // The column is gone with the SDS path; a computer-backed dial has a hostname, not a MAC.
    // Kept as a literal so the mobile response shape does not change.
    macAddress: null,
    firmwareVersion: d.firmwareVersion,
    chip: d.chip,
    ssid: d.ssid,
    rssi: d.rssi,
    activeMachineId: d.activeMachineId,
  }
}

export const deviceService = {
  /**
   * The one way a device comes into existence: resolve the row for a COMPUTER, creating it on first sight.
   *
   * `deviceId` is DERIVED, never random, and each ingredient is load-bearing. `deviceId` is globally
   * `@unique` while `computerId` is self-declared by the client — using the computer id verbatim would let
   * one account squat another's row. Hashing the userId in namespaces it per account, and the environment
   * keeps the "same person, separate rows per Autonomous plane" rule true regardless of how User rows are
   * scoped. Determinism is what makes this a single idempotent upsert with no key to mint and therefore no
   * create-lock: two daemons racing on the same computer converge on the same row.
   *
   * Identity is the SSO subject resolved upstream (`user.sub`), never email.
   */
  async resolveOrCreateForComputer(
    userId: string,
    autonomousEnv: 'prod' | 'stag',
    computerId: string,
    label: string,
  ): Promise<DeviceBinding> {
    const deviceId = `cmp-${sha256hex(`${userId}:${autonomousEnv}:${computerId}`).slice(0, 24)}`
    const name = label.trim().slice(0, 120) || 'computer'
    return prisma.deviceBinding.upsert({
      where: { deviceId },
      create: { userId, deviceId, computerId, name, lastSeenAt: new Date() },
      // `userId` is re-applied so a computer that changed hands follows its owner. `name` is deliberately
      // NOT overwritten: it is the user-editable display name, and a reconnect must not undo a rename —
      // the same rule Machine.name follows.
      update: { userId, computerId, lastSeenAt: new Date() },
    })
  },

  /** The user's machines for the device machine-picker. Ordered oldest-first for a stable list.
   *
   *  Scoped to ONE Autonomous plane. The same person legitimately owns separate machines per environment,
   *  and showing them together would let a device select a machine its token cannot drive — the check
   *  `webWs` has always made and this plane could not, until it gained an authenticated env of its own. */
  async machinesForUser(userId: string, autonomousEnv?: 'prod' | 'stag'): Promise<Array<{ machineId: string; name: string; authMode: 'self' | 'managed' | 'remote' | 'provider' | 'provider'; remote: boolean }>> {
    const rows = await prisma.machine.findMany({
      where: { userId, ...(autonomousEnv ? { autonomousEnv } : {}), ...machineAlive },
      orderBy: { createdAt: 'asc' },
    })
    return rows.filter(machineBillingAllowsDataPlane).map((r) => {
      const authMode = r.authMode === 'managed' || r.authMode === 'remote' || r.authMode === 'provider' ? r.authMode : 'self'
      // `remote` here means "backed by the owner's own machine", which drives the device's
      // "Offline" badge. A provider machine is never offline in that sense, so it is NOT remote.
      return { machineId: r.machineId, name: r.name?.trim() || machineDisplayName(r.machineId), authMode, remote: authMode === 'remote' }
    })
  },

  /** A user's paired devices (no tokens). */
  async listForUser(userId: string): Promise<DeviceView[]> {
    const rows = await prisma.deviceBinding.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
    return rows.map(toDeviceView)
  },

  /** A user's devices with their live state, for a client that has no socket of its own (the mobile app).
   *  `online` is one Redis GET per device — fine at the scale a person owns; revisit with a pipeline if a
   *  single account ever holds dozens. */
  async listDetailedForUser(userId: string): Promise<DeviceDetail[]> {
    const rows = await prisma.deviceBinding.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
    const presence = await Promise.all(rows.map((r) => getDevicePresence(r.deviceId)))
    return rows.map((r, i) => toDeviceDetail(r, presence[i]))
  },

  /** One of the user's devices, or null when it is not theirs. Ownership is enforced in the query. */
  async detailForUser(deviceId: string, userId: string): Promise<DeviceDetail | null> {
    const d = await prisma.deviceBinding.findFirst({ where: { deviceId, userId } })
    if (!d) return null
    return toDeviceDetail(d, await getDevicePresence(d.deviceId))
  },

  /**
   * Snapshot what the device just told us in `device_hello`.
   *
   * Only keys the device ACTUALLY sent are written. That matters for `ssid`/`rssi`: firmware without
   * them must not blank a value a newer build had already recorded, and a build that does send them
   * refreshes on every connect. `rssi: 0` is the firmware's "unknown/disconnected" sentinel
   * (`wifi_sta.c:136`), so it is dropped rather than stored as a real reading.
   *
   * Best-effort by design: this is called from the device socket's hot path, and a Mongo blip must
   * never take a live device down.
   */
  async recordHello(input: {
    deviceId: string
    firmwareVersion?: string | null
    chip?: string | null
    ssid?: string | null
    rssi?: number | null
  }): Promise<void> {
    const data: Record<string, unknown> = {}
    if (input.firmwareVersion) data.firmwareVersion = input.firmwareVersion
    if (input.chip) data.chip = input.chip
    if (input.ssid) data.ssid = input.ssid
    if (typeof input.rssi === 'number' && Number.isFinite(input.rssi) && input.rssi !== 0) data.rssi = Math.trunc(input.rssi)
    if (Object.keys(data).length === 0) return
    await prisma.deviceBinding
      .updateMany({ where: { deviceId: input.deviceId }, data })
      .catch((err: unknown) => logger.warn('recordHello failed', { deviceId: input.deviceId, error: String(err) }))
  },

  /**
   * Persist which machine the device is attached to right now.
   *
   * NOT cleared when the socket closes, deliberately. A device that reconnects within milliseconds
   * would otherwise race its own previous socket's teardown and flicker to null while genuinely
   * attached. On an offline device the retained value reads as "last attached to", which is the more
   * useful of the two answers anyway — clients gate this field on `online` (see the mobile spec).
   * `null` is still written when a machine is deleted out from under the device.
   */
  async setActiveMachine(deviceId: string, machineId: string | null): Promise<void> {
    await prisma.deviceBinding
      .updateMany({ where: { deviceId }, data: { activeMachineId: machineId } })
      .catch((err: unknown) => logger.warn('setActiveMachine failed', { deviceId, error: String(err) }))
  },

  /** Rename one of the user's devices. Null when the device is not theirs — same ownership rule as revoke. */
  async rename(deviceId: string, userId: string, name: string): Promise<DeviceDetail | null> {
    const d = await prisma.deviceBinding.findFirst({ where: { deviceId, userId } })
    if (!d) return null
    const updated = await prisma.deviceBinding.update({ where: { id: d.id }, data: { name } })
    logger.info('device renamed', { userId, deviceId, name })
    return toDeviceDetail(updated, await getDevicePresence(deviceId))
  },

  /** Revoke (delete) one of the user's devices. Returns the deviceId + ALL the user's machineIds so the
   *  caller can push a `device_revoked` frame on each (a per-user device is attached under whichever
   *  machine it currently has selected; the targetDeviceId filter means only that one socket receives it).
   *  Null if nothing matched. */
  async revoke(deviceId: string, userId: string): Promise<{ deviceId: string; machineIds: string[] } | null> {
    const d = await prisma.deviceBinding.findFirst({ where: { deviceId, userId } })
    if (!d) return null
    await prisma.deviceBinding.delete({ where: { id: d.id } }).catch(() => {})
    const machines = await prisma.machine.findMany({
      where: { userId, ...machineAlive }, select: { machineId: true, billingStatus: true },
    })
    return { deviceId: d.deviceId, machineIds: machines.filter(machineBillingAllowsDataPlane).map((f) => f.machineId) }
  },
}
