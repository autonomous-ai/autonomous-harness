/**
 * Cross-instance data bus over Redis pub/sub.
 *
 * Behind a load balancer a given agent's web socket(s) and its single manager socket can land on
 * DIFFERENT backend instances. Redis bridges that gap (this is the ONLY cross-instance state — see
 * docs/plans/2026-07-09_invert-ws-transport-backend-hub-redis.md):
 *
 *  - up:{machineId}   — node→client events. Published by the backend holding the manager socket (B_m);
 *                     delivered by every backend with ≥1 local client for the agent (≤ M subscribers).
 *  - down:{machineId} — client→node messages. Published by any client-holding backend; delivered by the
 *                     single backend holding the manager socket (exactly 1 subscriber, B_m).
 *  - mgr:{managerId} — control/provisioning commands to a specific manager (Phase 3), delivered by the
 *                     backend holding that manager's socket.
 *
 * ioredis requires a connection in subscribe mode to be dedicated (it can't run other commands), so
 * we keep one `sub` connection for SUBSCRIBE and one `pub` connection for PUBLISH/keys.
 */
import { Redis } from 'ioredis'
import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import type { UpBusMsg, DownBusMsg } from './tunnel.js'

const redisOpts = { maxRetriesPerRequest: null as null, lazyConnect: false }

export const pub = new Redis(env.REDIS_URL, redisOpts)
const sub = new Redis(env.REDIS_URL, redisOpts)
const terminalSub = new Redis(env.REDIS_URL, redisOpts)

pub.on('error', (err: Error) => logger.error('[bus] pub redis error', err))
sub.on('error', (err: Error) => logger.error('[bus] sub redis error', err))
terminalSub.on('error', (err: Error) => logger.error('[bus] terminal sub redis error', err))

export async function closeBus(): Promise<void> {
  await Promise.allSettled([pub.quit(), sub.quit(), terminalSub.quit()])
}

type Cb = (msg: unknown) => void
const channelSubs = new Map<string, Set<Cb>>()
const channelSubscribePromises = new Map<string, Promise<void>>()

sub.on('message', (channel: string, payload: string) => {
  const set = channelSubs.get(channel)
  if (!set || set.size === 0) return
  let msg: unknown
  try {
    msg = JSON.parse(payload)
  } catch (err) {
    logger.error('[bus] bad JSON on channel', err, { channel })
    return
  }
  for (const cb of set) {
    try {
      cb(msg)
    } catch (err) {
      logger.error('[bus] subscriber callback threw', err, { channel })
    }
  }
})

/** Refcounted subscribe: SUBSCRIBEs on the first callback for a channel, UNSUBSCRIBEs on the last. */
async function addSub(channel: string, cb: Cb): Promise<() => void> {
  let set = channelSubs.get(channel)
  let subscribePromise = channelSubscribePromises.get(channel)
  if (!set) {
    set = new Set()
    channelSubs.set(channel, set)
    subscribePromise = sub.subscribe(channel)
      .then(() => undefined)
      .catch((err) => {
        logger.error('[bus] subscribe failed', err, { channel })
        if (channelSubs.get(channel) === set) channelSubs.delete(channel)
        throw err
      })
      .finally(() => {
        if (channelSubscribePromises.get(channel) === subscribePromise) channelSubscribePromises.delete(channel)
      })
    channelSubscribePromises.set(channel, subscribePromise)
  }
  set.add(cb)
  if (subscribePromise) {
    try {
      await subscribePromise
    } catch (err) {
      const s = channelSubs.get(channel)
      if (s === set) {
        s.delete(cb)
        if (s.size === 0) channelSubs.delete(channel)
      }
      throw err
    }
  }
  return () => {
    const s = channelSubs.get(channel)
    if (!s) return
    s.delete(cb)
    if (s.size === 0) {
      channelSubs.delete(channel)
      sub.unsubscribe(channel).catch(() => { /* ignore */ })
    }
  }
}

const upChannel = (machineId: string): string => `up:${machineId}`
const downChannel = (machineId: string): string => `down:${machineId}`
const mgrChannel = (managerId: string): string => `mgr:${managerId}`
const appDownChannel = (machineId: string): string => `appdown:${machineId}`
const appUpChannel = (streamId: string): string => `appup:${streamId}`
const presenceKey = (machineId: string): string => `machine:${machineId}:mgr`
const terminalUpChannel = (machineId: string): string => `termup:${machineId}`
const terminalDownChannel = (machineId: string): string => `termdown:${machineId}`

