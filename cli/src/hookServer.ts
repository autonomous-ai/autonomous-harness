/**
 * Tiny localhost HTTP server for the Claude Code hook callbacks. `hook/notify.mjs` POSTs here on
 * SessionStart/SessionEnd (127.0.0.1:<PORT>). This replaces the old Fastify routes — the browser
 * UI is gone; only these two endpoints remain local.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readCodexRolloutMeta } from './engines/codex/rollout.js'
import { hermesSessionSource } from './engines/hermes/reader.js'
import { isRecentlyDeleted } from './lib/deletedSessions.js'
import { registry, type RegisterInput, type RegisteredSession } from './lib/registry.js'
import { LOCAL_WEB_HTML } from './webui.js'
import { sid } from './lib/log.js'
import { VERSION } from './version.js'
import { env } from './config/env.js'
import { hookCredentialMatches, loadOrCreateHookCredential } from './lib/hookAuth.js'
import type { HookTerminalHint } from './lib/terminalTypes.js'
import { ENGINES, type AgentEngine } from './engines/types.js'

export interface PairOutcome {
  status: number
  body: Record<string, unknown>
}

export interface HookServerHandlers {
  onRegistered: (entry: RegisteredSession, meta: { isNew: boolean; evicted: string | null; rebound: string | null; hookEvent?: string }) => void
  /** SessionEnd — a reconciliation hint only; it is never process-lifetime authority. */
  onSessionEnd: (sessionId: string, reason: string | undefined) => void
  /** Ensure a matching process-owned agent exists before a hook binds its mutable engine session. */
  resolveHookAgent?: (session: {
    engine: RegisteredSession['engine']
    tmuxPane?: string
    runtimeHints: HookTerminalHint[]
    callerPid?: number
  }) => Promise<RegisteredSession | null>
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

const MAX_HOOK_BODY_BYTES = 256 * 1024
const HOOK_BODY_FIELDS = new Set([
  'engine', 'launcherId', 'sessionId', 'transcriptPath', 'cwd', 'source', 'tmuxPane', 'title', 'model',
  'cliVersion', 'runtimeHints', 'callerPid', 'hookEvent', 'pluginVersion', 'reason', 'status', 'toolUseId',
  'toolName', 'input',
])

function optionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || value === null || (typeof value === 'string'
    && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value))
}

function optionalBoundedJson(value: unknown, max: number): boolean {
  if (value === undefined) return true
  try { return Buffer.byteLength(JSON.stringify(value)) <= max } catch { return false }
}

function validHookBody(value: unknown): value is BoundHookBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((field) => !HOOK_BODY_FIELDS.has(field))) return false
  if (body.engine !== undefined && (typeof body.engine !== 'string' || !ENGINES.includes(body.engine as AgentEngine))) return false
  if (!optionalBoundedString(body.launcherId, 200)
    || !optionalBoundedString(body.sessionId, 200)
    || !optionalBoundedString(body.transcriptPath, 4_096)
    || !optionalBoundedString(body.cwd, 4_096)
    || !optionalBoundedString(body.source, 1_000)
    || !optionalBoundedString(body.tmuxPane, 32)
    || !optionalBoundedString(body.title, 1_000)
    || !optionalBoundedString(body.model, 200)
    || !optionalBoundedString(body.cliVersion, 200)
    || !optionalBoundedString(body.hookEvent, 100)
    || !optionalBoundedString(body.pluginVersion, 100)
    || !optionalBoundedString(body.reason, 500)
    || !optionalBoundedString(body.status, 100)
    || !optionalBoundedString(body.toolUseId, 200)
    || !optionalBoundedString(body.toolName, 200)
    || !optionalBoundedJson(body.input, 128 * 1024)) return false
  if (body.callerPid !== undefined
    && (!Number.isSafeInteger(body.callerPid) || (body.callerPid as number) <= 0)) return false
  if (body.runtimeHints !== undefined) {
    if (!Array.isArray(body.runtimeHints) || body.runtimeHints.length > 4) return false
    for (const value of body.runtimeHints) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const hint = value as Record<string, unknown>
      if (hint.backend === 'tmux') {
        if (Object.keys(hint).some((field) => field !== 'backend' && field !== 'paneId')
          || typeof hint.paneId !== 'string' || !/^%\d+$/.test(hint.paneId)) return false
      } else if (hint.backend === 'herdr') {
        if (Object.keys(hint).some((field) => !['backend', 'paneId', 'sessionName', 'socketPath'].includes(field))
          || !optionalBoundedString(hint.paneId, 200) || !hint.paneId
          || !optionalBoundedString(hint.sessionName, 64)
          || !optionalBoundedString(hint.socketPath, 4_096)) return false
      } else return false
    }
  }
  return true
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    let bytes = 0
    let oversized = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_HOOK_BODY_BYTES) { oversized = true; data = ''; return }
      data += chunk
    })
    req.on('end', () => resolve(oversized ? '' : data))
    req.on('error', () => resolve(''))
  })
}

