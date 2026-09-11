import http from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import type { Socket } from 'net'
import type { Duplex } from 'stream'
import httpProxy from 'http-proxy'
import { env } from '../config/env.js'
import { prisma } from './prisma.js'
import { getCachedAppAgent, setCachedAppAgent } from './appTargetCache.js'
import { getAppInstance, getMeshEndpoint, setMeshEndpoint } from './bus.js'
import { INSTANCE_ID, MESH_PORT, MESH_ENDPOINT } from './instance.js'
import { tunnelHttp, tunnelWs } from './appTunnel.js'
import { logger } from '../utils/logger.js'
import { ensureMachineReady, MachineWakeError } from './machineLifecycle.js'

// Filled alongside the positive subdomain cache. A hot public app should not need a second Mongo
// Machine lookup on every request just to recover the managerId needed for cold-start.
const managerByAgentId = new Map<string, string>()

/**
 * PUBLIC subdomain reverse-proxy (its own :PORT_APP_PROXY listener). Routing = the SUBDOMAIN from the
 * Host header (NO api key — public app traffic). `[sub].<APP_DOMAIN_SUFFIX>` → the `subdomains` record →
 * owning machineId → tunnelled over that agent's manager socket to the container app (see lib/appTunnel.ts).
 *
 * Phase 2 mesh: if this instance does NOT hold the agent's app manager-socket, the request is forwarded
 * over an internal mesh connection to the instance that does (agent:{machineId}:appinst → inst:{id}:mesh),
 * so the data path is a direct backpressured socket instead of a Redis relay. Falls back to the Redis
 * tunnel (appTunnel redis-mode) when affinity/endpoint is unknown.
 */

/** Strip APP_DOMAIN_SUFFIX from a Host header to get the subdomain label. */
export function hostToSubdomain(host: string | undefined): string | undefined {
  if (!host) return undefined
  const h = host.split(':')[0].toLowerCase() // drop any port
  const suffix = env.APP_DOMAIN_SUFFIX.toLowerCase()
  if (h.endsWith(suffix) && h.length > suffix.length) return h.slice(0, -suffix.length)
  return undefined
}

/** subdomain → owning machineId (the tunnel routes app traffic by machineId), or undefined if unknown. */
export async function agentForSubdomain(subdomain: string): Promise<string | undefined> {
  const cached = getCachedAppAgent(subdomain)
  if (cached !== undefined) return cached ?? undefined // string = hit; null = cached-missing → NO_APP, no DB
  const record = await prisma.subdomain.findUnique({ where: { subdomain } })
  setCachedAppAgent(subdomain, record?.machineId ?? null) // cache positive OR negative (unknown subdomain)
  if (record) managerByAgentId.set(record.machineId, record.managerId)
  return record?.machineId
}

// Forward proxy to a peer instance's mesh endpoint (direct socket, native backpressure — no Redis).
const meshProxy = httpProxy.createProxyServer({ ws: true, xfwd: true })
meshProxy.on('error', (err: Error, _req: IncomingMessage, res: ServerResponse | Socket) => {
  logger.warn('mesh forward error', { error: err.message })
  if (res instanceof http.ServerResponse) { if (!res.headersSent) res.writeHead(502); res.end('mesh unreachable') }
  else { try { res.destroy() } catch { /* ignore */ } }
})

function denyHttp(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ success: false, error: { code, message } }))
}

function denyWs(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } catch { /* ignore */ }
  socket.destroy()
}

async function wakeApp(machineId: string, subdomain: string): Promise<void> {
  // Billing state can change while a subdomain target stays cached. Re-read the binding before every
  // cold-start so a just-suspended machine cannot be woken through an old app route.
  const binding = await prisma.machine.findUnique({ where: { machineId: machineId } })
  if (!binding || binding.deletedAt || binding.billingStatus === 'pending' || binding.billingStatus === 'suspended' || !binding.managerId) {
    throw new Error('machine binding unavailable')
  }
  managerByAgentId.set(machineId, binding.managerId)
  await ensureMachineReady(binding, { subdomain })
}

/**
 * Resolve the mesh endpoint of the instance that holds this agent's app socket, IF it's a DIFFERENT
 * instance and mesh is enabled. undefined ⇒ handle locally / via Redis tunnel here.
 */