type BinaryCb = (payload: Buffer) => void
const binarySubs = new Map<string, Set<BinaryCb>>()
terminalSub.on('messageBuffer', (channelRaw: Buffer, payload: Buffer) => {
  const callbacks = binarySubs.get(channelRaw.toString('utf8'))
  if (!callbacks) return
  for (const callback of callbacks) {
    try { callback(Buffer.from(payload)) } catch (err) { logger.error('[bus] binary subscriber callback threw', err) }
  }
})

async function addBinarySub(channel: string, callback: BinaryCb): Promise<() => void> {
  let callbacks = binarySubs.get(channel)
  if (!callbacks) {
    callbacks = new Set()
    binarySubs.set(channel, callbacks)
    await terminalSub.subscribe(channel)
  }
  callbacks.add(callback)
  return () => {
    const current = binarySubs.get(channel)
    if (!current) return
    current.delete(callback)
    if (current.size === 0) {
      binarySubs.delete(channel)
      void terminalSub.unsubscribe(channel)
    }
  }
}

export function subscribeTerminalUp(machineId: string, callback: BinaryCb): Promise<() => void> {
  return addBinarySub(terminalUpChannel(machineId), callback)
}
export function subscribeTerminalDown(machineId: string, callback: BinaryCb): Promise<() => void> {
  return addBinarySub(terminalDownChannel(machineId), callback)
}
export function publishTerminalUp(machineId: string, payload: Uint8Array): Promise<number> {
  return pub.publish(terminalUpChannel(machineId), Buffer.from(payload))
}
export function publishTerminalDown(machineId: string, payload: Uint8Array): Promise<number> {
  return pub.publish(terminalDownChannel(machineId), Buffer.from(payload))
}

// ── up / down data channels ──────────────────────────────────────────────────────────────────────

export function subscribeUp(machineId: string, cb: (msg: UpBusMsg) => void): Promise<() => void> {
  return addSub(upChannel(machineId), cb as Cb)
}

export function subscribeDown(machineId: string, cb: (msg: DownBusMsg) => void): Promise<() => void> {
  return addSub(downChannel(machineId), cb as Cb)
}

export function publishUp(machineId: string, msg: UpBusMsg): Promise<number> {
  return pub.publish(upChannel(machineId), JSON.stringify(msg))
}

export function publishDown(machineId: string, msg: DownBusMsg): Promise<number> {
  return pub.publish(downChannel(machineId), JSON.stringify(msg))
}

// ── app-proxy tunnel channels ────────────────────────────────────────────────────────────────────
// App traffic is routed by MACHINEID (not managerId): an app belongs to a machine, and the machine's
// node manager socket has exactly ONE backend subscriber (B_m), so appdown:{machineId} has a single
// delivery path (no duplication under clustering) and rides the machine's sharded pool socket. Responses flow back
// on a per-STREAM channel so they reach the exact backend instance terminating the public request.

/** client→app frames (app_req, app_body, app_ws_open/msg/close, app_abort), delivered by B_m. */
export function subscribeAppDown(machineId: string, cb: (msg: unknown) => void): Promise<() => void> {
  return addSub(appDownChannel(machineId), cb)
}
export function publishAppDown(machineId: string, msg: unknown): Promise<number> {
  return pub.publish(appDownChannel(machineId), JSON.stringify(msg))
}

/** app→client frames (app_res, app_res_body, app_ws_msg/close, app_abort) → the origin instance. */
export function subscribeAppUp(streamId: string, cb: (msg: unknown) => void): Promise<() => void> {
  return addSub(appUpChannel(streamId), cb)
}
export function publishAppUp(streamId: string, msg: unknown): Promise<number> {
  return pub.publish(appUpChannel(streamId), JSON.stringify(msg))
}

// ── manager command channel (Phase 3) ──────────────────────────────────────────────────────────

export function subscribeMgr(managerId: string, cb: (msg: unknown) => void): Promise<() => void> {
  return addSub(mgrChannel(managerId), cb)
}

export function publishMgr(managerId: string, msg: unknown): Promise<number> {
  return pub.publish(mgrChannel(managerId), JSON.stringify(msg))
}

