/**
 * Tiny localhost HTTP server for the Claude Code hook callbacks. `hook/notify.mjs` POSTs here on
 * SessionStart/SessionEnd (127.0.0.1:<PORT>). This replaces the old Fastify routes — the browser
 * UI is gone; only these two endpoints remain local.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { readCodexRolloutMeta } from './engines/codex/rollout.js'
import { hermesSessionSource } from './engines/hermes/reader.js'
import { launcherSessions, MACHINE_WS_PATH, type LauncherOpenInput } from './lib/launcherSessions.js'
import { isRecentlyDeleted } from './lib/deletedSessions.js'
import { registry, type RegisterInput, type RegisteredSession } from './lib/registry.js'
import { LOCAL_WEB_HTML } from './webui.js'
import { sid } from './lib/log.js'
import { VERSION } from './version.js'
import { env } from './config/env.js'
import { engineBin } from './lib/engineBin.js'
import { installHooksFor } from './lib/hooks.js'
import {
  SUPPORTED_PROTOCOLS, frameProtocol, isSupportedProtocol,
  type LauncherOpenFrame,
} from './lib/launcherProtocol.js'

export interface PairOutcome {
  status: number
  body: Record<string, unknown>
}

export interface HookServerHandlers {
  onRegistered: (entry: RegisteredSession, meta: { isNew: boolean; evicted: string | null; rebound: string | null; hookEvent?: string }) => void
  /** SessionEnd — the caller decides whether to forget (a `/clear` rotation keeps the pane's tile). */
  onSessionEnd: (sessionId: string, reason: string | undefined) => void
  /** A `harness <engine>` wrapper exited — drop every session bound to that machine id. */
  onLauncherClosed?: (launcherId: string) => void
  /**
   * A `harness <engine>` wrapper started. The frame cannot say WHICH session is in that pane — only the
   * engine's own hook knows that, and resuming an existing session fires no hook — so the caller uses
   * this to go look (see adoptResumedSessions). Without it, a resumed agent stays invisible.
   */
  onLauncherOpened?: (session: { launcherId: string; engine: RegisteredSession['engine']; tmuxPane: string; cwd?: string | null }) => void
  /** A turn is now running (Command Code's PreToolUse — its only live turn-open signal). Idempotent:
   *  it fires once per tool call, and every call after the first in a turn must be a no-op. */
  onTurnStart?: (body: { sessionId: string }) => void
  onToolStart?: (body: {
    sessionId: string
    toolUseId: string
    toolName: string
    input: unknown
  }) => void
  onTurnStop?: (body: {
    sessionId: string
    status?: string
    transcriptPath?: string
  }) => void
  /** `harness pair <code>` from a second CLI process: run CPace toward the waiting browser. */
  onPair?: (code: string) => Promise<PairOutcome>
  /** `adapter browser-link` — mint a setup-link token from the running daemon. */
  onSetupLink?: () => PairOutcome
  /** `harness pairings` — list E2EE-paired browsers. */
  onListPairs?: () => PairOutcome
  /** `harness unpair <id>` — unpair one browser (by fingerprint/prefix/index). */
  onRevoke?: (id: string) => PairOutcome
  /** `harness unpair --all` — unpair every browser. */
  onRevokeAll?: () => PairOutcome
  /** Local dashboard status snapshot (GET /api/status). */
  onStatus?: () => Record<string, unknown>
  /** Recent adapter log tail (GET /api/logs). */
  onLogs?: () => string
  /** Stop the adapter from the local dashboard (POST /api/stop). */
  onStop?: () => void
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(data))
  })
}

/**
 * Bind the localhost hook server on a FIXED `port` (no OS free-port fallback — a random fallback made
 * a leftover daemon un-findable by `lsof :<port>`). Rejects with EADDRINUSE if the port is taken (the
 * CLI reports it as "another adapter already running"). Resolves with the bound port.
 */
/** How long to keep waiting for an engine to write the transcript it just announced. */
const TRANSCRIPT_WAIT_MS = 500
const HERMES_KIND_TRIES = 6
const HERMES_KIND_WAIT_MS = 120
const TRANSCRIPT_WAIT_TRIES = 20

