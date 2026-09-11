/**
 * Stable identity + mesh endpoint for THIS backend instance/worker (Phase 2 data-plane mesh).
 *
 * Under a pm2 cluster many workers share the public port but each is a separate process, so the mesh
 * listener must bind a DISTINCT internal port per worker (MESH_PORT_BASE + worker index). The instance
 * id must be unique per worker and stable for the process lifetime.
 */
import { hostname } from 'os'
import { env } from '../config/env.js'

// pm2 sets NODE_APP_INSTANCE to the 0-based worker index; a bare `node dist/server.js` has none → 0.
const WORKER_INDEX = Number(process.env.NODE_APP_INSTANCE ?? '0') || 0

/** Unique + stable id for this instance/worker (used as the value of agent:{machineId}:appinst). */
export const INSTANCE_ID = `${env.BACKEND_INSTANCE_ID || hostname()}-${WORKER_INDEX}`

/** This worker's internal mesh port + the endpoint advertised to peers (host:port). */
export const MESH_PORT = env.MESH_PORT_BASE + WORKER_INDEX
export const MESH_ENDPOINT = `${env.MESH_HOST}:${MESH_PORT}`