// Per-request reply channel for the provisioning RPC (backend → mgr:{managerId} → manager → reply).
const replyChannel = (requestId: string): string => `mgrreply:${requestId}`

export function subscribeReply(requestId: string, cb: (msg: unknown) => void): Promise<() => void> {
  return addSub(replyChannel(requestId), cb)
}

export function publishReply(requestId: string, msg: unknown): Promise<number> {
  return pub.publish(replyChannel(requestId), JSON.stringify(msg))
}

// ── agent→manager presence (which manager currently owns an agent's node) ─────────────────────────

/** Set/refresh the presence key. Called on register + on each manager ping. */
export async function setAgentPresence(machineId: string, managerId: string, ttlSec = 30): Promise<void> {
  try {
    await pub.set(presenceKey(machineId), managerId, 'EX', ttlSec)
  } catch (err) {
    logger.error('[bus] setAgentPresence failed', err, { machineId })
  }
}

export async function getAgentPresence(machineId: string): Promise<string | null> {
  try {
    return await pub.get(presenceKey(machineId))
  } catch (err) {
    logger.error('[bus] getAgentPresence failed', err, { machineId })
    return null
  }
}

// A device's last-selected machine, so the backend can restore the active machine after a reconnect. A
// multi_machine device renders agents by attaching to every machine WITHOUT sending machine_select, so on a
// fresh connection `activeMachineId` would otherwise stay null and voice/RPCs fail with "no machine selected".
const deviceLastMachineKey = (deviceId: string): string => `devlastmachine:${deviceId}`
export async function setDeviceLastMachine(deviceId: string, machineId: string, ttlSec = 30 * 24 * 3600): Promise<void> {
  try { await pub.set(deviceLastMachineKey(deviceId), machineId, 'EX', ttlSec) } catch (err) { logger.error('[bus] setDeviceLastMachine failed', err, { deviceId }) }
}
export async function getDeviceLastMachine(deviceId: string): Promise<string | null> {
  try { return await pub.get(deviceLastMachineKey(deviceId)) } catch { return null }
}

// ── provider-machine recap cache (the device's tile text) ─────────────────────────────────────────
// Redis rather than a process Map because the backend runs FOUR cluster workers: the worker that ran
// the turn is usually not the one the device's `agent_recent` lands on, so an in-heap cache would
// answer "no recap" most of the time and every worker restart would blank the tiles. Only the
// provider path writes here — every other machine kind persists its own recap node-side.
// A whole small array under one key, not LPUSH/LTRIM: `n` is capped at 5 by the schema, so the value
// is tiny, and every other value in this file is a plain JSON `set`. Two turns finishing on the SAME
// agent at once can lose an entry in the read-modify-write; that is no worse than `activeTasks`,
// which is already one-per-machine, and a lost tile self-heals on the next turn.
const machineRecapKey = (machineId: string, agentId: string): string => `machine:${machineId}:recap:${agentId}`
const MACHINE_RECAP_KEEP = 5

export async function pushMachineRecap<T>(machineId: string, agentId: string, entry: T, ttlSec = 30 * 24 * 3600): Promise<void> {
  if (!agentId) return
  try {
    const existing = await getMachineRecaps<T>(machineId, agentId, MACHINE_RECAP_KEEP)
    const next = [entry, ...existing].slice(0, MACHINE_RECAP_KEEP)
    await pub.set(machineRecapKey(machineId, agentId), JSON.stringify(next), 'EX', ttlSec)
  } catch (err) {
    // Best-effort: a recap that fails to cache costs a tile after a device reboot, never a turn.
    logger.error('[bus] pushMachineRecap failed', err, { machineId, agentId })
  }
}