/**
 * Register once the announced transcript exists.
 *
 * Runs detached from the HTTP reply on purpose: this is a SessionStart hook, and the engine is blocked
 * until the response comes back. Bounded — an announcement whose file never appears is dropped, which is
 * the same outcome as before, just after giving the engine a fair chance to finish starting up.
 */
async function awaitTranscript(body: RegisterInput, handlers: HookServerHandlers): Promise<void> {
  for (let i = 0; i < TRANSCRIPT_WAIT_TRIES; i++) {
    await new Promise((resolve) => { const t = setTimeout(resolve, TRANSCRIPT_WAIT_MS); t.unref?.() })
    if (!launcherSessions.has(body.launcherId)) return           // the launcher left while we waited
    if (isRecentlyDeleted(body.sessionId)) return
    if (!body.transcriptPath || !existsSync(body.transcriptPath)) continue
    const result = registry.register(body)
    if (!result) return
    console.log(`[hooks] ${sid(result.entry.sessionId)} ${body.hookEvent ?? 'session-start'} · engine=${result.entry.engine}`
      + ` · isNew=${result.isNew} · after waiting ${((i + 1) * TRANSCRIPT_WAIT_MS) / 1000}s for its transcript`)
    handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound, hookEvent: body.hookEvent })
    return
  }
  console.warn(`[hooks] ${sid(body.sessionId ?? '?')} announced a transcript that never appeared: ${body.transcriptPath}`)
}

/**
 * Re-check a hermes session whose `sessions` row had not landed yet, then register it only if it turns
 * out to be the user's own CLI session. Bounded: if the row never appears we register anyway, which is
 * exactly the behaviour before this guard existed.
 */
