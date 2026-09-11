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
import { deviceAuthRoutes } from './routes/deviceAuth.js'
import { healthRoutes, authRoutes, userRoutes, machineRoutes, planRoutes, deviceRoutes, mobileRoutes, appRoutes, analyticsRoutes, agentRouteRoutes } from './routes/index.js'
import { startSubdomainProxy, startMeshProxy } from './lib/subdomainProxy.js'
import { handleDeviceUpgrade } from './lib/deviceWs.js'
import { handleWebUpgrade } from './lib/webWs.js'
import { handleManagerUpgrade } from './lib/managerWs.js'
import { handleAdapterUpgrade } from './lib/adapterWs.js'
import { logger } from './utils/logger.js'
import { startTurnCredentialRefresh } from './lib/turnCredentials.js'

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
      const path = (req.url ?? '').split('?')[0]
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

  // Dedicated public subdomain app-proxy on its own port (Host-header routed → tunnelled to the node app).
  const appProxyServer = startSubdomainProxy()
  // Internal mesh listener (Phase 2, MESH_ENABLED) — peers forward here when this instance owns the socket.
  const meshServer = startMeshProxy()

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`)
    try {
      appProxyServer.close()
      meshServer?.close()
      await app.close()
      process.exit(0)
    } catch (err) {
      logger.error('Error during shutdown', err)
      process.exit(1)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  logger.info(`backend listening on ${env.PORT}`)
}

start().catch((err) => {
  logger.error('Failed to start backend', err)
  process.exit(1)
})