function normalizedRuntimeHints(body: RegisterInput): HookTerminalHint[] {
  const hints: HookTerminalHint[] = []
  if (Array.isArray(body.runtimeHints) && body.runtimeHints.length <= 4) {
    for (const hint of body.runtimeHints) {
      if (hint?.backend === 'tmux' && /^%\d+$/.test(hint.paneId)) hints.push({ backend: 'tmux', paneId: hint.paneId })
      if (hint?.backend === 'herdr'
        && typeof hint.paneId === 'string' && hint.paneId.length <= 200
        && (hint.sessionName === undefined || (typeof hint.sessionName === 'string' && hint.sessionName.length <= 64))
        && (hint.socketPath === undefined || (typeof hint.socketPath === 'string' && hint.socketPath.length <= 4_096))) {
        hints.push({
          backend: 'herdr', paneId: hint.paneId,
          ...(hint.sessionName ? { sessionName: hint.sessionName } : {}),
          ...(hint.socketPath ? { socketPath: hint.socketPath } : {}),
        })
      }
    }
  }
  if (body.tmuxPane && /^%\d+$/.test(body.tmuxPane)
    && !hints.some((hint) => hint.backend === 'tmux' && hint.paneId === body.tmuxPane)) {
    hints.push({ backend: 'tmux', paneId: body.tmuxPane })
  }
  return hints
}

type BoundHookBody = RegisterInput & {
  sessionId?: string
  reason?: string
  status?: string
  toolUseId?: string
  toolName?: string
  input?: unknown
}

