/** Harness-only RPC extensions. The shared, pinned crypto core remains byte-identical across clients.
 * Both the originating machine relay and receiving daemon use these classifications. Older clients
 * do not send these frames; older targets answer UNSUPPORTED before any command is attempted.
 *
 * ONE place for every extension: the grid fleet RPCs (#90), harness sharing (`SHARE_*`) and CLI-to-CLI
 * viewer forwarding (`VIEWER_DOWN_TYPES`, #85). A type listed in none of these travels plaintext, and
 * the two callers (relayClient's wrap, backendSocket's unwrap and reply) must agree — they used to
 * spell the union inline, in three places, and merging two of these features meant merging the spelling.
 */
import { ENCRYPTED_RPC_RESULT_TYPES, isEncryptedDownType } from './core.js'
import { SHARE_REQUEST_TYPES, SHARE_RESULT_TYPES } from '../../sharing/protocol.js'
import { VIEWER_DOWN_TYPES } from '../viewerWire.js'

const FLEET_REQUESTS = new Set(['grid_fleet_capabilities', 'grid_fleet_run', 'grid_fleet_cancel'])
const FLEET_RESULTS = new Set([...FLEET_REQUESTS].map(type => `${type}_result`))
export const encryptDownFrame = (type: string): boolean =>
  isEncryptedDownType(type) || FLEET_REQUESTS.has(type) || SHARE_REQUEST_TYPES.has(type) || VIEWER_DOWN_TYPES.has(type)
export const encryptRpcResult = (type: string): boolean =>
  ENCRYPTED_RPC_RESULT_TYPES.has(type) || FLEET_RESULTS.has(type) || SHARE_RESULT_TYPES.has(type)