async function awaitHermesKind(body: RegisterInput, handlers: HookServerHandlers): Promise<void> {
  const dbPath = join(env.HERMES_HOME, 'state.db')
  for (let i = 0; i < HERMES_KIND_TRIES; i++) {
    if (i > 0) await new Promise((resolve) => { const t = setTimeout(resolve, HERMES_KIND_WAIT_MS); t.unref?.() })
    if (!launcherSessions.has(body.launcherId)) return
    if (isRecentlyDeleted(body.sessionId)) return
    const source = await hermesSessionSource(dbPath, body.sessionId ?? '')
    if (source === null) continue
    if (source !== '' && source !== 'cli') {
      console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} ignored · hermes_subagent`)
      return
    }
    break
  }
  const result = registry.register(body)
  if (!result) return
  console.log(`[hooks] ${sid(result.entry.sessionId)} ${body.hookEvent ?? 'session-start'} · engine=hermes · isNew=${result.isNew} · after a source check`)
  handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound, hookEvent: body.hookEvent })
}

export function startHookServer(
  port: number,
  handlers: HookServerHandlers,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0]
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      // CSRF guard for mutating endpoints: a cross-origin browser page cannot set a custom header on a
      // simple request (it forces a CORS preflight we never allow), so only our same-origin dashboard
      // (and the CLI, which sends it too) can trigger actions. A local process could still call it —
      // same trust level as the CLI, which is acceptable on loopback.
      const localOk = req.headers['x-adapter-local'] === '1'

      // `protocols` is what a launcher gates on — two different BUILDS interoperate fine as long as they
      // share a protocol version, so `version` here is informational only (the stale-build notice).
      if (req.method === 'GET' && url === '/api/health') {
        json(200, { ok: true, version: VERSION, protocols: SUPPORTED_PROTOCOLS }); return
      }

      // Local dashboard (self-contained page) + its read-only status/logs.
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(LOCAL_WEB_HTML); return
      }
      if (req.method === 'GET' && url === '/api/status') {
        json(200, handlers.onStatus ? handlers.onStatus() : { supported: false }); return
      }
      if (req.method === 'GET' && url === '/api/logs') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(handlers.onLogs ? handlers.onLogs() : ''); return
      }
      if (req.method === 'POST' && url === '/api/stop') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        json(200, { ok: true }); handlers.onStop?.(); return
      }

      // SessionStart AND UserPromptSubmit both POST here (the catch hook re-registers so a session
      // whose SessionStart the adapter missed still shows up on its first prompt).
      if (req.method === 'POST' && url === '/api/hook/session-start') {
        let body: RegisterInput
        try { body = JSON.parse(await readBody(req)) as RegisterInput } catch { json(400, { error: 'bad json' }); return }
        // Every rejection below says WHY, out loud. They used to be silent, and a hook that arrives and
        // is dropped looks exactly like a hook that never fired — which is precisely the confusion behind
        // "the agent is running in my terminal but the list does not show it".
        const ignore = (reason: string): void => {
          console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} ignored · ${reason}`)
          json(200, { ignored: true, reason })
        }
        if (!body.tmuxPane) { ignore('not_in_tmux'); return }
        // Machine-launched only: a session with no LIVE machine id is not an agent. This is what makes
        // lifetime deterministic — a CLI the user started outside `harness <engine>` is ignored here,
        // exactly like a non-tmux one above.
        if (!launcherSessions.has(body.launcherId)) { ignore('no_machine_id'); return }
        // Deleting an agent no longer kills its pane, so the engine lives on for a moment and its catch
        // hook still fires — and this endpoint only checks that the LAUNCHER is alive, which it is. Without
        // this the tile the user just deleted re-registers itself and comes back.
        if (isRecentlyDeleted(body.sessionId)) { ignore('deleted'); return }
        if (body.engine === 'codex' && body.transcriptPath && readCodexRolloutMeta(body.transcriptPath)?.isSubagent) {
          ignore('codex_subagent')
          return
        }
        // Same story for hermes, which reaches here through its own hooks rather than a transcript file:
        // every delegated sub-agent is a hermes session that runs those hooks from the parent's pane.
        if (body.engine === 'hermes' && body.sessionId) {
          // Settled off the HTTP path entirely: the answer needs a SQLite read, and the row may not even
          // be written yet (measured: a child's hook beat its own INSERT by 110ms). Registering
          // optimistically would hand the parent's pane to a sub-agent.
          json(200, { pending: true })
          void awaitHermesKind(body, handlers)
          return
        }
        let result = registry.register(body)
        if (!result && body.transcriptPath && !existsSync(body.transcriptPath)) {
          // The engine announced the session BEFORE writing its transcript. Measured on claude: the hook
          // arrived at 13:03:31 and the file appeared at 13:03:34, so registration was refused (a session
          // is only accepted with a real file behind it) and the agent stayed off the list until something
          // else noticed it. Wait for the file instead of dropping the announcement — in the background,
          // because a SessionStart hook blocks the CLI that is waiting on this reply.
          json(200, { pending: true })
          void awaitTranscript(body, handlers)
          return
        }
        if (!result) {
          console.warn(`[hooks] ${sid(body.sessionId ?? '?')} REJECTED · engine=${body.engine} pane=${body.tmuxPane} machine=${sid(body.launcherId ?? '?')}`)
          json(400, { error: 'invalid session registration' })
          return
        }
        console.log(`[hooks] ${sid(result.entry.sessionId)} ${body.hookEvent ?? 'session-start'} · engine=${result.entry.engine} · isNew=${result.isNew}`)
        handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound, hookEvent: body.hookEvent })
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/session-end') {
        let body: { sessionId?: string; reason?: string }
        try { body = JSON.parse(await readBody(req)) as { sessionId?: string; reason?: string } } catch { json(400, { error: 'bad json' }); return }
        if (body.sessionId) {
          console.log(`[hooks] ${sid(body.sessionId)} session-end${body.reason ? ` · reason=${body.reason}` : ''}`)
          handlers.onSessionEnd(body.sessionId, body.reason)
        }
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/tool-start') {
        let body: { sessionId?: string; toolUseId?: string; toolName?: string; input?: unknown }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (body.sessionId && body.toolUseId && body.toolName) {
          console.log(`[hooks] ${sid(body.sessionId)} tool-start · tool=${body.toolName}`)
          handlers.onToolStart?.({
            sessionId: body.sessionId,
            toolUseId: body.toolUseId,
            toolName: body.toolName,
            input: body.input,
          })
        }
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/turn-start') {
        let body: { sessionId?: string }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (body.sessionId) handlers.onTurnStart?.({ sessionId: body.sessionId })
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/turn-stop') {
        let body: { sessionId?: string; status?: string; transcriptPath?: string }
        try { body = JSON.parse(await readBody(req)) as typeof body } catch { json(400, { error: 'bad json' }); return }
        if (body.sessionId) {
          console.log(`[hooks] ${sid(body.sessionId)} turn-stop${body.status ? ` · status=${body.status}` : ''}`)
          handlers.onTurnStop?.({
            sessionId: body.sessionId,
            status: body.status,
            transcriptPath: body.transcriptPath,
          })
        }
        json(200, { ok: true })
        return
      }

      // `harness pair <code>` → run CPace toward the browser that is waiting to pair. Long-polls until
      // the handshake completes/fails (bounded by the manager's round timers). Loopback-only; the PAKE
      // itself is the security (a local process can trigger, but only the real code completes pairing).
      if (req.method === 'POST' && url === '/api/pair') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onPair) { json(503, { error: 'PAIRING_UNAVAILABLE' }); return }
        let body: { code?: string }
        try { body = JSON.parse(await readBody(req)) as { code?: string } } catch { json(400, { error: 'bad json' }); return }
        if (!body.code) { json(400, { error: 'MISSING_CODE' }); return }
        try { const out = await handlers.onPair(body.code); json(out.status, out.body) }
        catch (e) { json(500, { error: e instanceof Error ? e.message : 'INTERNAL' }) }
        return
      }

      // `adapter browser-link` → mint a one-time setup token using the running daemon's E2EE manager
      // so the nonce is immediately consumable by this process.
      if (req.method === 'POST' && url === '/api/e2ee/setup-link') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onSetupLink) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = handlers.onSetupLink(); json(out.status, out.body); return
      }

      // `harness pairings` — list paired browsers.
      if (req.method === 'GET' && url === '/api/pairs') {
        if (!handlers.onListPairs) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = handlers.onListPairs(); json(out.status, out.body); return
      }

      // `harness unpair <id>` — unpair one browser; signals it (if online) to re-pair.
      if (req.method === 'POST' && url === '/api/revoke') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onRevoke) { json(503, { error: 'UNAVAILABLE' }); return }
        let body: { id?: string }
        try { body = JSON.parse(await readBody(req)) as { id?: string } } catch { json(400, { error: 'bad json' }); return }
        if (!body.id) { json(400, { error: 'MISSING_ID' }); return }
        const out = handlers.onRevoke(body.id); json(out.status, out.body); return
      }

      // `harness unpair --all` — unpair every browser.
      if (req.method === 'POST' && url === '/api/revoke-all') {
        if (!localOk) { json(403, { error: 'FORBIDDEN' }); return }
        if (!handlers.onRevokeAll) { json(503, { error: 'UNAVAILABLE' }); return }
        const out = handlers.onRevokeAll(); json(out.status, out.body); return
      }

      json(404, { error: 'not found' })
    })()
  })

  attachLauncherWs(server, handlers, port)

  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      // FIXED port — no OS-assigned fallback. A free-port fallback made the daemon land on an
      // unpredictable port, so a leftover/zombie couldn't be found by `lsof :<port>`. On a clash we
      // fail loudly with the exact port instead (the CLI turns this into a clear "already running?").
      if (err.code === 'EADDRINUSE') {
        console.error(`[hooks] 127.0.0.1:${port} is already in use — another adapter is probably running.`)
        console.error(`        Stop it:  harness stop      or find it:  lsof -ti :${port} | xargs kill`)
      } else {
        console.error('[hooks] listen failed:', err)
      }
      reject(err)
    })
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port
      console.log(`[hooks] listening on 127.0.0.1:${actual} (SessionStart/SessionEnd callbacks)`)
      resolve({ server, port: actual })
    })
  })
}