export async function getMachineRecaps<T>(machineId: string, agentId: string, n: number): Promise<T[]> {
  if (!agentId) return []
  try {
    const raw = await pub.get(machineRecapKey(machineId, agentId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed.slice(0, n) as T[]) : []
  } catch {
    return []
  }
}

// ── Resumable voice upload: park a partial live-stream so it survives a WS drop + reconnect ──────────
// Streaming voice has no local device copy; a WS blip mid-recording used to lose the whole (up to ~10-min)
// ramble. On a drop the backend PARKS the accumulated audio here keyed by the STABLE deviceId (not the
// per-connection closure), so a reconnect — which may land on a DIFFERENT backend instance (prod is
// multi-instance, non-sticky) — can `resumeVoiceUpload` and continue appending. Grace TTL ~60s. Written
// once per DROP (not per chunk). meta is the commit marker (set AFTER the pcm), so a torn write reads as
// absent. See docs/plans resumable-voice-upload.
export interface ParkedVoiceMeta {
  uploadId: string
  mode: 'turn' | 'ask'
  route: boolean
  goal: boolean
  loop: boolean
  autonomy: 'plan' | 'auto'
  agentId: string | null
  sessionId: string | null
  requestId: string | null
  sr: number
  lang: string
  size: number
  machineId: string | null
}
const voiceUploadPcmKey = (deviceId: string): string => `voiceupload:${deviceId}:pcm`
const voiceUploadMetaKey = (deviceId: string): string => `voiceupload:${deviceId}:meta`
export async function parkVoiceUpload(deviceId: string, meta: ParkedVoiceMeta, pcm: Buffer, ttlSec = 60): Promise<void> {
  try {
    await pub.set(voiceUploadPcmKey(deviceId), pcm, 'EX', ttlSec)            // binary value (ioredis Buffer)
    await pub.set(voiceUploadMetaKey(deviceId), JSON.stringify(meta), 'EX', ttlSec)  // commit marker last
  } catch (err) { logger.error('[bus] parkVoiceUpload failed', err, { deviceId, size: pcm.length }) }
}
export async function resumeVoiceUpload(deviceId: string): Promise<{ meta: ParkedVoiceMeta; pcm: Buffer } | null> {
  try {
    const metaStr = await pub.get(voiceUploadMetaKey(deviceId))
    if (!metaStr) return null
    const pcm = await pub.getBuffer(voiceUploadPcmKey(deviceId))
    if (!pcm) return null
    return { meta: JSON.parse(metaStr) as ParkedVoiceMeta, pcm }
  } catch (err) { logger.error('[bus] resumeVoiceUpload failed', err, { deviceId }); return null }
}
export async function evictVoiceUpload(deviceId: string): Promise<void> {
  try { await pub.del(voiceUploadMetaKey(deviceId), voiceUploadPcmKey(deviceId)) } catch { /* best effort */ }
}

export async function clearAgentPresence(machineId: string): Promise<void> {
  try {
    await pub.del(presenceKey(machineId))
  } catch (err) {
    logger.error('[bus] clearAgentPresence failed', err, { machineId })
  }
}

// ── one-computer-per-machine ownership ────────────────────────────────────────────────────────────
// A SEPARATE key from presence (which stays `machine:{id}:mgr` = 'remote' for the online/status path):
// `machine:{id}:owner` = the connecting COMPUTER's stable id. Atomic compare-and-set so a SECOND
// computer (different computerId) is rejected while the first holds the machine, but the SAME computer
// reconnecting after a blip/restart (its 30s key may still be alive) always reclaims. The value is the
// computerId — not a shared token — so the delete on teardown is conditional (a superseded/other socket
// can't free the real owner's claim). Mirrors the device-presence compare-and-delete pattern below.
const ownerKey = (machineId: string): string => `machine:${machineId}:owner`

/** Claim or refresh ownership. Returns true when this computer owns the machine afterwards (it was free
 *  or already ours), false when a DIFFERENT computer currently holds it. Also used as the refresh call. */
export async function claimMachineOwner(machineId: string, computerId: string, ttlSec = 30): Promise<boolean> {
  try {
    const res = await pub.eval(
      "local cur = redis.call('get', KEYS[1]) " +
      "if (not cur) or (cur == ARGV[1]) then redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]) return 1 else return 0 end",
      1, ownerKey(machineId), computerId, String(ttlSec),
    )
    return res === 1
  } catch (err) {
    // On a Redis error, fail OPEN (allow) — losing the backend link should never lock a user out of
    // their own machine; single-computer enforcement is best-effort liveness, not a security boundary.
    logger.error('[bus] claimMachineOwner failed', err, { machineId })
    return true
  }
}

/** Conditional delete: only frees the claim if it still holds THIS computerId (compare-and-delete). */
export async function releaseMachineOwner(machineId: string, computerId: string): Promise<void> {
  try {
    await pub.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1, ownerKey(machineId), computerId,
    )
  } catch (err) {
    logger.error('[bus] releaseMachineOwner failed', err, { machineId })
  }
}