async function peerMeshFor(machineId: string): Promise<string | undefined> {
  if (!env.MESH_ENABLED) return undefined
  const inst = await getAppInstance(machineId)
  if (!inst || inst === INSTANCE_ID) return undefined
  const endpoint = await getMeshEndpoint(inst)
  return endpoint ?? undefined
}

// allowForward=false on the mesh listener → a forwarded request handles here (this instance owns the
// socket), never bounces again.
function handleAppRequest(req: IncomingMessage, res: ServerResponse, allowForward: boolean): void {
  const sub = hostToSubdomain(req.headers.host)
  if (!sub) return denyHttp(res, 400, 'NO_SUBDOMAIN', 'Unknown host')
  void (async () => {
    const machineId = await agentForSubdomain(sub)
    if (!machineId) return denyHttp(res, 404, 'NO_APP', 'Unknown subdomain')
    try {
      await wakeApp(machineId, sub)
    } catch (err) {
      const timeout = err instanceof MachineWakeError && err.code === 'MACHINE_START_TIMEOUT'
      return denyHttp(res, timeout ? 504 : 503, timeout ? 'MACHINE_START_TIMEOUT' : 'MACHINE_START_FAILED', timeout ? 'Machine start timed out' : 'Machine could not be started')
    }
    if (allowForward) {
      const peer = await peerMeshFor(machineId)
      if (peer) { meshProxy.web(req, res, { target: `http://${peer}` }); return }
    }
    await tunnelHttp(req, res, machineId, sub)
  })().catch((err) => {
    logger.error('app-proxy request failed', err)
    if (!res.headersSent) denyHttp(res, 500, 'PROXY_ERROR', 'proxy error')
    else res.end()
  })
}

function handleAppUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, allowForward: boolean): void {
  const sub = hostToSubdomain(req.headers.host)
  if (!sub) { socket.destroy(); return }
  void (async () => {
    const machineId = await agentForSubdomain(sub)
    if (!machineId) { socket.destroy(); return }
    try {
      await wakeApp(machineId, sub)
    } catch (err) {
      const timeout = err instanceof MachineWakeError && err.code === 'MACHINE_START_TIMEOUT'
      denyWs(socket, timeout ? 504 : 503, timeout ? 'Gateway Timeout' : 'Service Unavailable')
      return
    }
    if (allowForward) {
      const peer = await peerMeshFor(machineId)
      if (peer) { meshProxy.ws(req, socket as Socket, head, { target: `http://${peer}` }); return }
    }
    await tunnelWs(req, socket, head, machineId, sub)
  })().catch((err) => {
    logger.error('app-proxy upgrade failed', err)
    socket.destroy()
  })
}

/** Start the dedicated public app-proxy on PORT_APP_PROXY. Returns the server for shutdown. */
export function startSubdomainProxy(): http.Server {
  const server = http.createServer((req, res) => handleAppRequest(req, res, true))
  server.on('upgrade', (req, socket, head) => handleAppUpgrade(req, socket, head, true))
  server.listen(env.PORT_APP_PROXY, '0.0.0.0', () => {
    logger.info(`backend subdomain app-proxy listening on ${env.PORT_APP_PROXY}`, { suffix: env.APP_DOMAIN_SUFFIX })
  })
  return server
}

/**
 * Start the INTERNAL mesh listener (Phase 2). A peer instance forwards a public app request here when
 * THIS instance holds the agent's app socket; we handle it locally (allowForward=false). Advertises this
 * instance's endpoint in Redis so peers can find it. No-op when MESH_ENABLED is false.
 */
export function startMeshProxy(): http.Server | undefined {
  if (!env.MESH_ENABLED) return undefined
  const server = http.createServer((req, res) => handleAppRequest(req, res, false))
  server.on('upgrade', (req, socket, head) => handleAppUpgrade(req, socket, head, false))
  server.listen(MESH_PORT, '0.0.0.0', () => {
    logger.info(`backend mesh listener on ${MESH_PORT}`, { instance: INSTANCE_ID, endpoint: MESH_ENDPOINT })
  })
  const advertise = (): void => { void setMeshEndpoint(INSTANCE_ID, MESH_ENDPOINT, 30) }
  advertise()
  setInterval(advertise, 15_000).unref?.()
  return server
}