// ── machine launcher socket ────────────────────────────────────────────────────────────────────────
/** How often the daemon pings an idle launcher socket. */
const PING_MS = 10_000
/**
 * Missed pongs tolerated before a socket is considered dead.
 *
 * NOT 1. The sibling web/device hubs shipped a "one missed pong ⇒ terminate" rule and it killed sockets
 * that were perfectly alive (a single slow tick under load was enough); sessions died in the 40-60s band
 * for no reason. Three misses (~30s) is slow enough to ride out a stall and still far faster than the
 * `ps` polling this replaced.
 */
const MAX_MISSED_PONGS = 3

/**
 * Attach the launcher WebSocket to the existing hook server (same fixed loopback port — no new port, no
 * firewall change). The socket carries only session lifetime: `{t:'open'}` on connect, and the CLOSE
 * event is the end-of-session signal. Terminal I/O is not streamed; the adapter still drives the pane
 * through tmux.
 */
function attachLauncherWs(server: http.Server, handlers: HookServerHandlers, port: number): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    // A browser page CAN open a WebSocket to loopback, and unlike fetch() it cannot be stopped by a
    // custom-header check — but it always sends `Origin`. Our CLI never does. Rejecting any upgrade that
    // carries one is the WS-side equivalent of the `x-adapter-local` gate on the mutating HTTP routes.
    if (path !== MACHINE_WS_PATH || req.headers.origin) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleLauncherSocket(ws, handlers, port))
  })

}