// ── desktop-app state on a remote machine ─────────────────────────────────────────────────────────
// `machine:{id}:app` = "<engine>:<state>" — which desktop app this COMPUTER drives and whether it is
// running right now (see docs/specs/machine-adapter-cursor-desktop-integration.md). Written by the
// adapter socket, refreshed on the same 15s heartbeat that renews presence, and given the SAME 30s
// TTL as `machine:{id}:mgr` so the claim can never outlive the socket that made it: if a worker is
// killed without running cleanup, both keys expire together and the machine reads offline rather
// than "Cursor open" forever. Deliberately NOT a Prisma column — the value's useful life is 30s and
// a DB row would survive a crashed worker and lie.
const appStateKey = (machineId: string): string => `machine:${machineId}:app`

export async function setMachineAppState(
  machineId: string, engine: string, state: string, ttlSec = 30,
): Promise<void> {
  try {
    await pub.set(appStateKey(machineId), `${engine}:${state}`, 'EX', ttlSec)
  } catch (err) {
    logger.error('[bus] setMachineAppState failed', err, { machineId })
  }
}

/** null when unknown (no adapter, legacy adapter, or the key expired). */
export async function getMachineAppState(
  machineId: string,
): Promise<{ engine: string; state: string } | null> {
  try {
    const raw = await pub.get(appStateKey(machineId))
    if (!raw) return null
    const sep = raw.indexOf(':')
    if (sep <= 0 || sep === raw.length - 1) return null
    return { engine: raw.slice(0, sep), state: raw.slice(sep + 1) }
  } catch (err) {
    logger.error('[bus] getMachineAppState failed', err, { machineId })
    return null
  }
}

export async function clearMachineAppState(machineId: string): Promise<void> {
  try {
    await pub.del(appStateKey(machineId))
  } catch (err) {
    logger.error('[bus] clearMachineAppState failed', err, { machineId })
  }
}

// ── device presence (is a paired device's socket currently connected?) ─────────────────────────────
// One key PER DEVICE (`device:{deviceId}:conn`) — a user with many devices has one independent key,
// refresh loop and supersede scope per device. The VALUE is the connection's own token so that when
// a device reconnects (new socket, possibly on another worker) the OLD socket's teardown cannot
// delete the NEW socket's key: the delete is conditional on the token still being ours.
const devicePresenceKey = (deviceId: string): string => `device:${deviceId}:conn`
const deviceStatusChannel = (userId: string): string => `devstatus:${userId}`
const deviceMachineListChannel = (userId: string): string => `devmachines:${userId}`
const deviceE2eePairChannel = (userId: string): string => `deve2eepair:${userId}`

/** Set/refresh this connection's presence. Called on device-ws open + every ~15s while connected. */
export async function setDevicePresence(deviceId: string, connToken: string, ttlSec = 45): Promise<void> {
  try {
    await pub.set(devicePresenceKey(deviceId), connToken, 'EX', ttlSec)
  } catch (err) {
    logger.error('[bus] setDevicePresence failed', err, { deviceId })
  }
}

/** Conditional delete: only removes the key if it still holds THIS connection's token.
 *  Returns true when the key is gone afterwards (deleted by us or already absent). */
export async function clearDevicePresence(deviceId: string, connToken: string): Promise<boolean> {
  try {
    await pub.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1, devicePresenceKey(deviceId), connToken,
    )
    return !(await pub.get(devicePresenceKey(deviceId)))
  } catch (err) {
    logger.error('[bus] clearDevicePresence failed', err, { deviceId })
    return false
  }
}

export async function getDevicePresence(deviceId: string): Promise<boolean> {
  try {
    return !!(await pub.get(devicePresenceKey(deviceId)))
  } catch (err) {
    logger.error('[bus] getDevicePresence failed', err, { deviceId })
    return false
  }
}

export interface DeviceStatusMsg { deviceId: string; online: boolean; lastSeenAt?: string }

/** Per-USER transition channel (one sub per watching web socket); messages are PER-DEVICE. */
export function publishDeviceStatus(userId: string, msg: DeviceStatusMsg): Promise<number> {
  return pub.publish(deviceStatusChannel(userId), JSON.stringify(msg))
}

