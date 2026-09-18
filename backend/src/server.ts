import 'dotenv/config'
import cors from '@fastify/cors'
import Fastify from 'fastify'
import http from 'http'
import net from 'net'
import { env } from './config/env.js'
import { registerJsonBodyParser } from './lib/jsonBodyParser.js'
import { errorHandler } from './middlewares/errorHandler.js'
import { registerAuthMiddleware } from './middlewares/authMiddleware.js'
import { cursorRoutes } from './routes/cursor.js'
import { voiceRoutes } from './routes/voice.js'
import { harnessShareRoutes } from './routes/harnessShares.js'
import { handleObserverUpgrade } from './lib/observerWs.js'
import { deviceAuthRoutes } from './routes/deviceAuth.js'
import { healthRoutes, authRoutes, userRoutes, machineRoutes, planRoutes, gridRoutes, deviceRoutes, mobileRoutes, appRoutes, analyticsRoutes, agentRouteRoutes, storeRoutes } from './routes/index.js'
import { startSubdomainProxy, startMeshProxy } from './lib/subdomainProxy.js'
import { handleDeviceUpgrade } from './lib/deviceWs.js'
import { handleWebUpgrade } from './lib/webWs.js'
import { handleManagerUpgrade } from './lib/managerWs.js'
import { handleAdapterUpgrade } from './lib/adapterWs.js'
import { logger } from './utils/logger.js'
import { startTurnCredentialRefresh } from './lib/turnCredentials.js'
import { closeBus } from './lib/bus.js'
import { drainAllSockets, openSocketCount, RELEASE_UPGRADE_SLOT, type SlotSocket } from './lib/wsServer.js'

// Node ≥ 15 turns an unhandled rejection into a process exit. On a cluster worker that holds thousands of
// sockets, one DB/Redis hiccup inside a fire-and-forget promise would then drop every one of them and
// leave their presence keys as ghosts until TTL. Log it instead; `fireAndForget` (utils/async.ts) is the
// per-call-site fix, this is the net under it.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)))
})

// Handshakes in flight: each one holds a raw socket AND an outbound SSO profile call (5s timeout) before
// we know whether it is legitimate. Without a ceiling, a flood of junk tokens is a cheap way to pin file
// descriptors and outbound HTTP on this worker. Over the cap → 503 + Retry-After; a healthy client's
// reconnect backoff handles that fine.
const MAX_PENDING_UPGRADES = 500
const UPGRADE_HANDSHAKE_TIMEOUT_MS = 10_000
let pendingUpgrades = 0

