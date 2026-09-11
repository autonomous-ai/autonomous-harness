import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.hoisted(() => vi.fn())
const findFirst = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const updateMany = vi.hoisted(() => vi.fn())
const getDevicePresence = vi.hoisted(() => vi.fn())

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    deviceBinding: { findMany, findFirst, update, updateMany },
    machine: { findMany: vi.fn() },
  },
  machineAlive: {},
}))
vi.mock('../lib/bus.js', () => ({ getDevicePresence }))

import { deviceService } from './DeviceService.js'

const device = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'row1',
  userId: 'u1',
  deviceId: 'dev-1',
  machineId: null,
  authMode: 'sds',
  macAddress: 'AA:BB:CC:DD:EE:FF',
  tokenHash: 'h',
  name: 'device',
  lastSeenAt: new Date('2026-08-01T00:00:00Z'),
  createdAt: new Date('2026-07-01T00:00:00Z'),
  firmwareVersion: '0.2.8',
  chip: 'esp32s3',
  ssid: null,
  rssi: null,
  activeMachineId: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  updateMany.mockResolvedValue({ count: 1 })
  getDevicePresence.mockResolvedValue(false)
})

describe('listDetailedForUser', () => {
  it('takes `online` from live presence, NOT from lastSeenAt', async () => {
    // lastSeenAt is bumped by any token authenticate() call and says nothing about a live socket.
    findMany.mockResolvedValue([device({ deviceId: 'a' }), device({ deviceId: 'b' })])
    getDevicePresence.mockImplementation(async (id: string) => id === 'a')

    const rows = await deviceService.listDetailedForUser('u1')

    expect(rows.map((r) => [r.deviceId, r.online])).toEqual([['a', true], ['b', false]])
  })

  it('carries the reported hardware fields through', async () => {
    findMany.mockResolvedValue([device({ ssid: 'Home', rssi: -52, activeMachineId: 'h1' })])

    const [row] = await deviceService.listDetailedForUser('u1')

    expect(row).toMatchObject({
      firmwareVersion: '0.2.8', chip: 'esp32s3', ssid: 'Home', rssi: -52, activeMachineId: 'h1',
    })
  })

  it('reports macAddress as null — the column left with the SDS path', () => {
    // The field stays in the response shape so the mobile app's parser is unaffected; a computer-backed
    // device has a hostname, not a MAC, so there is nothing true to put in it.
    findMany.mockResolvedValue([device()])
    return deviceService.listDetailedForUser('u1').then(([row]) => {
      expect(row.macAddress).toBeNull()
    })
  })

  it('never exposes the token hash', async () => {
    findMany.mockResolvedValue([device()])
    const [row] = await deviceService.listDetailedForUser('u1')
    expect(JSON.stringify(row)).not.toContain('tokenHash')
    expect(JSON.stringify(row)).not.toContain('"h"')
  })
})

describe('recordHello', () => {
  it('writes only the keys the device actually sent', async () => {
    // Firmware without the WiFi fields must not blank values a newer build already recorded.
    await deviceService.recordHello({ deviceId: 'dev-1', firmwareVersion: '0.2.9', chip: 'esp32s3' })

    expect(updateMany).toHaveBeenCalledWith({
      where: { deviceId: 'dev-1' },
      data: { firmwareVersion: '0.2.9', chip: 'esp32s3' },
    })
  })

  it('drops rssi 0 — the firmware sentinel for unknown/disconnected', async () => {
    await deviceService.recordHello({ deviceId: 'dev-1', ssid: 'Home', rssi: 0 })

    expect(updateMany).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' }, data: { ssid: 'Home' } })
  })

  it('stores a real negative rssi', async () => {
    await deviceService.recordHello({ deviceId: 'dev-1', rssi: -52 })
    expect(updateMany).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' }, data: { rssi: -52 } })
  })

  it('does not touch the DB when the device reported nothing usable', async () => {
    await deviceService.recordHello({ deviceId: 'dev-1', firmwareVersion: null, chip: null })
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('swallows a DB failure — this runs on the device socket hot path', async () => {
    updateMany.mockRejectedValue(new Error('mongo down'))
    await expect(deviceService.recordHello({ deviceId: 'dev-1', chip: 'esp32s3' })).resolves.toBeUndefined()
  })
})

describe('setActiveMachine', () => {
  it('persists the pointer', async () => {
    await deviceService.setActiveMachine('dev-1', 'h1')
    expect(updateMany).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' }, data: { activeMachineId: 'h1' } })
  })

  it('persists an explicit null when the machine goes away', async () => {
    await deviceService.setActiveMachine('dev-1', null)
    expect(updateMany).toHaveBeenCalledWith({ where: { deviceId: 'dev-1' }, data: { activeMachineId: null } })
  })

  it('swallows a DB failure', async () => {
    updateMany.mockRejectedValue(new Error('mongo down'))
    await expect(deviceService.setActiveMachine('dev-1', 'h1')).resolves.toBeUndefined()
  })
})

describe('rename', () => {
  it('refuses a device that is not the caller-s', async () => {
    findFirst.mockResolvedValue(null)

    expect(await deviceService.rename('dev-1', 'someone-else', 'Kitchen')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('scopes the lookup by userId, so ownership cannot be bypassed', async () => {
    findFirst.mockResolvedValue(device())
    update.mockResolvedValue(device({ name: 'Kitchen' }))

    await deviceService.rename('dev-1', 'u1', 'Kitchen')

    expect(findFirst).toHaveBeenCalledWith({ where: { deviceId: 'dev-1', userId: 'u1' } })
    expect(update).toHaveBeenCalledWith({ where: { id: 'row1' }, data: { name: 'Kitchen' } })
  })

  it('returns the renamed device with its live online state', async () => {
    findFirst.mockResolvedValue(device())
    update.mockResolvedValue(device({ name: 'Kitchen' }))
    getDevicePresence.mockResolvedValue(true)

    const row = await deviceService.rename('dev-1', 'u1', 'Kitchen')

    expect(row).toMatchObject({ name: 'Kitchen', online: true })
  })
})

describe('detailForUser', () => {
  it('is null for another user-s device', async () => {
    findFirst.mockResolvedValue(null)
    expect(await deviceService.detailForUser('dev-1', 'u2')).toBeNull()
  })
})