export function subscribeDeviceStatus(userId: string, cb: (msg: DeviceStatusMsg) => void): Promise<() => void> {
  return addSub(deviceStatusChannel(userId), cb as Cb)
}

// Per-USER machine-list invalidation for connected devices (and web machine-list watchers). Machine
// create/delete/rename happens on normal REST workers, while device/web sockets may live on another
// worker, so Redis fans out "re-query the DB now".
export interface DeviceMachineListChangedMsg {
  reason: 'created' | 'deleted' | 'renamed' | 'updated' | 'environment_changed'
  autonomousEnv?: 'prod' | 'stag'
}

export function publishDeviceMachineListChanged(userId: string, msg: DeviceMachineListChangedMsg): Promise<number> {
  return pub.publish(deviceMachineListChannel(userId), JSON.stringify(msg))
}

export function subscribeDeviceMachineListChanged(userId: string, cb: (msg: DeviceMachineListChangedMsg) => void): Promise<() => void> {
  return addSub(deviceMachineListChannel(userId), cb as Cb)
}

export interface DeviceE2eePairMsg {
  kind: 'pending' | 'cleared'
  machineId: string
  machineName?: string | null
  label?: string
  pairId: string
  expiresAt?: number
  computerFingerprint?: string | null
  result?: 'paired' | 'failed' | 'cancelled'
}

export function publishDeviceE2eePair(userId: string, msg: DeviceE2eePairMsg): Promise<number> {
  return pub.publish(deviceE2eePairChannel(userId), JSON.stringify(msg))
}

export function subscribeDeviceE2eePair(userId: string, cb: (msg: DeviceE2eePairMsg) => void): Promise<() => void> {
  return addSub(deviceE2eePairChannel(userId), cb as Cb)
}

// ── per-device control channel (backend → the one connected device socket, any worker) ────────────
// Unlike pushDeviceRevoked (rides up:{machineId}, reaches only a hub-ATTACHED commander conn — i.e. a
// device that has selected a machine), this reaches the device-ws relay itself, so a device parked on
// the machine PICKER is covered too.
const deviceControlChannel = (deviceId: string): string => `devctl:${deviceId}`

export interface DeviceControlMsg { action: 'revoked' | 'superseded'; by?: string }

export function publishDeviceControl(deviceId: string, msg: DeviceControlMsg): Promise<number> {
  return pub.publish(deviceControlChannel(deviceId), JSON.stringify(msg))
}

export function subscribeDeviceControl(deviceId: string, cb: (msg: DeviceControlMsg) => void): Promise<() => void> {
  return addSub(deviceControlChannel(deviceId), cb as Cb)
}

// ── instance-affinity for the data-plane mesh (Phase 2) ────────────────────────────────────────────
// machine:{machineId}:appinst → the backend INSTANCE id holding that agent's app-pool manager socket.
// inst:{instanceId}:mesh   → that instance's internal mesh endpoint (host:port). Both TTL-refreshed.
const appInstKey = (machineId: string): string => `machine:${machineId}:appinst`
const meshKey = (instanceId: string): string => `inst:${instanceId}:mesh`

export async function setAppInstance(machineId: string, instanceId: string, ttlSec = 30): Promise<void> {
  try { await pub.set(appInstKey(machineId), instanceId, 'EX', ttlSec) } catch (err) { logger.error('[bus] setAppInstance failed', err, { machineId }) }
}
export async function getAppInstance(machineId: string): Promise<string | null> {
  try { return await pub.get(appInstKey(machineId)) } catch (err) { logger.error('[bus] getAppInstance failed', err, { machineId }); return null }
}
export async function clearAppInstance(machineId: string): Promise<void> {
  try { await pub.del(appInstKey(machineId)) } catch (err) { logger.error('[bus] clearAppInstance failed', err, { machineId }) }
}
export async function setMeshEndpoint(instanceId: string, endpoint: string, ttlSec = 30): Promise<void> {
  try { await pub.set(meshKey(instanceId), endpoint, 'EX', ttlSec) } catch (err) { logger.error('[bus] setMeshEndpoint failed', err, { instanceId }) }
}
export async function getMeshEndpoint(instanceId: string): Promise<string | null> {
  try { return await pub.get(meshKey(instanceId)) } catch (err) { logger.error('[bus] getMeshEndpoint failed', err, { instanceId }); return null }
}