function handleLauncherSocket(ws: WebSocket, handlers: HookServerHandlers, port: number): void {
  let missed = 0
  const ping = setInterval(() => {
    if (missed >= MAX_MISSED_PONGS) {
      console.log('[machine] launcher socket unresponsive — terminating')
      try { ws.terminate() } catch { /* already gone */ }
      return
    }
    missed++
    try { ws.ping() } catch { /* already gone */ }
  }, PING_MS)
  ping.unref?.()
  ws.on('pong', () => { missed = 0 })

  const send = (frame: unknown): void => { try { ws.send(JSON.stringify(frame)) } catch { /* gone */ } }

  ws.on('message', (raw) => {
    let msg: LauncherOpenFrame
    try { msg = JSON.parse(raw.toString()) as LauncherOpenFrame } catch { return }
    if (msg.t !== 'open') return

    // Protocol first: a launcher we cannot understand must be told so explicitly, because everything
    // below (and the whole session) would otherwise fail silently while its socket stayed happily open.
    const v = frameProtocol(msg)
    if (!isSupportedProtocol(v)) {
      console.warn(`[machine] launcher speaks protocol v${v}; this daemon serves ${SUPPORTED_PROTOCOLS.join(',')}`)
      send({ t: 'error', reason: 'unsupported_protocol', supported: SUPPORTED_PROTOCOLS })
      try { ws.close() } catch { /* ignore */ }
      return
    }

    const opened = launcherSessions.open(msg as LauncherOpenInput, ws)
    if (!opened) {
      console.warn('[machine] rejected launcher socket: invalid open payload')
      send({ t: 'error', reason: 'invalid_open' })
      try { ws.close() } catch { /* ignore */ }
      return
    }
    console.log(`[machine] open ${sid(opened.launcherId)} · engine=${opened.engine} · pane=${opened.tmuxPane}`
      + ` · protocol=v${v}${msg.version && msg.version !== VERSION ? ` · launcher build v${msg.version}` : ''}`)

    // Decided HERE, not in the launcher: both change between builds (hook definitions grow with every
    // engine; the binary for an engine can be renamed — `commandcode` → `cmd` already happened). A
    // long-lived launcher from an older build would otherwise install stale hooks and spawn a stale
    // binary name, so the daemon — always the newest build — owns both.
    let hooksReady = false
    if (!env.DISABLE_HOOK_INSTALL) {
      try { installHooksFor(opened.engine, port); hooksReady = true } catch { /* launcher falls back */ }
    }
    send({ t: 'opened', v, version: VERSION, bin: engineBin(opened.engine), hooksReady })
    // After the ack: adopting a resumed session reads tmux + ps, and the launcher is waiting on this
    // reply to spawn the engine.
    handlers.onLauncherOpened?.({
      launcherId: opened.launcherId, engine: opened.engine, tmuxPane: opened.tmuxPane, cwd: opened.cwd ?? null,
    })
  })

  const end = (): void => {
    clearInterval(ping)
    // Only evict if THIS socket still owns the id — a reconnect may already have replaced it.
    const launcherId = launcherSessions.closeBySocket(ws)
    if (!launcherId) return
    console.log(`[machine] close ${sid(launcherId)} — launcher socket gone`)
    handlers.onLauncherClosed?.(launcherId)
  }
  ws.on('close', end)
  ws.on('error', end)
}
