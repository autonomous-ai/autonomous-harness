import { deviceService } from '../services/index.js'
import { pushDeviceRevoked } from './hub.js'
import { publishDeviceControl } from './bus.js'
import { logger } from '../utils/logger.js'

/**
 * Revoke one of a user's devices and tell it, on every channel that can reach it.
 *
 * Extracted because there are now TWO callers (the web's `/api/devices/:id` and the mobile group's
 * own DELETE) and the three steps are not optional:
 *
 *  1. delete the binding, which is what makes the next connect fail;
 *  2. push `device_revoked` on EVERY machine of the owner — a per-user device is attached under
 *     whichever machine it currently has selected, and only the socket holding it delivers;
 *  3. push on the devctl channel too, which covers a device parked on the machine PICKER (no hub
 *     attach at all) and closes the socket, so even firmware that ignores the frame falls into its
 *     reconnect → 401 → re-pair path.
 *
 * A second copy of this that forgot step 2 or 3 would leave a revoked device holding a live socket,
 * which is exactly the bug this function exists to make impossible.
 *
 * Returns false when the device is not this user's (or does not exist) — callers answer 404.
 */
export async function revokeDeviceForUser(deviceId: string, userId: string): Promise<boolean> {
  const revoked = await deviceService.revoke(deviceId, userId)
  if (!revoked) return false
  for (const machineId of revoked.machineIds) pushDeviceRevoked(machineId, revoked.deviceId)
  // Duplicate delivery is harmless — the first frame reboots the device.
  void publishDeviceControl(revoked.deviceId, { action: 'revoked' })
  logger.info('device revoked', { deviceId: revoked.deviceId, machines: revoked.machineIds.length, by: userId })
  return true
}