// ── global per-agent client-count registry ─────────────────────────────────────────────────────────
// Drives the node's `__clients` aggregate lifecycle. `registry.clientCounts` is PER-PROCESS, but the
// node needs the CROSS-INSTANCE total (web on B1 + device on B2 must both count). We keep a HASH per
// agent, field = backend INSTANCE_ID → "ui,commander". Each field carries a per-field TTL (HEXPIRE,
// Redis ≥7.4) so a CRASHED instance's contribution ages out on its own — else the node would keep a
// commander/web aggregate warm for a dead client-holder. Live instances refresh on the hub heartbeat
// (25s < 45s TTL). Only B_m reads the sum and emits the frame (see hub.recomputeAndSendClients).
const clientsKey = (machineId: string): string => `machine:${machineId}:clients`
const commanderJoinGenerationKey = (machineId: string): string => `machine:${machineId}:commander-join-generation`
const CLIENT_COUNT_TTL_SEC = 45

/** Write THIS instance's local {ui,commander,commanderActive} for an agent (HDEL when zero), with a fresh
 *  per-field TTL. Field format is `ui,commander,commanderActive`; the trailing field is optional so an old
 *  instance's `ui,commander` still parses (missing → 0). */
export async function setAgentClientCount(machineId: string, instanceId: string, ui: number, commander: number, commanderActive = 0): Promise<void> {
  const key = clientsKey(machineId)
  try {
    if (ui === 0 && commander === 0) { await pub.hdel(key, instanceId); return }
    await pub.hset(key, instanceId, `${ui},${commander},${commanderActive}`)
  } catch (err) {
    logger.error('[bus] setAgentClientCount failed', err, { machineId, instanceId })
    return
  }
  // Per-field expiry (Redis 7.4+): FIELDS 1 <field>. Refreshed each heartbeat; a dead instance's field
  // simply expires. `pub.call` avoids depending on ioredis' typed hexpire signature. On Redis < 7.4
  // (HEXPIRE unknown) fall back to a whole-key TTL — coarser (any live instance's heartbeat keeps the
  // whole key warm), but enough that a crashed sole instance still ages out. The count was already
  // written above, so a TTL failure must NOT surface as a "client count failed" error.
  try {
    await pub.call('HEXPIRE', key, String(CLIENT_COUNT_TTL_SEC), 'FIELDS', '1', instanceId)
  } catch {
    try { await pub.expire(key, CLIENT_COUNT_TTL_SEC) } catch { /* best-effort */ }
  }
}

/** Sum of every live instance's counts for an agent (expired fields already dropped Redis-side). */
export async function getAgentClientTotals(machineId: string): Promise<{ ui: number; commander: number; commanderActive: number }> {
  try {
    const h = await pub.hgetall(clientsKey(machineId))
    let ui = 0
    let commander = 0
    let commanderActive = 0
    for (const v of Object.values(h)) {
      const [u, c, a] = String(v).split(',')
      ui += parseInt(u, 10) || 0
      commander += parseInt(c, 10) || 0
      commanderActive += parseInt(a, 10) || 0
    }
    return { ui, commander, commanderActive }
  } catch (err) {
    logger.error('[bus] getAgentClientTotals failed', err, { machineId })
    return { ui: 0, commander: 0, commanderActive: 0 }
  }
}

/** Monotonic machine-wide generation. Unlike the aggregate count, this changes for EVERY commander attach,
 * including a leave/rejoin that is coalesced to the same total before the node sees a count snapshot. */
export async function bumpCommanderJoinGeneration(machineId: string): Promise<number | undefined> {
  try {
    return await pub.incr(commanderJoinGenerationKey(machineId))
  } catch (err) {
    logger.error('[bus] bumpCommanderJoinGeneration failed', err, { machineId })
    return undefined
  }
}

export async function getCommanderJoinGeneration(machineId: string): Promise<number | undefined> {
  try {
    const raw = await pub.get(commanderJoinGenerationKey(machineId))
    if (raw == null) return undefined
    const generation = Number(raw)
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : undefined
  } catch (err) {
    logger.error('[bus] getCommanderJoinGeneration failed', err, { machineId })
    return undefined
  }
}