// One http.Server fronts everything. Inverted transport: there is NO data-plane HTTP reverse-proxy
// anymore (web + device data ride the hub WS). HTTP is entirely the Fastify control API
// (auth / users / agents / health); WS upgrades are routed below (web-ws / manager-ws / commander-ws / voice).
const app = Fastify({
  logger: false,
  requestIdLogLabel: 'reqId',
  connectionTimeout: 120000,
  keepAliveTimeout: 72000,
  serverFactory: (handler) => {
    const server = http.createServer((req, res) => {
      handler(req, res)
    })
    server.on('upgrade', (req, socket, head) => {
      // Interactive low-latency channels (terminal PTY bytes, voice frames, control chat) — disable
      // Nagle's algorithm so small writes aren't held back up to ~40ms waiting to coalesce with more
      // data. Nothing in this codebase called setNoDelay() before, so every socket here defaulted to
      // Nagle-enabled.
      if (socket instanceof net.Socket) socket.setNoDelay(true)
      if (pendingUpgrades >= MAX_PENDING_UPGRADES) {
        try { socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') } catch { /* ignore */ }
        socket.destroy()
        return
      }
      pendingUpgrades++
      // The slot covers only the PRE-auth handshake (the expensive, unauthenticated phase: an open socket
      // plus one outbound SSO call). It is released the instant that phase settles — on a successful
      // upgrade (createWss fires RELEASE_UPGRADE_SLOT from the wss 'connection' event) or on the socket
      // dying (auth-fail destroy / ws.close) — NOT held for the connection's life or a fixed window, so a
      // burst of completed reconnects never starves new handshakes. The timer is only a backstop for a
      // handshake that neither completes nor closes (a hung peer mid-negotiation).
      let released = false
      const release = (): void => { if (!released) { released = true; pendingUpgrades-- } }
      ;(socket as SlotSocket)[RELEASE_UPGRADE_SLOT] = release
      socket.once('close', release)
      setTimeout(release, UPGRADE_HANDSHAKE_TIMEOUT_MS).unref()
      // A handshake that never completes (auth call hung, peer went silent) must not hold the socket.
      // `ws` resets the timeout to 0 once it completes the upgrade, so this only ever fires pre-upgrade.
      if (socket instanceof net.Socket) socket.setTimeout(UPGRADE_HANDSHAKE_TIMEOUT_MS, () => socket.destroy())
      const path = (req.url ?? '').split('?')[0]
      if (path === '/api/observer-ws') {
        handleObserverUpgrade(req, socket, head)
        return
      }
      // Inverted-transport hub endpoints (terminated here, not proxied):
      //   /api/web-ws     — web clients (replaces the old proxied /proxy/api/ws)
      //   /api/manager-ws — managers dial in and multiplex all their agents
      if (path === '/api/web-ws') {
        handleWebUpgrade(req, socket, head)
        return
      }
      if (path === '/api/manager-ws') {
        handleManagerUpgrade(req, socket, head)
        return
      }
      // Remote-machine adapters (machine-adapter CLI) dial in and play the node role for their agent.
      if (path === '/api/adapter-ws') {
        handleAdapterUpgrade(req, socket, head)
        return
      }
      // Device WS: TERMINATE + relay (per-user; we sniff voice frames for STT). Auth is the owner's
      // SSO access token as the first subprotocol, plus a required `?computer=` id.
      if (path === '/api/device-ws') {
        handleDeviceUpgrade(req, socket, head)
        return
      }
      // Inverted transport: all WS is now terminated above (web-ws / manager-ws / commander-ws / voice).
      // Nothing is reverse-proxied over WS anymore (REST still rides /proxy → handleProxyRequest).
      socket.destroy()
    })
    return server
  },
})

async function start(): Promise<void> {
  // Mint the Cloudflare TURN credential before the first socket lands; no-op when TURN is unconfigured.
  startTurnCredentialRefresh()

  app.setErrorHandler(errorHandler)

  registerJsonBodyParser(app)

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    if (env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
  })

  // Allow all origins (reflect the request origin so credentialed requests work too). Methods +
  // headers are reflected (allowedHeaders omitted → echoes Access-Control-Request-Headers), so any
  // client header (Authorization, x-api-key, …) passes preflight.
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  })

  // SSO access-token gate for the control API (data-plane auth happens before Fastify).
  registerAuthMiddleware(app)

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(userRoutes)
  await app.register(machineRoutes)
  await app.register(planRoutes)
  await app.register(gridRoutes) // the account's private harness grid name
  await app.register(deviceRoutes)
  await app.register(mobileRoutes)
  await app.register(appRoutes)
  await app.register(analyticsRoutes)
  await app.register(agentRouteRoutes) // which agent a task belongs to — the prompt lives here, not in the CLI
  await app.register(cursorRoutes)   // standalone STT + LLM for the Cursor desktop app (self-contained)
  // The cabled dial's transcription, authenticated by the caller's SSO token rather than a shared secret.
  // Absent from the auth middleware's skip-list on purpose: that absence IS the gate.
  await app.register(voiceRoutes)
  await app.register(deviceAuthRoutes) // device-authorization grant: how the desktop app gets a machine key
  await app.register(storeRoutes)      // the Harness Store's ratings and reviews; the catalogue is the CLI's registry
  await app.register(harnessShareRoutes)

  // Dedicated public subdomain app-proxy on its own port (Host-header routed → tunnelled to the node app).
  const appProxyServer = startSubdomainProxy()
  // Internal mesh listener (Phase 2, MESH_ENABLED) — peers forward here when this instance owns the socket.
  const meshServer = startMeshProxy()

  let shuttingDown = false
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`Received ${signal}, shutting down...`, { openSockets: openSocketCount() })
    try {
      appProxyServer.close()
      meshServer?.close()
      // Start Fastify's close (it tells the http server to stop accepting new connections) but DON'T await
      // it yet: http.Server#close only resolves once every connection has ended, and an upgraded WebSocket
      // is a connection that never ends on its own — so awaiting here would hang until clients happened to
      // disconnect, and the drain below would never run.
      const fastifyClosed = app.close().catch((err) => logger.error('fastify close error', err))
      // Now end the WebSockets (invisible to http.Server#close), which is what lets fastifyClosed settle.
      await drainAllSockets()
      // Sockets terminated at the end of the drain fire their 'close' handler on the next tick, and those
      // handlers clear presence/owner keys as fire-and-forget Redis writes. Let them land before closeBus
      // quits the connection, else a half-open socket's key survives on TTL alone.
      await new Promise((resolve) => setTimeout(resolve, 250))
      // Bounded wait for Fastify to finish (onClose hooks, Prisma disconnect); never block shutdown on it.
      await Promise.race([fastifyClosed, new Promise((resolve) => setTimeout(resolve, 5_000))])
      await closeBus()
      process.exit(exitCode)
    } catch (err) {
      logger.error('Error during shutdown', err)
      process.exit(1)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // Truly unrecoverable: drain politely so clients reconnect elsewhere, then let PM2/k8s restart us.
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException — draining', err)
    void shutdown('uncaughtException', 1)
    setTimeout(() => process.exit(1), 8_000).unref()
  })

  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  logger.info(`backend listening on ${env.PORT}`)
}

start().catch((err) => {
  logger.error('Failed to start backend', err)
  process.exit(1)
})