async function verifiedBoundMutation(
  body: BoundHookBody,
  handlers: HookServerHandlers,
): Promise<RegisteredSession | null> {
  if (!body.sessionId || !body.engine) return null
  const runtimeHints = normalizedRuntimeHints(body)
  if (!runtimeHints.length) return null
  const processAgent = handlers.resolveHookAgent
    ? await handlers.resolveHookAgent({
      engine: body.engine,
      tmuxPane: body.tmuxPane,
      runtimeHints,
      callerPid: Number.isSafeInteger(body.callerPid) && body.callerPid! > 0 ? body.callerPid : undefined,
    })
    : body.tmuxPane ? registry.byPaneEngine(body.tmuxPane, body.engine) ?? null : null
  return processAgent?.engine === body.engine && processAgent.sessionId === body.sessionId
    ? processAgent
    : null
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

function registeredHookProcess(body: RegisterInput, engine: AgentEngine): RegisteredSession | undefined {
  if (body.processIdentity) {
    const processAgent = registry.byProcess(engine, body.processIdentity)
    if (processAgent) return processAgent
  }
  for (const runtime of body.runtimes ?? []) {
    const processAgent = registry.byRuntimeEngine(runtime, engine)
    if (processAgent) return processAgent
  }
  return body.tmuxPane ? registry.byPaneEngine(body.tmuxPane, engine) : undefined
}

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
    const engine = body.engine ?? 'claude'
    if (!registeredHookProcess(body, engine)) return
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
    if (!registeredHookProcess(body, 'hermes')) return
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
  const hookCredential = loadOrCreateHookCredential(env.ADAPTER_DATA_DIR)
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
      const hookOk = hookCredentialMatches(hookCredential, req.headers['x-harness-hook-token'])

      if (req.method === 'GET' && url === '/api/health') {
        json(200, { ok: true, version: VERSION }); return
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
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: RegisterInput
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        // Every rejection below says WHY, out loud. They used to be silent, and a hook that arrives and
        // is dropped looks exactly like a hook that never fired — which is precisely the confusion behind
        // "the agent is running in my terminal but the list does not show it".
        const ignore = (reason: string): void => {
          console.log(`[hooks] ${sid(body.sessionId ?? '?')} ${body.hookEvent ?? 'session-start'} ignored · ${reason}`)
          json(200, { ignored: true, reason })
        }
        const runtimeHints = normalizedRuntimeHints(body)
        if (!runtimeHints.length) { ignore('not_in_terminal'); return }
        // A plugin/extension is loaded ONCE per engine process, so a pane opened before an update keeps
        // running the old copy — silently, and for hours. Measured on amp: a pane started at 11:49 was
        // still writing transcripts with no tool calls long after the fix reached disk. The engines that
        // use shell hooks re-read the file on every call and cannot drift like this; these three can, so
        // they stamp their build and the mismatch is said out loud instead of being discovered later.
        const pluginVersion = (body as { pluginVersion?: unknown }).pluginVersion
        if (typeof pluginVersion === 'string' && pluginVersion && pluginVersion !== VERSION) {
          console.warn(`[hooks] ${sid(body.sessionId ?? '?')} ${body.engine ?? '?'} plugin is v${pluginVersion}`
            + ` but this machine is v${VERSION} — that pane loaded an older copy.`)
          console.warn('[hooks] restart the pane (or reload its plugins) to pick up the current build')
        }
        const engine = body.engine ?? 'claude'
        const processAgent = handlers.resolveHookAgent
          ? await handlers.resolveHookAgent({
            engine,
            tmuxPane: body.tmuxPane,
            runtimeHints,
            callerPid: Number.isSafeInteger(body.callerPid) && body.callerPid! > 0 ? body.callerPid : undefined,
          })
          : body.tmuxPane ? registry.byPaneEngine(body.tmuxPane, engine) ?? null : null
        if (!processAgent || processAgent.engine !== engine) { ignore('no_matching_engine_process'); return }
        // The process scanner is authoritative. Never accept a hook's legacy launcher id or a stale PID.
        body.processIdentity = processAgent.processIdentity ?? undefined
        body.runtimes = processAgent.runtimes
        body.primaryRuntimeKey = processAgent.primaryRuntimeKey
        // Deleting an agent no longer kills its pane, so the engine lives on for a moment and its catch
        // hook still fires — and the exact process may remain alive during SIGTERM grace. Without
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
          console.warn(`[hooks] ${sid(body.sessionId ?? '?')} REJECTED · engine=${body.engine} pane=${body.tmuxPane}`)
          json(400, { error: 'invalid session registration' })
          return
        }
        console.log(`[hooks] ${sid(result.entry.sessionId)} ${body.hookEvent ?? 'session-start'} · engine=${result.entry.engine} · isNew=${result.isNew}`)
        handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound, hookEvent: body.hookEvent })
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/session-end') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedBoundMutation(body, handlers)) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId) {
          console.log(`[hooks] ${sid(body.sessionId)} session-end${body.reason ? ` · reason=${body.reason}` : ''}`)
          handlers.onSessionEnd(body.sessionId, body.reason)
        }
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/tool-start') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedBoundMutation(body, handlers)) { json(403, { error: 'UNBOUND_HOOK' }); return }
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
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedBoundMutation(body, handlers)) { json(403, { error: 'UNBOUND_HOOK' }); return }
        if (body.sessionId) handlers.onTurnStart?.({ sessionId: body.sessionId })
        json(200, { ok: true })
        return
      }

      if (req.method === 'POST' && url === '/api/hook/turn-stop') {
        if (!hookOk) { json(401, { error: 'UNAUTHORIZED' }); return }
        let body: BoundHookBody
        try {
          const parsed = JSON.parse(await readBody(req)) as unknown
          if (!validHookBody(parsed)) { json(400, { error: 'invalid hook body' }); return }
          body = parsed
        } catch { json(400, { error: 'bad json' }); return }
        if (!await verifiedBoundMutation(body, handlers)) { json(403, { error: 'UNBOUND_HOOK' }); return }
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

      // `harness browser-link` → mint a reusable 7-day setup token using the running daemon's E2EE
      // identity. The signed token is self-contained, so it remains valid across daemon restarts.
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
