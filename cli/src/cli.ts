#!/usr/bin/env node
/**
 * machine-adapter CLI (the `harness` command) — connect this computer to a "remote" agent.
 *
 * Terminology: the MACHINE *joins* a machine (`join <token>` → saved apiKey); a BROWSER
 * *pairs* with the computer for end-to-end encryption (`pair`/`unpair`/`pairings`, code + fingerprint).
 * Keeping "pair" for the browser relationship only avoids overloading the word across two trust relations.
 *
 *   harness join <token>    connect this computer to an existing remote machine. Later `harness join`
 *                           reconnects with the saved credential. `adapter unjoin` leaves + clears it.
 *
 * What runs: engine hooks/plugins (session metadata → localhost hook server → process registry),
 * transcript/store readers, tmux process discovery,
 * and the backend socket (events up / chat + RPCs down).
 */

import 'dotenv/config'
import { readFileSync, writeFileSync, mkdirSync, openSync, existsSync, rmSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { homedir } from 'os'
import { env } from './config/env.js'
import { VERSION } from './version.js'
import { registry, projectDisplayName, type RegisteredSession } from './lib/registry.js'
import { installAmpPlugin, installCodexHooks, installCommandCodeHooks, installCursorHooks, installDevinHooks, installGrokHooks, installHermesHooks, installKiloPlugin, installOpencodePlugin, installPiExtension, installSessionHooks } from './lib/hooks.js'
import { PID_FILE, TOKEN_FILE, daemonPort, isAlive, readPid } from './lib/daemonState.js'
import { ENGINE_CLI_COMMANDS, ENGINES } from './lib/engineBin.js'
import { clearDeleted, isRecentlyDeleted, markDeleted } from './lib/deletedSessions.js'
import { terminateDeletedAgent } from './lib/deleteAgentFallback.js'
import { findLiveSession } from './lib/sessionRepair.js'
import {
  sendToTmux,
  sendKeyToTmux,
  sendLiteralToTmux,
  validateSessionRuntime,
  checkSessionRuntime,
  captureTmuxPane,
  listPaneTitles,
} from './lib/tmux.js'
import { TmuxAgentReconciler, type DiscoveredTmuxAgent } from './lib/tmuxAgentDiscovery.js'
import { Watcher, type LineEvent } from './watcher/watcher.js'
import { startHookServer } from './hookServer.js'
import { BackendSocket } from './backendSocket.js'
import { lastTurnTextFromRawLines, lineToEvents, newTurnState, type LiveEvent, type TurnState } from './lib/normalize.js'
import { AskQuestionController, pollsQuestions, QuestionWatcher } from './lib/askQuestion.js'
import { CommanderMirror } from './lib/commander.js'
import {
  setSummaryPoolDeviceConnected,
  shutdownSummaryPool,
  summarizeTurnText,
  syncSummaryPoolSessions,
} from './lib/summarize.js'
import { setVoiceRouterDeviceConnected, setVoiceRouterSessions, shutdownVoiceRouter } from './lib/voiceRouter.js'
import { tailFile } from './lib/sessions.js'
import { E2eeStore } from './lib/e2ee/store.js'
import {
  startSelfUpdater, restore as restoreUpdate, confirm as confirmUpdate,
  fetchManifest, downloadVerified, canary, stage, semverGt,
  type Poller, type UpdateEntry,
} from './lib/selfUpdate.js'
import { stat } from 'fs/promises'
import { CodexNormalizer, codexTaskError, lastCodexTurnText } from './engines/codex/normalizer.js'
import { CursorNormalizer, lastCursorTurnText } from './engines/cursor/normalizer.js'
import { CursorTranscriptDiscovery, findCursorTranscript } from './engines/cursor/discovery.js'
import { CursorSubagentManager } from './engines/cursor/subagent.js'
import { CursorTaskHookQueue } from './engines/cursor/taskHookQueue.js'
import { loadCursorPendingTasks, removeCursorPendingTasks } from './engines/cursor/pendingTasks.js'
import { OpencodeReader, readOpencodeMessages } from './engines/opencode/reader.js'
import { lastOpencodeTurnText } from './engines/opencode/normalizer.js'
import { KiloReader, readKiloMessages } from './engines/kilo/reader.js'
import { lastKiloTurnText } from './engines/kilo/normalizer.js'
import { MuseNormalizer, lastMuseTurnText, museMessagesToEvents } from './engines/muse/normalizer.js'
import { AmpNormalizer, lastAmpTurnText, ampMessagesToEvents } from './engines/amp/normalizer.js'
import { GrokNormalizer, lastGrokTurnText } from './engines/grok/normalizer.js'
import { findGrokTranscript } from './engines/grok/session.js'
import { PiNormalizer, lastPiTurnText } from './engines/pi/normalizer.js'
import { HermesReader, readHermesMessages } from './engines/hermes/reader.js'
import { DevinReader, readDevinMessages } from './engines/devin/reader.js'
import { lastHermesTurnText } from './engines/hermes/normalizer.js'
import { lastDevinTurnText } from './engines/devin/normalizer.js'
import {
  CommandCodeNormalizer,
  commandCodeRunError,
  commandCodeRunErrorSummary,
  lastCommandCodeTurnText,
} from './engines/commandcode/normalizer.js'
import { SessionInputController } from './lib/sessionInput.js'
import { adaptSlashCommand } from './lib/goalCommand.js'
import { RuntimeProfileManager } from './lib/runtimeProfile.js'
import { RuntimeProfileController } from './lib/runtimeProfileController.js'
import { deviceErrorText } from './lib/deviceErrors.js'
import {
  installTimestampedConsole, sid, preview,
  prepareLogFile, trimLogFile, LOG_CHECK_INTERVAL_MS,
} from './lib/log.js'

// Claude's Stop hook fires when the agent finishes, but the transcript can lag a moment behind
// (docs: "the transcript file may lag behind the in-memory conversation"). Acting immediately races
// that flush → an empty recap + a premature close. So the Stop hook is a DELAYED fallback: poll, and
// only if the turn is still open after this grace + a re-poll do we force-close (by then the assistant
// text is on disk, so the natural close usually wins and the recap isn't empty).
const STOP_HOOK_GRACE_MS = 1_500

// Daemon stdout/stderr. Capped at LOG_MAX_BYTES — see prepareLogFile/trimLogFile in lib/log.ts.
const LOG_FILE = join(env.ADAPTER_DATA_DIR, 'machine.log')
// Pre-rename name. Adopted (renamed, keeping the inode) the first time a daemon opens the log, so a
// machine that updates mid-run keeps its history instead of stranding it in a file nobody tails.
const LEGACY_LOG_FILE = join(env.ADAPTER_DATA_DIR, 'adapter.log')
const COMPUTER_ID_FILE = join(env.ADAPTER_DATA_DIR, 'computer-id')
// The machine's display name, mirrored from the backend (`machine_meta` on connect + web renames) by the
// daemon so the separate `harness status` process can print it. Absent = unnamed machine.
const MACHINE_NAME_FILE = join(env.ADAPTER_DATA_DIR, 'machine-name')
// OpenCode's SQLite store — polled per session by OpencodeReader (no per-session transcript file).
const OPENCODE_DB = join(env.OPENCODE_DATA_DIR, 'opencode.db')
// Kilo's SQLite store — same shape, its own file and its own reader (see engines/kilo/).
const KILO_DB = join(env.KILO_DATA_DIR, 'kilo.db')
// Hermes keeps every surface's history in one SQLite store — polled per session by HermesReader.
const HERMES_DB = join(env.HERMES_HOME, 'state.db')
// Devin likewise keeps all history in one SQLite store (WAL) — polled per session by DevinReader.
const DEVIN_DB = join(env.DEVIN_HOME, 'sessions.db')

// How long `harness start` waits for the background daemon to report "[backend] connected" before
// declaring an error. A healthy backend connects in well under this; a timeout ⇒ unreachable.
const CONNECT_WAIT_MS = 10_000

/** Between session-binding attempts for a process whose engine store is not resolvable yet. */
const REPAIR_RETRY_MS = 60_000
/** A NEW process is waiting for a session that is about to appear. Muse makes
 *  this concrete — its session is only claimable once the user has typed, because a file with no turn in
 *  it cannot be told apart from the ones muse opens for itself. Backing off a full minute there costs the
 *  FIRST message: the pane answers while web and device show nothing. So keep sweeping for a while first,
 *  then settle into the slow rhythm for processes that will never resolve. */
const REPAIR_EAGER_ATTEMPTS = 24   // ≈2 min at the 5s sweep

function usage(): never {
  console.log(`harness v${VERSION} — connect this computer to your machine

Agents — after "harness join", run the vendor CLI directly inside tmux. Harness discovers supported
top-level processes automatically; it does not launch them or change their permission flags:
${ENGINES.map((engine) => `  ${ENGINE_CLI_COMMANDS[engine]}`).join('\n')}

Machine:
  harness join <token>         connect this computer to an existing machine using the token from its machine page
  harness join                 reconnect with the saved credential
  harness join -f              run in the FOREGROUND (for a supervisor; logs to stdout)
  harness unjoin               leave the machine (removes it on the web too) + clear the saved credential
  harness stop                 stop the background adapter (keeps the credential)
  harness reset                stop the adapter and clear local CLI state
  harness status               show whether it's running (+ version)
  harness version              print the installed version (v${VERSION})
  harness update               update to the latest build now (it also self-updates in the background)

Browser end-to-end encryption:
  harness browser-link         print a one-time setup link for this browser
  harness pair <code>          pair a BROWSER (code shown on the machine page)
  harness pairings             list paired clients
  harness unpair <#|fp>        unpair one browser (by list number or fingerprint)
  harness unpair --all         unpair every browser

  harness --help

Env: BACKEND_WS_URL (${env.BACKEND_WS_URL}), WEB_URL (${env.WEB_URL}), ADAPTER_DATA_DIR, CLAUDE_PROJECTS_DIR, PORT`)
  process.exit(0)
}

/** agentId = sha256(token)[:32] — same derivation as the backend (agentIdFromKey). */
function agentIdFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32)
}

/** Compact a home-relative path with `~` for display. */
function tildify(p: string): string {
  const h = homedir()
  return p.startsWith(h) ? '~' + p.slice(h.length) : p
}

/** The currently-running script — dist/cli.js when built, src/cli.ts under tsx. */
const SCRIPT_PATH = fileURLToPath(import.meta.url)

// The saved credential IS the agent apiKey — 32 random bytes as hex (64 chars).
const TOKEN_RE = /^[0-9a-f]{64}$/i

/** The saved credential (env override, else the token file), or null if this computer hasn't joined. */
function readSavedToken(): string | null {
  const fromEnv = env.ADAPTER_TOKEN
  if (fromEnv && TOKEN_RE.test(fromEnv)) return fromEnv
  try {
    const saved = readFileSync(TOKEN_FILE, 'utf-8').trim()
    if (saved && TOKEN_RE.test(saved)) return saved
  } catch { /* none */ }
  return null
}

function saveToken(token: string): void {
  mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true })
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
}

/** Stable per-computer id (persisted in ${ADAPTER_DATA_DIR}/computer-id, created once). Sent on connect
 *  so the backend can enforce one machine per machine — and tell a same-machine reconnect (its 30s
 *  presence may still be alive) apart from a genuine second machine. Survives `unjoin`. */
function computerId(): string {
  try {
    const saved = readFileSync(COMPUTER_ID_FILE, 'utf-8').trim()
    if (saved) return saved
  } catch { /* create below */ }
  const id = randomUUID()
  mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true })
  writeFileSync(COMPUTER_ID_FILE, id + '\n', { mode: 0o600 })
  return id
}

// ── join ───────────────────────────────────────────────────────────────────────────────────────
// The REST base for control endpoints, derived from the WS URL (wss→https, ws→http).
function backendHttpBase(): string {
  return env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}
function webBase(): string {
  return env.WEB_URL.replace(/\/$/, '')
}
function createSetupToken(machineId?: string): { token: string; expiresAt: number; fingerprint: string } {
  const store = new E2eeStore()
  store.init()
  return store.createSetupToken(machineId)
}
function setupBrowserLink(machineId: string, token: string): string {
  const u = new URL(`${webBase()}/machine/${machineId}`)
  u.hash = `setup=browser&t=${encodeURIComponent(token)}`
  return u.toString()
}

/** POST JSON to the backend and return its `data` envelope; throws on a non-2xx / bad body. */
async function postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${backendHttpBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { message?: string } }
  if (!res.ok || json.success === false) {
    throw new Error(json.error?.message || `HTTP ${res.status}`)
  }
  return json.data as T
}

function printJoinTokenRequired(): never {
  console.error('\n✗ This computer is not connected to a machine yet.')
  console.error('  Create or open a remote machine in the web UI, copy its connect token, then run:')
  console.error('\n    harness join <token>\n')
  process.exit(1)
}

/**
 * `harness join [token]` — the single connect command.
 *  - `join <token>`: connect a machine to an existing machine using the token shown on its machine page.
 *  - `join` (no token): reconnect with the saved credential. Fresh machines must pass a token.
 */
async function joinCommand(foreground: boolean, argToken?: string): Promise<void> {
  // Update-before-connect: pull the newest bundle FIRST so a machine always reconnects on the latest
  // build. Staging swaps ~/.harness/cli/cli.js, and the daemon join spawns below (`node cli.js __run`)
  // executes those fresh bytes. Skipped in the foreground (THIS process becomes the long-lived daemon
  // and self-updates on its own) and on a dev/repo build; never blocks the join if the check fails.
  if (!foreground) {
    const v = await stageLatestBundle((m) => console.log(m))
    if (v) console.log(`  ✓ updated to v${v} — connecting on the new build`)
  }
  if (argToken) {
    if (!TOKEN_RE.test(argToken)) {
      console.error('Invalid token — expected the 64-char hex key shown on the machine page ("Connect this computer").')
      process.exit(1)
    }
    saveToken(argToken)
    // Explicit token = the user chose a SPECIFIC machine → on deauth do NOT create a new one; say so.
    if ((await launch(argToken, foreground)) === 'deauth') {
      console.error("\n✗ That token isn't valid for any machine (it may have been deleted).")
      console.error('  Copy the current token from the machine page, then run: harness join <token>')
      process.exit(1)
    }
    return
  }
  const token = readSavedToken()
  if (!token) printJoinTokenRequired()
  // If the saved token was rejected (machine deleted/revoked → 401/403), launch wipes it and returns
  // 'deauth'; do not create a new machine from the CLI.
  if ((await launch(token, foreground)) === 'deauth') {
    console.error('\n✗ This computer is no longer connected to a valid machine.')
    console.error('  Open the machine page, copy a fresh connect token, then run: harness join <token>')
    process.exit(1)
  }
}

/** Download + sha256-verify + canary the manifest's cli.js/notify.mjs, then atomically swap them into
 *  the installed CLI dir (dropping the .prev backups on success). The freshly-written cli.js is what the
 *  NEXT spawned daemon (`node cli.js __run`) executes — so staging here = "update, then run the new build".
 *  Runs in the short-lived CLI process, distinct from the daemon's own background `startSelfUpdater`. */
async function downloadCanaryStage(entry: UpdateEntry, dir: string, log: (m: string) => void): Promise<boolean> {
  const cliBuf = await downloadVerified(entry.cli)
  const notifyBuf = await downloadVerified(entry.notify)
  if (!canary(cliBuf, dir)) { log(`  ✗ the new build failed its self-check — keeping v${VERSION}`); return false }
  stage(dir, cliBuf, notifyBuf)
  confirmUpdate(dir) // canary passed + bytes already verified ⇒ drop the .prev backups
  return true
}

/** Fetch the manifest and, if a strictly-newer build exists, stage it (see downloadCanaryStage). Returns
 *  the staged version, or null when nothing was staged — already current, a dev/repo or update-disabled
 *  build, or ANY fetch/verify/canary failure (all swallowed: an update hiccup must never block `join`). */
async function stageLatestBundle(log: (m: string) => void): Promise<string | null> {
  if (SCRIPT_PATH.endsWith('.ts') || env.ADAPTER_UPDATE_DISABLE) return null // dev/repo run never touches the installed bundle
  const dir = resolve(env.ADAPTER_CLI_DIR)
  try {
    const entry = await fetchManifest(env.ADAPTER_UPDATE_URL, env.ADAPTER_UPDATE_KEY)
    if (!entry || !semverGt(entry.version, VERSION)) return null
    log(`▸ newer build available — updating v${VERSION} → v${entry.version}…`)
    return (await downloadCanaryStage(entry, dir, log)) ? entry.version : null
  } catch (e) {
    log(`  (update check skipped: ${e instanceof Error ? e.message : String(e)})`)
    return null
  }
}

/** `harness update` — force the self-update NOW instead of waiting for the daemon's
 *  background poll. Checks the manifest; if a newer build exists it stops any running daemon first (so
 *  its poller can't race our staging), swaps in the new bytes, then relaunches on them. No-op on a
 *  dev/repo build, and leaves the daemon running-on-the-old-build untouched when already up to date. */
async function updateCommand(): Promise<void> {
  if (SCRIPT_PATH.endsWith('.ts')) {
    console.log('This is a dev/repo build (running from source) — `harness update` is a no-op. Rebuild the bundle instead.')
    process.exit(0)
  }
  console.log(`▸ Checking for updates…  (current v${VERSION})`)
  let entry: UpdateEntry | null = null
  try { entry = await fetchManifest(env.ADAPTER_UPDATE_URL, env.ADAPTER_UPDATE_KEY) }
  catch (e) { console.error(`✗ Could not reach the update manifest: ${e instanceof Error ? e.message : e}`); process.exit(1) }
  if (!entry || !semverGt(entry.version, VERSION)) {
    console.log(`✓ Already on the latest version (v${VERSION}).`)
    process.exit(0)
  }

  // A newer build exists. Stop the running daemon FIRST so its own background updater can't race our
  // staging on the .prev/.tmp files, then swap the bytes and bring it back up on the new build.
  const running = readPid()
  const wasRunning = !!(running && isAlive(running))
  const relaunch = async (): Promise<void> => {
    const t = readSavedToken()
    if (!t) { console.log('  (no saved credential — run `harness join <token>` to connect on the new build.)'); process.exit(0) }
    await new Promise((r) => setTimeout(r, 1000)) // grace for the backend to release the one-machine claim
    await launch(t, false) // spawns a fresh daemon on the new bytes, prints status, and exits
  }
  if (wasRunning) { console.log('  stopping the running adapter…'); await stopDaemonProcess() }

  console.log(`▸ Updating v${VERSION} → v${entry.version}…`)
  let ok = false
  try { ok = await downloadCanaryStage(entry, resolve(env.ADAPTER_CLI_DIR), (m) => console.log(m)) }
  catch (e) { console.error(`✗ Update failed: ${e instanceof Error ? e.message : e}`); ok = false }
  if (!ok) {
    if (wasRunning) await relaunch() // staging failed → bring the OLD build back so `update` never leaves it down
    process.exit(1)
  }
  console.log(`  ✓ installed v${entry.version}`)
  if (wasRunning) { await relaunch(); return }
  console.log(`✓ Updated to v${entry.version}. Run \`harness join <token>\` to connect.`)
  process.exit(0)
}

/** `adapter unjoin` — leave the machine: delete the binding on the backend (self-authorized by the
 *  agent's own key) and clear local creds; stop the daemon if it's running. */
async function unjoin(): Promise<void> {
  const token = readSavedToken()
  if (!token) { console.log('This computer has not joined (no saved credential).'); process.exit(0) }
  try {
    await postJson('/api/machines/leave', {}, { 'x-api-key': token })
    console.log('Left the machine on the backend.')
  } catch (e) {
    // Best-effort: even if the binding was already gone (or the backend is down), clear locally.
    console.warn(`(backend leave failed: ${e instanceof Error ? e.message : e} — clearing locally anyway)`)
  }
  const pid = readPid()
  if (pid && isAlive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ } }
  rmSync(PID_FILE, { force: true })
  rmSync(TOKEN_FILE, { force: true })
  rmSync(MACHINE_NAME_FILE, { force: true })
  console.log('This computer left the machine. Copy a token from the machine page, then run `harness join <token>` to connect again.')
  process.exit(0)
}

async function projectFrame(s: RegisteredSession, selectedModel: string | null): Promise<Record<string, unknown>> {
  const st = s.transcriptPath ? await stat(s.transcriptPath).catch(() => null) : null
  return {
    id: s.agentId,
    userId: '',
    name: projectDisplayName(s),
    status: 'active',
    createdAt: new Date(s.registeredAt).toISOString(),
    updatedAt: new Date(st?.mtimeMs ?? s.updatedAt).toISOString(),
    tmuxPane: s.tmuxPane,
    engine: s.engine,
    selectedModel,
  }
}

/** Birth time of a transcript in ms, or 0 when it cannot be read (treated as "not newer than the agent"). */
async function statBirthMs(path: string): Promise<number> {
  const st = await stat(path).catch(() => null)
  if (!st) return 0
  const birth = st.birthtimeMs || st.ctimeMs || st.mtimeMs
  return Number.isFinite(birth) ? birth : 0
}

/** The daemon body: hooks + watcher + process discovery + backend socket. */
async function runForeground(token: string): Promise<void> {
  installTimestampedConsole() // daemon-only: every machine.log line gets a wall-clock timestamp
  const startedAt = Date.now()

  // Claim the pid file for OURSELVES, first thing. It used to be written by whoever spawned us — the
  // update-restart's parent, after supervising the handover — so a parent that died mid-handover (a
  // `harness stop` landing in that window is enough) left a daemon nothing could manage: `status` said
  // stopped, `stop` had no pid to signal, and `join` walked into "port already in use" against the very
  // daemon it could not see. A process that is running is the only honest author of its own pid.
  try { writeFileSync(PID_FILE, String(process.pid) + '\n') } catch { /* best effort */ }

  // Last-resort net: a stray throw in ANY long-lived callback (a malformed JSONL line, a hostile backend
  // frame, a timer) must NEVER take the daemon down — there is no supervisor. Log it and keep running.
  // (Startup errors still fail loudly: they reject the runForeground promise → onError → exit, not these.)
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal-guard] unhandledRejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason)
  })
  process.on('uncaughtException', (err) => {
    console.error('[fatal-guard] uncaughtException:', err instanceof Error ? (err.stack ?? err.message) : err)
  })

  registry.load()
  // Persisted records are not trusted blindly. The process reconciler below adopts a matching live
  // runtime, replaces it immediately when PID/start-marker changed, and requires two successful misses
  // before removing it. Probe errors leave the registry untouched.
  // Recap pool AND voice router share one sync: both need to know which engines the machine actually
  // runs, and a router warmed for an engine no agent uses is exactly the bug this rides along to fix.
  const syncRecapPool = (): void => {
    const sessions = registry.list()
    syncSummaryPoolSessions(sessions)
    setVoiceRouterSessions(sessions)
  }
  syncRecapPool()
  const runtimeProfiles = new RuntimeProfileManager()
  // NB: hooks are installed AFTER the hook server binds (below), with the port it actually got — the
  // server may fall back to a free port if env.PORT is taken, and the hooks must point at the real one.

  const syncSession = (s: RegisteredSession, opts: { device?: boolean } = {}): void => {
    void projectFrame(s, runtimeProfiles.selectedModel(s))
      .then((project) => {
        const frame = { type: 'agent_synced', payload: { agent: project } }
        backendRef?.send(frame)
        if (opts.device !== false) backendRef?.sendCommander(frame)
      })
      .catch((err) => console.error('[cli] announceSession failed:', err instanceof Error ? err.message : err))
  }
  const announceRename = (s: RegisteredSession, opts: { device?: boolean } = {}): void => {
    const name = projectDisplayName(s)
    backendRef?.send({ type: 'agent_renamed', payload: { agentId: s.agentId, name, engine: s.engine } })
    if (opts.device !== false) backendRef?.sendCommander({ type: 'agent_renamed', payload: { agentId: s.agentId, name, engine: s.engine } })
  }
  // New process observations, session bindings, runtime-profile changes, reconnects and periodic
  // reconciliation refresh web and device from the same authoritative snapshot. Device agent_synced is
  // idempotent and can upsert a sessionless tile, so re-announcing at bind is both safe and necessary.
  const announceSession = (s: RegisteredSession, opts: { device?: boolean } = {}): void => {
    syncSession(s, opts)
    announceRename(s, opts)
  }

  const syncPaneTitles = async (): Promise<void> => {
    const titles = await listPaneTitles()
    if (titles.size === 0) return
    for (const session of registry.list()) {
      const title = titles.get(session.tmuxPane)
      if (!title) continue
      const before = projectDisplayName(session)
      const updated = registry.updateTitle(session.sessionId, title)
      if (!updated) continue
      const after = projectDisplayName(updated)
      if (after !== before) {
        syncSession(updated)
        announceRename(updated)
      }
    }
  }
  let backendRef: BackendSocket | undefined
  let fullReconcile: (announceDevice?: boolean) => Promise<void> = async () => {}

  const backend = new BackendSocket(token, (connected) => {
    if (!connected) return
    const sessions = registry.list()
    console.log(`[cli] connected · ${sessions.length} agent(s) registered`)
    void fullReconcile(true).catch((err) => {
      console.error('[runtime-profile] connect reconcile failed:', err instanceof Error ? err.message : err)
    })
  }, computerId())
  backendRef = backend

  // Per-session web turn-lifecycle state; the device mirror keeps its own state + recap.
  const turnStates = new Map<string, TurnState>()
  const codexNormalizers = new Map<string, CodexNormalizer>()
  const cursorNormalizers = new Map<string, CursorNormalizer>()
  const opencodeReaders = new Map<string, OpencodeReader>()
  const kiloReaders = new Map<string, KiloReader>()
  const piNormalizers = new Map<string, PiNormalizer>()
  const museNormalizers = new Map<string, MuseNormalizer>()
  const ampNormalizers = new Map<string, AmpNormalizer>()
  const grokNormalizers = new Map<string, GrokNormalizer>()
  const hermesReaders = new Map<string, HermesReader>()
  const devinReaders = new Map<string, DevinReader>()
  const commandcodeNormalizers = new Map<string, CommandCodeNormalizer>()
  const watcher = new Watcher()
  const queuedSessionEvents: Array<{
    sessionId: string
    events: ReturnType<CursorNormalizer['ingest']>
  }> = []
  // Hook registration can race the rest of daemon initialization immediately after the localhost
  // server binds. Queue those first records until input/mirror/heartbeat dependencies are ready.
  let emitSessionEvents = (
    sessionId: string,
    events: ReturnType<CursorNormalizer['ingest']>,
  ): void => {
    if (events.length) queuedSessionEvents.push({ sessionId, events })
  }
  /**
   * A turn died inside the engine instead of finishing. Neither devin nor commandcode has a StopFailure
   * hook, so nothing else would tell the clients: the web would sit on the typing indicator and the
   * device tile would stay "Working…". Surface the failure to both; the CALLER closes the turn (the devin
   * reader and the commandcode normalizer each own their own turn state).
   */
  const announceTurnAborted = (
    sessionId: string,
    engine: string,
    message: string,
    deviceMessage = message,
  ): void => {
    console.log(`[turn] ${sid(sessionId)} aborted by ${engine} error · ${preview(message)}`)
    backend.send({ type: 'error', agentId: agentIdFor(sessionId), dbSessionId: sessionId, payload: { message } })
    backend.sendCommander({
      type: 'commander_event',
      agentId: agentIdFor(sessionId),
      dbSessionId: sessionId,
      payload: { kind: 'error', text: deviceErrorText(deviceMessage, engine) },
    })
  }
  const cursorDiscovery = new CursorTranscriptDiscovery(env.CURSOR_HOME, (sessionId, transcriptPath) => {
    const existing = registry.bySession(sessionId)
    if (!existing || existing.engine !== 'cursor' || existing.transcriptPath === transcriptPath) return
    const result = registry.register({
      engine: 'cursor',
      sessionId,
      transcriptPath,
      cwd: existing.cwd ?? undefined,
      source: existing.source ?? undefined,
      tmuxPane: existing.tmuxPane,
      title: existing.title ?? undefined,
      model: existing.model ?? undefined,
      cliVersion: existing.cliVersion ?? undefined,
      processIdentity: existing.processIdentity ?? undefined,
      hookEvent: 'TranscriptDiscovered',
    })
    if (!result) return
    void attachSession(result.entry, false, true).then((attached) => {
      if (!attached) return
      syncRecapPool()
      syncSession(result.entry)
    }).catch((err) => {
      console.error('[cursor-discovery] attach failed:', err instanceof Error ? err.message : err)
    })
  })

  const attachSession = async (
    session: RegisteredSession,
    reset = false,
    replayCursorFromStart = false,
    /**
     * Tail the transcript from byte 0 instead of from its current end.
     *
     * The watcher normally starts at the end, because a session is registered the moment the engine
     * starts and the file is empty — end and start are the same place. That stops being true when an
     * agent exists BEFORE its session: the user types their first message in the terminal, THAT is what
     * makes the engine open a session, and by the time the hook binds it the prompt (and the first of the
     * answer) is already on disk. Starting at the end skipped it, so the web showed neither the message
     * nor the response. Only ever set for a session that was born after its agent — a resumed one keeps
     * tailing from the end, since its history belongs to `session_get`, not to the live stream.
     */
    replayFromStart = false,
  ): Promise<boolean> => {
    if (!await validateSessionRuntime(session)) return false
    if (!reset && (
      turnStates.has(session.sessionId)
      || codexNormalizers.has(session.sessionId)
      || cursorNormalizers.has(session.sessionId)
      || opencodeReaders.has(session.sessionId)
      || kiloReaders.has(session.sessionId)
      || piNormalizers.has(session.sessionId)
      || museNormalizers.has(session.sessionId)
      || ampNormalizers.has(session.sessionId)
      || grokNormalizers.has(session.sessionId)
      || hermesReaders.has(session.sessionId)
      || devinReaders.has(session.sessionId)
      || commandcodeNormalizers.has(session.sessionId)
    )) {
      if (session.transcriptPath) {
        await watcher.addSession(
          { ...session, transcriptPath: session.transcriptPath },
          { fromStart: replayFromStart || (session.engine === 'cursor' && replayCursorFromStart) },
        )
      }
      else if (session.engine === 'cursor') await cursorDiscovery.add(session.sessionId)
      console.log(`[agent] ${sid(session.agentId)} re-attached · engine=${session.engine} · pane=${session.tmuxPane} · session=${sid(session.sessionId)}`)
      return true
    }
    const lines = session.transcriptPath ? await tailFile(session.transcriptPath, Infinity) : []
    const initialCursorEvents: ReturnType<CursorNormalizer['ingest']> = []
    // Folding the transcript in below is deliberately silent — old turns must never replay live. But
    // when the history ENDS mid-turn the turn is still running, and dropping its `turn_started` costs
    // the whole turn: CommanderMirror.onTurnEnded returns early while turnOpen is false, so the close
    // that follows produces no recap and no `done`. Keep the last start and replay exactly that one.
    const historyEvents: LiveEvent[] = []
    let historyTurnOpen = false
    runtimeProfiles.hydrate(session, lines)
    await runtimeProfiles.ingestConfig(session, true)
    if (session.engine === 'codex') {
      const normalizer = new CodexNormalizer('live')
      // Hydrate state silently; never replay history live — except a turn left open, below.
      for (const line of lines) historyEvents.push(...normalizer.ingest(line))
      historyTurnOpen = normalizer.turnOpen
      codexNormalizers.set(session.sessionId, normalizer)
    } else if (session.engine === 'cursor') {
      const normalizer = new CursorNormalizer('live', session.sessionId)
      for (const line of lines) {
        const events = normalizer.ingest(line)
        if (replayCursorFromStart) initialCursorEvents.push(...events)
        else historyEvents.push(...events)
      }
      historyTurnOpen = !replayCursorFromStart && normalizer.turnOpen
      cursorNormalizers.set(session.sessionId, normalizer)
      const capture = await captureTmuxPane(session.tmuxPane, 100)
      if (capture) runtimeProfiles.ingestPane(session, capture, true)
    } else if (session.engine === 'opencode') {
      // OpenCode has no transcript file — poll its SQLite DB. The reader hydrates silently, then
      // streams new activity into emitSessionEvents (the same funnel the file engines use).
      const reader = new OpencodeReader({
        dbPath: OPENCODE_DB,
        sessionId: session.sessionId,
        onEvents: (events) => emitSessionEvents(session.sessionId, events),
        onFatal: (err) => console.warn(`[opencode] ${sid(session.sessionId)} ${err.message}`),
      })
      opencodeReaders.set(session.sessionId, reader)
      await reader.start()
    } else if (session.engine === 'kilo') {
      // Kilo is opencode's fork and keeps the same store shape, so it is polled the same way — but from
      // its OWN db and through its own reader, so the two can diverge without one breaking the other.
      const reader = new KiloReader({
        dbPath: KILO_DB,
        sessionId: session.sessionId,
        onEvents: (events) => emitSessionEvents(session.sessionId, events),
        onFatal: (err) => console.warn(`[kilo] ${sid(session.sessionId)} ${err.message}`),
      })
      kiloReaders.set(session.sessionId, reader)
      await reader.start()
    } else if (session.engine === 'muse') {
      // Same JSONL tail as claude/pi; only the record shape differs.
      const normalizer = new MuseNormalizer()
      for (const line of lines) historyEvents.push(...normalizer.ingest(line))
      historyTurnOpen = normalizer.turnOpen
      museNormalizers.set(session.sessionId, normalizer)
    } else if (session.engine === 'amp') {
      // A JSONL tail like claude/muse — except the file is written by the adapter's own Amp plugin,
      // because Amp is the one engine that keeps no conversation on disk.
      const normalizer = new AmpNormalizer()
      for (const line of lines) historyEvents.push(...normalizer.ingest(line))
      historyTurnOpen = normalizer.turnOpen
      ampNormalizers.set(session.sessionId, normalizer)
    } else if (session.engine === 'grok') {
      const normalizer = new GrokNormalizer()
      for (const line of lines) historyEvents.push(...normalizer.ingest(line))
      historyTurnOpen = normalizer.turnOpen
      grokNormalizers.set(session.sessionId, normalizer)
      const capture = await captureTmuxPane(session.tmuxPane, 60)
      if (capture) runtimeProfiles.ingestPane(session, capture, true)
    } else if (session.engine === 'pi') {
      const normalizer = new PiNormalizer('live')
      // Hydrate state silently; never replay history live — except a turn left open, below.
      for (const line of lines) historyEvents.push(...normalizer.ingest(line))
      historyTurnOpen = normalizer.turnOpen
      piNormalizers.set(session.sessionId, normalizer)
    } else if (session.engine === 'hermes') {
      // Hermes has no transcript file — poll its SQLite store, like opencode.
      const reader = new HermesReader({
        dbPath: HERMES_DB,
        sessionId: session.sessionId,
        onEvents: (events) => emitSessionEvents(session.sessionId, events),
        onFatal: (err) => console.warn(`[hermes] ${sid(session.sessionId)} ${err.message}`),
      })
      hermesReaders.set(session.sessionId, reader)
      await reader.start()
    } else if (session.engine === 'devin') {
      // Devin has no transcript file either — poll its SQLite store, like hermes/opencode.
      const reader = new DevinReader({
        dbPath: DEVIN_DB,
        devinHome: env.DEVIN_HOME,
        sessionId: session.sessionId,
        onEvents: (events) => emitSessionEvents(session.sessionId, events),
        // Devin has no StopFailure: a turn that dies on a provider error writes no assistant row and
        // fires no Stop hook, so surface the failure and close the turn ourselves — otherwise the web
        // sits on the typing indicator forever.
        onTurnAborted: (message) => {
          announceTurnAborted(session.sessionId, 'devin', message)
          emitSessionEvents(session.sessionId, [{ type: 'turn_ended', payload: {} }])
        },
        onFatal: (err) => console.warn(`[devin] ${sid(session.sessionId)} ${err.message}`),
      })
      devinReaders.set(session.sessionId, reader)
      await reader.start()
      // Devin's model/effort exist ONLY in its pane footer, so read it now. Without this the chip stayed
      // on Auto until the 5-minute reconcile happened to run — the attach itself said nothing about it.
      const devinPane = await captureTmuxPane(session.tmuxPane, 60)
      if (devinPane) runtimeProfiles.ingestPane(session, devinPane, true)
    } else if (session.engine === 'commandcode') {
      const normalizer = new CommandCodeNormalizer('live')
      // Hydrate state silently; never replay history live — except a turn left open, below.
      for (const line of lines) historyEvents.push(...normalizer.ingest(line))
      historyTurnOpen = normalizer.turnOpen
      commandcodeNormalizers.set(session.sessionId, normalizer)
    } else {
      const state = newTurnState()
      for (const line of lines) historyEvents.push(...lineToEvents(line, state))
      historyTurnOpen = state.turnOpen
      turnStates.set(session.sessionId, state)
    }
    if (session.transcriptPath) {
      await watcher.addSession({ ...session, transcriptPath: session.transcriptPath })
    } else if (session.engine === 'cursor') {
      await cursorDiscovery.add(session.sessionId)
    }
    if (initialCursorEvents.length) emitSessionEvents(session.sessionId, initialCursorEvents)
    console.log(`[agent] ${sid(session.agentId)} attached · engine=${session.engine} · pane=${session.tmuxPane} · session=${sid(session.sessionId)} · lines=${lines.length}`)
    // A first prompt that lands while this attach is running is already in the transcript we just
    // folded, so its turn_started was consumed as history and the live turn would end up untracked.
    // Replay that one event, after the attach log, so the recovery is visible in order.
    if (historyTurnOpen) {
      const opened = historyEvents.findLast((event) => event.type === 'turn_started')
      if (opened) {
        console.log(`[agent] ${sid(session.agentId)} resumed the turn already open at attach`)
        emitSessionEvents(session.sessionId, [opened])
      }
    }
    // Watch this pane for a question from ATTACH, not only from the next turn_started.
    //
    // A turn-scoped start assumes the agent exists before its turn does, and for some engines it does not:
    // OpenCode registers itself when its FIRST message creates the session, i.e. the turn is already
    // running by the time the daemon knows the agent — so its question opened and nothing announced it
    // (measured: the dialog sat on the pane, the device saw nothing). Command Code has the mirror problem,
    // asking AFTER the turn ends. The watcher is idempotent, no-ops without a device, and dies with the
    // session, so starting it early costs nothing.
    if (pollsQuestions(session.engine)) questionWatcher.start(session.sessionId)
    return true
  }
  // AskUserQuestion bridge: mirrors the question to the device's question screen, and keys the device's
  // answer back into the CLI's own dialog in the tmux pane.
  const questions = new AskQuestionController({
    getSession: (id) => registry.resolve(id),
    capture: captureTmuxPane,
    sendText: sendToTmux,
    sendKey: sendKeyToTmux,
  })
  // Command Code ENDS its turn in order to ask (its Stop hook fires, the dialog goes up, and the answer
  // opens a NEW turn). With the turn closed the device tile falls back to the PREVIOUS task's recap — so
  // mid-question the screen showed a finished summary while the user was still being asked. Keep the tile
  // visibly working for as long as the exchange lasts. The device's own busy-timeout watchdog bounds this,
  // so an abandoned question cannot pin the tile forever.
  const showAwaitingAnswer = (sessionId: string): void => {
    backend.sendCommander({
      type: 'commander_event',
      agentId: agentIdFor(sessionId),
      dbSessionId: sessionId,
      payload: { kind: 'processing', text: 'Waiting for your answer' },
    })
  }
  backend.onQuestionAnswer = (payload) => {
    // Hold the working state across the gap too: the CLI needs a moment to move to the next question, and
    // that gap is exactly where the stale recap used to flash back.
    const target = payload.sessionId || payload.agentId
    if (typeof target === 'string' && target) showAwaitingAnswer(target)
    void questions.answer(payload)
  }
  const questionWatcher = new QuestionWatcher({
    getSession: (id) => registry.resolve(id),
    capture: captureTmuxPane,
    hasDevice: () => backend.hasCommander(),
    isDriving: (sessionId) => questions.isDriving(sessionId),
    onQuestion: (sessionId, requestId, shaped) => {
      questions.remember(requestId, sessionId)
      showAwaitingAnswer(sessionId)
      backend.sendCommander({
        type: 'commander_question',
        agentId: agentIdFor(sessionId),
        dbSessionId: sessionId,
        payload: { requestId, questions: shaped },
      })
      console.log(`[question] ${sid(sessionId)} asking the user · "${preview(shaped[0]?.q ?? '')}" · req=${requestId}`)
    },
  })

  const mirror = new CommanderMirror({
    send: (frame) => backend.sendCommander(frame),
    sendWeb: (frame) => backend.send(frame), // turn_summary_pending / turn_summary → web indicator
    hasDevice: () => backend.hasCommander(), // device-gate the LLM recap (mirror node)
    active: () => backend.hasActiveCommander(), // stream live cards only to the actively-rendered machine
    summarize: (text, signal, userMessage, sessionId) =>
      summarizeTurnText(text, signal, userMessage, sessionId ? registry.bySession(sessionId)?.engine ?? 'claude' : 'claude'),
    nameFor: (sessionId) => { const s = registry.bySession(sessionId); return s ? projectDisplayName(s) : undefined },
    agentIdFor: (sessionId) => registry.bySession(sessionId)?.agentId,
    readLastTurn: async (sessionId) => {
      const s = registry.bySession(sessionId)
      if (!s) return null
      if (s.engine === 'opencode') return lastOpencodeTurnText(await readOpencodeMessages(OPENCODE_DB, sessionId))
      if (s.engine === 'kilo') return lastKiloTurnText(await readKiloMessages(KILO_DB, sessionId))
      if (s.engine === 'hermes') return lastHermesTurnText(await readHermesMessages(HERMES_DB, sessionId))
      if (s.engine === 'devin') return lastDevinTurnText(await readDevinMessages(DEVIN_DB, sessionId))
      if (!s.transcriptPath) return null
      const lines = await tailFile(s.transcriptPath, Infinity)
      if (s.engine === 'codex') return lastCodexTurnText(lines)
      if (s.engine === 'cursor') return lastCursorTurnText(lines)
      if (s.engine === 'muse') return lastMuseTurnText(lines)
      if (s.engine === 'amp') return lastAmpTurnText(lines)
      if (s.engine === 'grok') return lastGrokTurnText(lines)
      if (s.engine === 'pi') return lastPiTurnText(lines)
      if (s.engine === 'commandcode') return lastCommandCodeTurnText(lines)
      return lastTurnTextFromRawLines(lines)
    },
    dataDir: env.ADAPTER_DATA_DIR,
    recapForce: env.RECAP_FORCE,
  })
  // Recaps are STORED under the engine session id — that is what lets `--resume` bring the last recap
  // back under a brand-new agent — but they are ASKED FOR by agent id, which is the only id the device
  // and the voice router know. Resolve across the two, or every tile restores empty.
  backend.recentProvider = (id, n) => mirror.recent(registry.resolve(id)?.sessionId || id, n)

  const input = new SessionInputController({
    getSession: (id) => registry.resolve(id),
    validateRuntime: validateSessionRuntime,
    inject: sendToTmux,
    sendKey: sendKeyToTmux,
    capture: captureTmuxPane,
    onError: (sessionId, message) => {
      backend.send({ type: 'error', agentId: agentIdFor(sessionId), dbSessionId: sessionId, payload: { message } })
      const engine = registry.resolve(sessionId)?.engine
      backend.sendCommander({ type: 'commander_event', agentId: agentIdFor(sessionId), dbSessionId: sessionId, payload: { kind: 'error', text: deviceErrorText(message, engine) } })
    },
  })
  const runtimeController = new RuntimeProfileController({
    manager: runtimeProfiles,
    getSession: (id) => registry.resolve(id),
    validateRuntime: validateSessionRuntime,
    capture: captureTmuxPane,
    sendText: sendToTmux,
    sendLiteral: sendLiteralToTmux,
    sendKey: sendKeyToTmux,
    acquireInput: (id) => input.acquireControl(registry.resolve(id)?.agentId ?? id),
  })
  /**
   * Engine session id → the agent that owns it. The event stream speaks in ENGINE session ids while
   * anything the user addresses (input queue, control lock, every outbound frame) belongs to the AGENT,
   * which outlives the session it is currently bound to.
   */
  const agentIdFor = (sessionId: string): string => registry.bySession(sessionId)?.agentId ?? sessionId


  backend.runtimeModelsProvider = (sessionId) => {
    if (!sessionId) return runtimeProfiles.modelsForSessions(registry.list())
    const session = registry.resolve(sessionId)
    return session ? runtimeProfiles.modelsForSession(session) : Promise.resolve([])
  }
  backend.runtimeProfileProvider = (session) => runtimeProfiles.selectedModel(session)
  backend.onRuntimeProfileUpdate = (sessionId, selectedModel) => runtimeController.setProfile(sessionId, selectedModel)
  runtimeProfiles.onChanged = (sessionId) => {
    const session = registry.resolve(sessionId)
    if (session) syncSession(session)
  }

  // Turn heartbeat (5s): pushes `turn_heartbeat` to the web while the turn is open (keeps its 10s
  // turn-watchdog armed through a quiet stretch — a long tool, thinking with no new JSONL line), AND fans a
  // busy heartbeat to the device via mirror.heartbeat() so the device's busy tile stays fresh. Unlike the
  // web send, the device fan-out spans the WHOLE busy window — the turn AND the trailing summarize (up to
  // the 60s one-shot timeout) — because the device clears busy only on a live terminal and has a
  // busy-timeout watchdog that would otherwise cut a long "Summarizing…". So the timer self-cancels only
  // once BOTH the turn is closed and mirror.heartbeat() reports idle (turn done + summary done). Mirrors the
  // the hosted runtime brain (TURN_HEARTBEAT_MS=5000), per-session, one timer per session.
  const TURN_HEARTBEAT_MS = 5000
  const heartbeats = new Map<string, NodeJS.Timeout>()
  const turnStartedAt = new Map<string, number>() // sessionId → turn_started wall clock, for [turn] duration
  const stopHeartbeat = (sessionId: string): void => {
    const t = heartbeats.get(sessionId)
    if (t) { clearInterval(t); heartbeats.delete(sessionId) }
  }
  const startHeartbeat = (sessionId: string): void => {
    stopHeartbeat(sessionId) // restart → guarantee a single timer per session
    const timer = setInterval(() => {
      if (!registry.has(sessionId)) { stopHeartbeat(sessionId); return }
      const turnOpen =
        turnStates.get(sessionId)?.turnOpen
        ?? codexNormalizers.get(sessionId)?.turnOpen
        ?? cursorNormalizers.get(sessionId)?.turnOpen
        ?? opencodeReaders.get(sessionId)?.turnOpen
        ?? kiloReaders.get(sessionId)?.turnOpen
        ?? piNormalizers.get(sessionId)?.turnOpen
        ?? museNormalizers.get(sessionId)?.turnOpen
        ?? ampNormalizers.get(sessionId)?.turnOpen
        ?? grokNormalizers.get(sessionId)?.turnOpen
        ?? hermesReaders.get(sessionId)?.turnOpen
        ?? devinReaders.get(sessionId)?.turnOpen
        ?? commandcodeNormalizers.get(sessionId)?.turnOpen
      // Device: keep the busy tile alive through the turn AND the summarize window. Returns false when idle.
      const deviceBusy = mirror.heartbeat(sessionId)
      // Web: unchanged — heartbeat only while the turn itself is open (summarizing uses turn_summary_pending).
      if (turnOpen) backend.send({ type: 'turn_heartbeat', dbSessionId: sessionId, payload: { sessionId } })
      // Self-cancel only once the turn is closed AND the summarize is done (no more device heartbeat needed).
      if (!turnOpen && !deviceBusy) stopHeartbeat(sessionId)
    }, TURN_HEARTBEAT_MS)
    heartbeats.set(sessionId, timer)
  }

  emitSessionEvents = (sessionId: string, events: ReturnType<CursorNormalizer['ingest']>): void => {
    if (!events.length || !registry.has(sessionId)) return
    for (const event of events) {
      backend.send({ ...event, dbSessionId: sessionId })
      if (event.type === 'turn_started') {
        turnStartedAt.set(sessionId, Date.now())
        console.log(`[turn] ${sid(sessionId)} started · engine=${registry.bySession(sessionId)?.engine ?? 'claude'} · "${preview(event.payload.userMessage)}"`)
        input.onTurnStarted(agentIdFor(sessionId), event.payload.userMessage)
        startHeartbeat(sessionId)
        questionWatcher.start(sessionId)   // Claude opens its dialog INSIDE a turn
      } else if (event.type === 'turn_ended') {
        const startedAt = turnStartedAt.get(sessionId)
        turnStartedAt.delete(sessionId)
        // Say when a turn was KILLED. The log previously showed an interrupt as a fresh `[turn] started
        // "[Request interrupted by user]"`, which read like a new prompt and hid the bug for weeks.
        console.log(
          `[turn] ${sid(sessionId)} ended${event.payload.aborted ? ' · aborted (interrupted)' : ''}` +
            `${startedAt ? ` · ${Date.now() - startedAt}ms` : ''}`,
        )
        input.onTurnEnded(agentIdFor(sessionId))
        // Command Code asks AFTER the turn: `ask_user_question` ends the turn (its Stop hook fires), the
        // dialog goes up, and the answer opens a NEW turn. Stopping the watcher here is what left the
        // terminal sitting on a question the device never showed. Its watcher runs off the session, not
        // the turn — see the attach path — so leave it alone.
        if (registry.bySession(sessionId)?.engine !== 'commandcode') questionWatcher.stop(sessionId)
        // Do NOT stop the heartbeat here: the turn is closed but the device summarize is just starting
        // (mirror sets summarizing=true in the mirror.ingest below). The timer keeps fanning "Summarizing…"
        // to the device and self-cancels once mirror.heartbeat() reports idle (summary done).
      }
    }
    mirror.ingest(events, sessionId)
  }
  for (const queued of queuedSessionEvents.splice(0)) emitSessionEvents(queued.sessionId, queued.events)
  const cursorSubagents = new CursorSubagentManager(env.CURSOR_HOME, emitSessionEvents)
  const cursorTaskHooks = new CursorTaskHookQueue({
    drainTranscript: (sessionId) => watcher.pollSession(sessionId),
    emit: emitSessionEvents,
    register: (sessionId, hook, normalizer) => cursorSubagents.register(sessionId, hook, normalizer),
    isActive: (sessionId) => registry.bySession(sessionId)?.engine === 'cursor',
    onError: (sessionId, error) => {
      console.error(`[cursor] Task hook queue failed (${sessionId}):`, error instanceof Error ? error.message : error)
    },
  })
  const onCursorTaskStart = (sessionId: string, toolUseId: string, toolInput: unknown): void => {
    const session = registry.resolve(sessionId)
    if (!session || session.engine !== 'cursor') return
    let normalizer = cursorNormalizers.get(sessionId)
    if (!normalizer) {
      normalizer = new CursorNormalizer('live', sessionId)
      cursorNormalizers.set(sessionId, normalizer)
    }
    cursorTaskHooks.enqueue(sessionId, { toolUseId, input: toolInput }, normalizer)
  }

  /** Release a mutable session binding, or remove the process-owned agent everywhere. */
  const forgetSession = (id: string, opts: { force?: boolean; keepAgent?: boolean } = {}): void => {
    const doomed = registry.resolve(id)
    const sessionId = doomed?.sessionId || id
    console.log(opts.keepAgent
      ? `[agent] ${sid(doomed?.agentId ?? sessionId)} released session ${sid(sessionId)}`
      : `[agent] ${sid(doomed?.agentId ?? sessionId)} forgotten`)
    if (opts.keepAgent) registry.unbindSession(sessionId)
    else if (doomed) registry.removeAgent(doomed.agentId)
    else registry.remove(sessionId)
    syncRecapPool()
    turnStates.delete(sessionId)
    turnStartedAt.delete(sessionId)
    codexNormalizers.delete(sessionId)
    cursorNormalizers.delete(sessionId)
    opencodeReaders.get(sessionId)?.stop()
    opencodeReaders.delete(sessionId)
    kiloReaders.get(sessionId)?.stop()
    kiloReaders.delete(sessionId)
    piNormalizers.delete(sessionId)
    museNormalizers.delete(sessionId)
    ampNormalizers.delete(sessionId)
    grokNormalizers.delete(sessionId)
    hermesReaders.get(sessionId)?.stop()
    hermesReaders.delete(sessionId)
    devinReaders.get(sessionId)?.stop()
    devinReaders.delete(sessionId)
    commandcodeNormalizers.delete(sessionId)
    cursorDiscovery.remove(sessionId)
    cursorSubagents.forget(sessionId)
    void removeCursorPendingTasks(env.ADAPTER_DATA_DIR, sessionId)
    runtimeProfiles.forget(sessionId)
    void watcher.removeSession(sessionId)
    stopHeartbeat(sessionId)
    input.forget(doomed?.agentId ?? sessionId)
    mirror.forget(sessionId) // aborts any in-flight recap + clears busy; KEEPS the persisted summary
    if (opts.keepAgent) return
    backend.send({ type: 'agent_deleted', payload: { agentId: doomed?.agentId ?? sessionId } }) // web tab
    backend.sendCommander({ type: 'agent_deleted', payload: { agentId: doomed?.agentId ?? sessionId } })
  }

  type RegisteredMeta = {
    isNew: boolean
    evicted: string | null
    rebound: string | null
    hookEvent?: string
  }

  const handleRegistered = async (entry: RegisteredSession, meta: RegisteredMeta): Promise<void> => {
    if (meta.rebound) {
      registry.inheritName(meta.rebound, entry.sessionId)
      mirror.inheritSummary(meta.rebound, entry.sessionId)
      forgetSession(meta.rebound, { force: true, keepAgent: true })
      backend.send({ type: 'session_reset', payload: { staleSessionId: meta.rebound } })
      console.log(`[agent] ${sid(entry.agentId)} rebound ${sid(meta.rebound)} → ${sid(entry.sessionId)}`)
    } else if (meta.evicted) {
      forgetSession(meta.evicted, { force: true })
    }
    const reset = meta.isNew || (entry.engine !== 'cursor' && meta.hookEvent === 'SessionStart')
    const bornAfterAgent = meta.isNew && !meta.rebound && entry.boundAt !== null
      && entry.boundAt - entry.registeredAt > 0
      && !!entry.transcriptPath
      && await statBirthMs(entry.transcriptPath) >= entry.registeredAt
    const attached = await attachSession(entry, reset, entry.engine === 'cursor', bornAfterAgent)
    if (!attached) {
      registry.unbindSession(entry.sessionId)
      announceSession(entry)
      return
    }
    syncRecapPool()
    if (!meta.isNew) return
    registry.inheritName(entry.agentId, entry.sessionId)
    announceSession(entry)
    backend.send({
      type: 'session_synced',
      payload: {
        sessionId: entry.sessionId,
        agentId: entry.agentId,
        title: projectDisplayName(entry),
        createdAt: new Date(entry.boundAt ?? Date.now()).toISOString(),
      },
    })
  }

  const lastRepairAttempt = new Map<string, number>()
  const repairAttempts = new Map<string, number>()
  const bindObservedAgent = async (observed: DiscoveredTmuxAgent): Promise<void> => {
    const agent = registry.byPaneEngine(observed.tmuxPane, observed.engine)
    if (!agent || agent.sessionId) return

    let sessionId = observed.resumeSessionId
    let transcriptPath: string | undefined
    let source = 'tmux-resume'
    if (sessionId) {
      if (isRecentlyDeleted(sessionId)) return
      const owner = registry.bySession(sessionId)
      if (owner && owner.agentId !== agent.agentId) {
        const observedStarted = Date.parse(observed.processIdentity.startMarker)
        const ownerStarted = Date.parse(owner.processIdentity?.startMarker ?? '')
        if (Number.isFinite(ownerStarted) && (!Number.isFinite(observedStarted) || observedStarted <= ownerStarted)) return
      }
      transcriptPath = observed.engine === 'cursor'
        ? await findCursorTranscript(env.CURSOR_HOME, sessionId) ?? undefined
        : observed.engine === 'grok'
          ? await findGrokTranscript(env.GROK_HOME, observed.cwd, sessionId) ?? undefined
          : undefined
      if ((observed.engine === 'cursor' || observed.engine === 'grok') && !transcriptPath) return
    } else {
      const attempts = repairAttempts.get(agent.agentId) ?? 0
      const lastAttempt = lastRepairAttempt.get(agent.agentId) ?? 0
      if (attempts >= REPAIR_EAGER_ATTEMPTS && Date.now() - lastAttempt < REPAIR_RETRY_MS) return
      lastRepairAttempt.set(agent.agentId, Date.now())
      repairAttempts.set(agent.agentId, attempts + 1)
      const startedAtMs = Date.parse(observed.processIdentity.startMarker)
      if (!Number.isFinite(startedAtMs)) return
      const found = await findLiveSession(observed.engine, observed.cwd, startedAtMs, { bornOnly: true })
      if (!found || registry.has(found.sessionId) || isRecentlyDeleted(found.sessionId)) return
      sessionId = found.sessionId
      transcriptPath = found.transcriptPath
      source = 'process-repair'
    }

    const previousOwner = registry.bySession(sessionId)
    const result = registry.register({
      engine: observed.engine,
      sessionId,
      transcriptPath,
      cwd: observed.cwd,
      source,
      tmuxPane: observed.tmuxPane,
      processIdentity: observed.processIdentity,
      hookEvent: source === 'tmux-resume' ? 'TmuxResumeDiscovery' : 'ProcessRepair',
    })
    if (!result || !result.isNew) return
    if (previousOwner && previousOwner.agentId !== result.entry.agentId) {
      input.forget(previousOwner.agentId)
      announceSession(previousOwner)
    }
    lastRepairAttempt.delete(agent.agentId)
    repairAttempts.delete(agent.agentId)
    await handleRegistered(result.entry, result)
    console.log(`[discovery] bound ${observed.engine} session ${sid(result.entry.sessionId)} on ${observed.tmuxPane}`)
  }

  const agentReconciler = new TmuxAgentReconciler({
    current: () => registry.list(),
    onDiscovered: async (observed) => {
      const opened = registry.openProcessAgent({
        engine: observed.engine,
        tmuxPane: observed.tmuxPane,
        cwd: observed.cwd,
        processIdentity: observed.processIdentity,
      })
      if (!opened) return
      if (opened.evicted) console.log(`[discovery] ${observed.tmuxPane} replaced ${sid(opened.evicted)}`)
      if (opened.isNew) {
        console.log(`[discovery] ${sid(opened.entry.agentId)} opened · engine=${observed.engine} · pane=${observed.tmuxPane}`)
        announceSession(opened.entry)
      }
      await bindObservedAgent(observed)
    },
    onObserved: async (observed, current) => {
      registry.updateProcessIdentity(current.agentId, observed.processIdentity)
      await bindObservedAgent(observed)
    },
    onRemoved: (agent, reason) => {
      console.log(`[discovery] ${sid(agent.agentId)} removed · ${reason}`)
      forgetSession(agent.agentId, { force: true })
    },
  })

  // SessionEnd describes the mutable engine session, never process lifetime. Reconcile now; discovery
  // decides whether the agent still exists from tmux + ps.
  const onSessionEnd = (_sessionId: string, _reason: string | undefined): void => {
    void agentReconciler.trigger()
  }

  const { server: hookServer, port: hookPort } = await startHookServer(env.PORT, {
    resolveHookAgent: async ({ engine, tmuxPane }) => {
      await agentReconciler.trigger()
      return registry.byPaneEngine(tmuxPane, engine) ?? null
    },
    onRegistered: handleRegistered,
    onSessionEnd,
    // Command Code's PreToolUse — the one live "a turn is running" signal this engine has. Without it the
    // adapter only learned of a turn from Stop, and emitted turn_started+turn_ended in the same
    // millisecond, so the device tile jumped from idle straight to the recap with no working state.
    onTurnStart: ({ sessionId }) => {
      const session = registry.resolve(sessionId)
      if (!session || session.engine !== 'commandcode') return
      const normalizer = commandcodeNormalizers.get(sessionId)
      if (!normalizer) return
      emitSessionEvents(sessionId, normalizer.openTurn())   // no-op after the turn's first tool call
    },
    onToolStart: ({ sessionId, toolUseId, toolName, input: toolInput }) => {
      if (toolName === 'Task') onCursorTaskStart(sessionId, toolUseId, toolInput)
    },
    onTurnStop: ({ sessionId, status }) => {
      const session = registry.resolve(sessionId)
      if (!session) return
      if (session.engine === 'cursor') {
        void (async () => {
          await cursorTaskHooks.wait(sessionId)
          await watcher.pollSession(sessionId)
          const normalizer = cursorNormalizers.get(sessionId)
          if (!normalizer) return
          cursorSubagents.closeParent(sessionId, status === 'error')
          const closing = normalizer.closeTurn()
          emitSessionEvents(sessionId, closing)
          // Cursor can fail a turn BEFORE it writes anything to the transcript — observed as a Stop hook
          // with status=error 2.4s after beforeSubmitPrompt, with no transcript file discovered and no
          // rows to read. The normalizer never opened a turn, so closeTurn() returns nothing, so nothing
          // reaches the device: the tile just sits on the previous recap forever while the user waits.
          //
          // Every other engine already routes its failures through announceTurnAborted (codex, devin,
          // commandcode); cursor was the one that stayed silent. Announce only when the close produced no
          // events — if there WAS output, the `done` event above already tells the device the turn ended.
          if (status === 'error' && closing.length === 0) {
            announceTurnAborted(sessionId, 'cursor', 'Cursor ended the turn with an error before producing any output')
          }
          setTimeout(() => void removeCursorPendingTasks(env.ADAPTER_DATA_DIR, sessionId), 2_500)
        })().catch((err) => {
          console.error('[cursor] stop hook failed:', err instanceof Error ? err.message : err)
        })
        return
      }
      // claude: authoritative turn-close from the Stop/StopFailure hook. Drain any un-read JSONL FIRST
      // (may emit the real turn_ended → st.turnOpen already false); only force-close if still open. A
      // later real end_turn line is then a no-op (lineToEvents guards on state.turnOpen). This closes
      // the B1/B2 cases (max_tokens/refusal/API-error/wedged tool) the JSONL parse would otherwise miss.
      // Command Code has no UserPromptSubmit and commits records per turn, so Stop is its authoritative
      // close: drain the transcript first (the natural close usually wins), then force-close what's left.
      if (session.engine === 'commandcode') {
        void (async () => {
          await watcher.pollSession(sessionId)
          const normalizer = commandcodeNormalizers.get(sessionId)
          if (!normalizer?.turnOpen) return
          await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
          await watcher.pollSession(sessionId)
          if (!normalizer.turnOpen) return
          normalizer.closeTurn()
          console.log(`[turn] ${sid(sessionId)} force-closed by Stop hook (after grace)`)
          emitSessionEvents(sessionId, [{ type: 'turn_ended', payload: {} }])
        })().catch((err) => {
          console.error('[hooks] commandcode stop hook failed:', err instanceof Error ? err.message : err)
        })
        return
      }
      // Devin: same deal, except the un-read history is in SQLite rather than a file, so the drain is the
      // reader's own poll. Its rows only land once the model round-trip commits, so the grace matters.
      if (session.engine === 'devin') {
        void (async () => {
          const reader = devinReaders.get(sessionId)
          if (!reader?.turnOpen) return
          await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
          if (!reader.turnOpen) return
          reader.closeTurn()
          console.log(`[turn] ${sid(sessionId)} force-closed by Stop hook (after grace)`)
          emitSessionEvents(sessionId, [{ type: 'turn_ended', payload: {} }])
        })().catch((err) => {
          console.error('[hooks] devin stop hook failed:', err instanceof Error ? err.message : err)
        })
        return
      }
      if (session.engine === 'grok') {
        void (async () => {
          await watcher.pollSession(sessionId)
          const normalizer = grokNormalizers.get(sessionId)
          if (status === 'error') {
            announceTurnAborted(sessionId, 'grok', 'Grok ended the turn with an error')
            emitSessionEvents(sessionId, normalizer?.abortTurn() ?? [])
          }
        })().catch((err) => {
          console.error('[hooks] grok StopFailure hook failed:', err instanceof Error ? err.message : err)
        })
        return
      }
      if (session.engine !== 'claude') return
      void (async () => {
        await watcher.pollSession(sessionId)
        // A Stop hook is the one precise "the engine stopped writing" signal we get. When the mirror is
        // HOLDING a turn-end for finished async sub-agents, this is what tells it the wrap-up message is
        // on disk — without it the recap fires on its settle timer and can beat claude's closing summary
        // to the punch (measured: recap at 10:18:41, wrap-up written at 10:18:44).
        mirror.noteEngineStopped(sessionId)
        if (!turnStates.get(sessionId)?.turnOpen) return // natural JSONL close already won → nothing to do
        // Still open: the transcript may just be lagging the Stop hook. Wait, re-poll, and only force-close
        // if it STILL hasn't closed — a genuinely wedged turn, whose assistant text is on disk by now.
        await new Promise((r) => setTimeout(r, STOP_HOOK_GRACE_MS))
        await watcher.pollSession(sessionId)
        const st = turnStates.get(sessionId)
        if (st?.turnOpen) {
          st.turnOpen = false
          st.pendingTools.clear()
          console.log(`[turn] ${sid(sessionId)} force-closed by ${status === 'error' ? 'StopFailure' : 'Stop'} hook (after grace)`)
          emitSessionEvents(sessionId, [{ type: 'turn_ended', payload: {} }])
        }
      })().catch((err) => {
        console.error('[hooks] claude stop hook failed:', err instanceof Error ? err.message : err)
      })
    },
    // `harness pair <code>` → run CPace toward the waiting browser; map the result to an HTTP outcome.
    onPair: async (code) => {
      const r = await backend.pair(code)
      if (r.ok) return { status: 200, body: { label: r.label, fingerprint: r.fingerprint } }
      const codeMap: Record<string, number> = {
        NO_INTENT: 409, EXPIRED: 409, CODE_MISMATCH: 403, BACKEND_DOWN: 503,
        RATE_LIMITED: 429, BUSY: 409, TIMEOUT: 504,
      }
      return { status: codeMap[r.error] ?? 400, body: { error: r.error } }
    },
    onSetupLink: () => {
      const r = backend.createSetupToken()
      return { status: 200, body: { url: setupBrowserLink(backend.machineId, r.token), expiresAt: r.expiresAt, fingerprint: r.fingerprint } }
    },
    onListPairs: () => ({ status: 200, body: { pairs: backend.listPairs() } }),
    onRevoke: (id) => {
      const r = backend.revoke(id)
      if (r.ok) return { status: 200, body: { label: r.label, fingerprint: r.fingerprint } }
      return { status: r.error === 'AMBIGUOUS' ? 409 : 404, body: { error: r.error } }
    },
    onRevokeAll: () => ({ status: 200, body: backend.revokeAll() }),
    // Local dashboard (GET /api/status): adapter health + computer fingerprint + local pairings. It
    // deliberately does NOT expose chat/transcripts — those live in the cloud web (WEB_URL/commander).
    onStatus: () => ({
      machineId: backend.machineId,
      version: VERSION,
      backendUrl: env.BACKEND_WS_URL,
      webUrl: env.WEB_URL,
      connected: backend.isConnected(),
      deviceTransportConnected: backend.hasCommander(),
      deviceE2eeConnected: backend.deviceE2eeConnected(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      fingerprint: backend.e2eeFingerprint(),
      config: { watching: 'tmux sessions across all supported engines (including Grok)', dataDir: tildify(env.ADAPTER_DATA_DIR), port: daemonPort() },
      sessions: registry.list().map((s) => ({ id: s.agentId, sessionId: s.sessionId, name: projectDisplayName(s), engine: s.engine, cwd: tildify(s.cwd ?? ''), tmuxPane: s.tmuxPane, updatedAt: s.updatedAt })),
      pairs: backend.listPairs(),
      pending: backend.pendingPair(),
    }),
    onLogs: () => {
      try { return readFileSync(LOG_FILE, 'utf-8').split('\n').slice(-120).join('\n') } catch { return '' }
    },
    onStop: () => { setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50) }, // let the 200 flush first
  })
  // Install both CLI hooks with the port the local server actually bound.
  if (!env.DISABLE_HOOK_INSTALL) {
    installSessionHooks(hookPort)
    installCodexHooks(hookPort)
    installCursorHooks(hookPort)
    installOpencodePlugin(hookPort)
    installKiloPlugin(hookPort)
    installPiExtension(hookPort)
    // A self-update refreshes plugin files here; running engine processes pick them up according to each
    // vendor's own plugin reload lifecycle.
    installAmpPlugin(hookPort)
    installHermesHooks(hookPort)
    installDevinHooks(hookPort)
    installCommandCodeHooks(hookPort)
    installGrokHooks(hookPort)
  }
  backend.setDashboardPort(hookPort) // surfaced to the web (e2e_status) so it can link here to approve
  console.log(`[cli] local dashboard → http://127.0.0.1:${hookPort}`)

  // JSONL watcher → normalize each appended line → stream up. ONE lineToEvents pass feeds BOTH
  // audiences: web (send, ServerEvents) and device (mirror.ingest → curated commander_event cards).
  watcher.on('line', (evt: LineEvent) => {
    // This runs from a void-discarded async read, so a throw here would be an unhandledRejection. A
    // single malformed line must never take the daemon down — contain it per line and move on.
    try {
      if (!registry.has(evt.sessionId)) return // scope to tmux-registered sessions
      const session = registry.bySession(evt.sessionId)
      if (!session || session.engine !== evt.engine) return
      runtimeProfiles.ingest(session, evt.text)
      let events
      if (session.engine === 'codex') {
        let normalizer = codexNormalizers.get(evt.sessionId)
        if (!normalizer) { normalizer = new CodexNormalizer('live'); codexNormalizers.set(evt.sessionId, normalizer) }
        events = normalizer.ingest(evt.text)
        // Codex rides its failure ON task_complete, so the turn closes by itself — but with no text and
        // no reason, which reads as "the agent answered nothing". Announce the reason ahead of the
        // turn_ended that `events` carries.
        const taskError = codexTaskError(evt.text)
        if (taskError !== null) announceTurnAborted(evt.sessionId, 'codex', taskError)
      } else if (session.engine === 'cursor') {
        let normalizer = cursorNormalizers.get(evt.sessionId)
        if (!normalizer) {
          normalizer = new CursorNormalizer('live', evt.sessionId)
          cursorNormalizers.set(evt.sessionId, normalizer)
        }
        events = normalizer.ingest(evt.text)
      } else if (session.engine === 'muse') {
        let normalizer = museNormalizers.get(evt.sessionId)
        if (!normalizer) { normalizer = new MuseNormalizer(); museNormalizers.set(evt.sessionId, normalizer) }
        events = normalizer.ingest(evt.text)
      } else if (session.engine === 'amp') {
        let normalizer = ampNormalizers.get(evt.sessionId)
        if (!normalizer) { normalizer = new AmpNormalizer(); ampNormalizers.set(evt.sessionId, normalizer) }
        events = normalizer.ingest(evt.text)
      } else if (session.engine === 'grok') {
        let normalizer = grokNormalizers.get(evt.sessionId)
        if (!normalizer) { normalizer = new GrokNormalizer(); grokNormalizers.set(evt.sessionId, normalizer) }
        events = normalizer.ingest(evt.text)
      } else if (session.engine === 'pi') {
        let normalizer = piNormalizers.get(evt.sessionId)
        if (!normalizer) { normalizer = new PiNormalizer('live'); piNormalizers.set(evt.sessionId, normalizer) }
        events = normalizer.ingest(evt.text)
      } else if (session.engine === 'commandcode') {
        let normalizer = commandcodeNormalizers.get(evt.sessionId)
        if (!normalizer) { normalizer = new CommandCodeNormalizer('live'); commandcodeNormalizers.set(evt.sessionId, normalizer) }
        events = normalizer.ingest(evt.text)
        // Command Code fires no Stop hook for a failed turn: this record IS the notification. `ingest`
        // already closed the turn (its turn_ended is in `events`, emitted just below) — announce the
        // reason first so the web/device show the error ahead of the turn closing.
        const runError = commandCodeRunError(evt.text)
        if (runError !== null) {
          announceTurnAborted(evt.sessionId, 'commandcode', runError, commandCodeRunErrorSummary(runError))
        }
      } else {
        let st = turnStates.get(evt.sessionId)
        if (!st) { st = newTurnState(); turnStates.set(evt.sessionId, st) }
        events = lineToEvents(evt.text, st)
      }
      emitSessionEvents(evt.sessionId, events)
    } catch (err) {
      console.error(`[cli] line handler error (session ${evt.sessionId}):`, err instanceof Error ? err.message : err)
    }
  })
  for (const session of registry.list()) {
    // An UNBOUND process agent has no transcript to attach to yet. Discovery keeps it visible and the
    // hook/store repair path binds it as soon as the engine reports a session. Attaching an
    // empty session id here would tear down an agent the user can see running in their pane, which is
    // exactly what a self-update restart must never do.
    if (!session.sessionId) continue
    if (!await attachSession(session)) forgetSession(session.sessionId)
    else {
      input.setTurnOpen(
        session.agentId,
        turnStates.get(session.sessionId)?.turnOpen
          ?? codexNormalizers.get(session.sessionId)?.turnOpen
          ?? cursorNormalizers.get(session.sessionId)?.turnOpen
          ?? opencodeReaders.get(session.sessionId)?.turnOpen
          ?? kiloReaders.get(session.sessionId)?.turnOpen
          ?? piNormalizers.get(session.sessionId)?.turnOpen
          ?? museNormalizers.get(session.sessionId)?.turnOpen
          ?? ampNormalizers.get(session.sessionId)?.turnOpen
          ?? grokNormalizers.get(session.sessionId)?.turnOpen
          ?? hermesReaders.get(session.sessionId)?.turnOpen
          ?? devinReaders.get(session.sessionId)?.turnOpen
          ?? commandcodeNormalizers.get(session.sessionId)?.turnOpen
          ?? false,
      )
    }
  }
  watcher.start()
  await cursorDiscovery.start()
  agentReconciler.start(env.TMUX_REAP_INTERVAL_MS)
  for (const task of await loadCursorPendingTasks(env.ADAPTER_DATA_DIR)) {
    onCursorTaskStart(task.sessionId, task.toolUseId, task.input)
  }

  // Reconciliation is deliberately full: drain every transcript to EOF, inspect each live pane, then
  // publish every session even when Model/Effort did not change. Reconnect runs the same path, while
  // JSONL watcher events still provide immediate local-to-web updates between these safety passes.
  let reconcileInFlight: Promise<void> | null = null
  let reconcileNeedsDeviceAnnouncement = false
  fullReconcile = (announceDevice = false): Promise<void> => {
    reconcileNeedsDeviceAnnouncement ||= announceDevice
    if (reconcileInFlight) return reconcileInFlight
    reconcileInFlight = (async () => {
      await runtimeProfiles.withoutChangeEvents(async () => {
        await Promise.all(registry.list().map((session) => runtimeProfiles.ingestConfig(session, true)))
        await watcher.pollAll()
        await Promise.all(registry.list().map(async (session) => {
          const capture = await captureTmuxPane(session.tmuxPane, 120)
          if (capture) runtimeProfiles.ingestPane(session, capture, true)
        }))
      })
      await syncPaneTitles()
      const includeDevice = reconcileNeedsDeviceAnnouncement
      reconcileNeedsDeviceAnnouncement = false
      for (const session of registry.list()) {
        if (includeDevice) announceSession(session)
        else syncSession(session)
      }
    })().finally(() => { reconcileInFlight = null })
    return reconcileInFlight
  }
  // Command Code keeps its reasoning level in a config FILE — nothing in the transcript, the pane or the
  // session header announces a change — so without a tick of its own the chip showed a level up to five
  // minutes stale, and never caught an effort the user changed in the CLI. Costs a small JSON read per
  // Command Code session; ingestConfig only emits a change event when the value actually moved.
  const COMMANDCODE_CONFIG_POLL_MS = 10_000
  setInterval(() => {
    for (const session of registry.list()) {
      if (session.engine !== 'commandcode') continue
      void runtimeProfiles.ingestConfig(session).catch(() => undefined)
    }
  }, COMMANDCODE_CONFIG_POLL_MS)

  // Some engines announce a model change nowhere: no transcript row, no config file, no hook — the new
  // model is simply drawn into the pane footer. The 5-minute reconcile was the only reader, so switching
  // model in the terminal took up to five minutes to reach the device.
  //
  //   devin  — the footer is the ONLY source; nothing else ever reports the model.
  //   cursor — the transcript carries the model but never the reasoning level, and the level only exists
  //            in the footer. Without this poll a Cursor session picks up its effort once at attach and
  //            then never again.
  //
  // Read just the footer, and only while such a session exists. NOT silent: a real change has to push to
  // the device, which is the whole point.
  const PANE_POLLED_ENGINES = new Set(['devin', 'cursor', 'grok'])
  const PANE_POLL_MS = 15_000
  setInterval(() => {
    for (const session of registry.list()) {
      if (!PANE_POLLED_ENGINES.has(session.engine)) continue
      void captureTmuxPane(session.tmuxPane, 60)
        .then((capture) => { if (capture) runtimeProfiles.ingestPane(session, capture) })
        .catch(() => undefined)
    }
  }, PANE_POLL_MS)

  const RUNTIME_RECONCILE_MS = 5 * 60_000
  const runtimeReconcileTimer = setInterval(() => {
    void fullReconcile().catch((err) => {
      console.error('[runtime-profile] periodic reconcile failed:', err instanceof Error ? err.message : err)
    })
  }, RUNTIME_RECONCILE_MS)
  const PANE_TITLE_SYNC_MS = 5_000
  const paneTitleSyncTimer = setInterval(() => {
    void syncPaneTitles().catch((err) => {
      console.error('[tmux-title] sync failed:', err instanceof Error ? err.message : err)
    })
  }, PANE_TITLE_SYNC_MS)

  // A device joined mid-turn (count rise or join generation; no adapter heartbeat) → replay live state.
  backend.onCommanderJoin = () => { mirror.replayAll(); questionWatcher.reset() } // re-announce an open question
  backend.onCommanderPresenceChanged = (connected) => {
    setSummaryPoolDeviceConnected(connected)
    setVoiceRouterDeviceConnected(connected)   // warm the voice-router worker while a device is connected
  }

  // Web cancel (C-c) interrupts the turn — claude writes no end_turn line to close it, so stop the
  // heartbeat and mark the turn closed here (mirrors the hosted runtime stopping its heartbeat on cancel). We do
  // NOT emit turn_ended: the web clears its own dots on cancel, and a turn_ended would fire a device
  // recap for a killed turn. The next real prompt reopens a fresh turn.
  backend.onCancel = (id) => {
    const record = registry.resolve(id)
    const sessionId = record?.sessionId ?? id
    const st = turnStates.get(sessionId)
    if (st) st.turnOpen = false
    codexNormalizers.get(sessionId)?.closeTurn()
    cursorNormalizers.get(sessionId)?.closeTurn()
    opencodeReaders.get(sessionId)?.closeTurn()
    piNormalizers.get(sessionId)?.closeTurn()
    museNormalizers.get(sessionId)?.closeTurn()
    ampNormalizers.get(sessionId)?.closeTurn()
    grokNormalizers.get(sessionId)?.closeTurn()
    hermesReaders.get(sessionId)?.closeTurn()
    devinReaders.get(sessionId)?.closeTurn()
    commandcodeNormalizers.get(sessionId)?.closeTurn()
    cursorSubagents.forget(sessionId)
    input.cancel(record?.agentId ?? sessionId)
    stopHeartbeat(sessionId)
    questionWatcher.stop(sessionId)
    mirror.cancel(sessionId) // close the device's "Working…" tile (bare done, no recap) — a cancel emits no turn_ended
  }

  /**
   * Web or device deleted an agent (`agent_delete`): end the AGENT, not the user's window.
   *
   * This used to `tmux kill-pane`, which took the pane down — and with it the window, and the session if
   * that pane was the last one. The pane is the user's; only the exact discovered engine process is
   * signalled. Its PID and start marker are re-validated before SIGTERM/SIGKILL.
   *
   * `registry.remove` + `mirror.forget` keep the recap AND the agent-name override for a later resume.
   */
  backend.onDeleteAgent = (sessionId) => {
    const s = registry.resolve(sessionId) // BEFORE forgetSession — that removes it from the registry
    // The engine outlives this call by a second or two now, and its catch hook fires on every turn
    // boundary. Without the tombstone that hook re-registers the session and the tile comes straight back.
    markDeleted(sessionId)
    if (s?.processIdentity) {
      agentReconciler.suppress({ engine: s.engine, tmuxPane: s.tmuxPane, processIdentity: s.processIdentity })
    }
    forgetSession(sessionId, { force: true })
    if (!s) return
    void terminateDeletedAgent(s, {
      checkRuntime: checkSessionRuntime,
      kill: (pid, signal) => process.kill(pid, signal),
      sleep: (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() }),
      log: (message) => console.log(message),
    }, 0).then((outcome) => {
      console.log(`[delete] ${sid(sessionId)} ${s.engine} · ${outcome}`)
      // Provably gone ⇒ nothing left that could re-register, so stop blocking the id early.
      if (outcome !== 'failed') clearDeleted(sessionId)
      void agentReconciler.trigger()
    }).catch((err) => {
      console.error('[delete] process termination failed:', err instanceof Error ? err.message : err)
    })
  }

  backend.onMessage = (id, content) => {
    const record = registry.resolve(id)
    const sessionId = record?.sessionId ?? id
    const engine = record?.engine ?? 'claude'
    // The backend prepends `/goal ` or `/loop ` without knowing the engine (on the routed path it has
    // not picked an agent yet when the mode is chosen). This is the one place that always knows, so the
    // per-engine adaptation happens here — an unknown slash command would otherwise land as a visible
    // error in the user's terminal instead of running their turn.
    const adapted = adaptSlashCommand(content, engine)
    if (adapted !== content) {
      console.log(`[msg] ${sid(sessionId)} slash-command adapted for engine=${engine} · "${preview(content, 40)}" → "${preview(adapted, 40)}"`)
    }
    console.log(`[msg] ${sid(sessionId)} recv · engine=${engine} · len=${adapted.length} · "${preview(adapted)}"`)
    input.submit(record?.agentId ?? sessionId, adapted)
  }

  // Keep the log file under its cap. This daemon writes it through an inherited stdout fd, so a size
  // check on a timer is the only place that can see it grow — `prepareLogFile` at spawn time alone
  // would let a long-lived, chatty daemon run unbounded between restarts.
  const logTrimTimer = setInterval(() => {
    if (trimLogFile(LOG_FILE)) console.log(`[log] ${tildify(LOG_FILE)} hit its size cap — dropped the oldest half`)
  }, LOG_CHECK_INTERVAL_MS)
  logTrimTimer.unref?.() // never hold the event loop open for log upkeep

  backend.connect()
  console.log(`[cli] dialing ${env.BACKEND_WS_URL}/api/adapter-ws · watching registered sessions for ${ENGINES.length} engines`)

  // ── self-update: poll GCS for a newer bundle → verify+swap → restart IMMEDIATELY (supervised rollback) ──
  //
  // The restart used to wait for the computer to go idle. That wait was unbounded, and "idle" is a set of
  // latches — open turn, settling composer, awaited submit, control lock, recap in flight — so ONE latch
  // left stuck deferred the restart forever. Seen on 2026-07-31: 0.0.26 staged, then eight minutes of
  // "deferring restart — sessions still processing" with the daemon otherwise silent. A daemon that
  // quietly never updates is the exact failure this updater exists to prevent, so the wait is gone
  // (owner call, 2026-07-31): staged means restart now.
  //
  // The cost is real and accepted: a turn streaming at that moment loses the rest of its events, and its
  // clients see no turn_end for it until the new daemon re-attaches the session and the next turn runs.
  let updater: Poller | null = null
  let restarting = false

  // Hand off to a freshly-spawned daemon running the just-swapped cli.js, then SUPERVISE it and roll
  // back to the .prev bytes if it fails to come up. NOT launch() — that refuses while a daemon is alive.
  const restartForUpdate = async (newVersion: string): Promise<void> => {
    if (restarting) return
    restarting = true
    console.log(`[update] applying ${VERSION} → ${newVersion} — restarting daemon`)
    registry.flush()
    updater?.stop()
    agentReconciler.stop()
    clearInterval(logTrimTimer)
    clearInterval(runtimeReconcileTimer)
    clearInterval(paneTitleSyncTimer)
    questionWatcher.stopAll()
    for (const t of heartbeats.values()) clearInterval(t)
    heartbeats.clear()
    cursorSubagents.stop()
    for (const r of opencodeReaders.values()) r.stop()
    for (const r of hermesReaders.values()) r.stop()
    for (const r of devinReaders.values()) r.stop()
    await cursorDiscovery.stop()
    await watcher.stop()
    // Fully release the FIXED hook port BEFORE the child binds (no fallback → EADDRINUSE otherwise).
    ;(hookServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    // Release the fixed hook port before the child binds. Process-owned agents stay in the persisted
    // registry and are revalidated by the new daemon's first discovery passes.
    hookServer.close()
    shutdownSummaryPool()
    shutdownVoiceRouter()
    await backend.stop() // graceful WS close → releases the Redis machine-owner claim
    await new Promise((r) => setTimeout(r, 1000)) // grace before the same-machine reclaim

    const spawnDaemon = (extraEnv: Record<string, string>): ReturnType<typeof spawn> => {
      prepareLogFile(LOG_FILE, LEGACY_LOG_FILE) // before the fd + the sinceOffset below, so both see one size
      const fd = openSync(LOG_FILE, 'a')
      const c = spawn(process.execPath, [SCRIPT_PATH, '__run'], {
        detached: true, env: { ...process.env, ADAPTER_TOKEN: token, ...extraEnv }, stdio: ['ignore', fd, fd],
      })
      // A spawn failure (e.g. EMFILE) emits 'error' on the child; with no listener that is an
      // uncaughtException. Catch it so a failed update-restart can't take the old daemon down.
      c.on('error', (e) => console.error('[update] daemon spawn error:', e instanceof Error ? e.message : e))
      return c
    }

    const sinceOffset = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0
    const child = spawnDaemon({ ADAPTER_UPDATED_TO: newVersion })
    let childExited = false
    child.on('exit', () => { childExited = true })

    // KEEP on connected/unreachable/busy (new build RAN); ROLL BACK only on an early exit or a `fatal`
    // (bad bundle / can't bind). unreachable = backend transient, not a bad build → don't bounce.
    const ready = await waitForReady(sinceOffset, 30_000)
    if (!childExited && ready.state !== 'fatal') {
      try { writeFileSync(PID_FILE, String(child.pid) + '\n') } catch { /* ignore */ }
      child.unref()
      confirmUpdate(env.ADAPTER_CLI_DIR) // drop the .prev backups
      console.log(`[update] now running ${newVersion} (pid ${child.pid})`)
      process.exit(0)
    }
    console.error(`[update] new build failed to start (${childExited ? 'exited' : ready.state}) — rolling back`)
    try { if (child.pid) process.kill(child.pid, 'SIGKILL') } catch { /* ignore */ }
    restoreUpdate(env.ADAPTER_CLI_DIR) // restore .prev → cli.js/notify.mjs
    const good = spawnDaemon({})
    try { writeFileSync(PID_FILE, String(good.pid) + '\n') } catch { /* ignore */ }
    good.unref()
    process.exit(0)
  }

  // Staged → restart, right now. `restartForUpdate` already latches on `restarting`, so a second call
  // (e.g. the poller staging again before teardown finishes) is a no-op rather than two daemons.
  const applyUpdate = (version: string): void => {
    // If the restart handoff itself throws/rejects (I/O fault during teardown), don't let it become an
    // unhandledRejection — log, un-latch `restarting`, and stay on the current build until the next poll.
    void restartForUpdate(version).catch((err) => {
      console.error('[update] restart failed — staying on current build:', err instanceof Error ? err.message : err)
      restarting = false
    })
  }

  // Self-update ONLY manages the INSTALLED copy (`~/.harness/cli/cli.js`). A dev/repo run — `tsx`
  // (`npm run dev`) OR `node dist/cli.js` from the checkout — must NEVER self-update: it would swap
  // the published bundle into ~/.harness/cli and restart, hijacking the version you're developing.
  // Match by inode so symlinks/realpath don't fool it; fall back to a path compare.
  const installedCli = join(env.ADAPTER_CLI_DIR, 'cli.js')
  let isInstalledCopy = SCRIPT_PATH === installedCli
  try { isInstalledCopy = statSync(SCRIPT_PATH).ino === statSync(installedCli).ino } catch { /* keep path compare */ }
  if (isInstalledCopy && !env.ADAPTER_UPDATE_DISABLE) {
    updater = startSelfUpdater({
      currentVersion: VERSION,
      url: env.ADAPTER_UPDATE_URL,
      key: env.ADAPTER_UPDATE_KEY,
      dir: env.ADAPTER_CLI_DIR,
      intervalMs: env.ADAPTER_UPDATE_CHECK_MS,
      onStaged: (v) => applyUpdate(v),
    })
    console.log(`[update] self-update on · v${VERSION} · every ${Math.round(env.ADAPTER_UPDATE_CHECK_MS / 1000)}s`)
  } else if (!env.ADAPTER_UPDATE_DISABLE) {
    console.log(`[update] self-update off · running a dev/repo build (v${VERSION}), not the installed copy`)
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[cli] ${signal} — shutting down`)
    updater?.stop()
    agentReconciler.stop()
    clearInterval(logTrimTimer)
    clearInterval(runtimeReconcileTimer)
    clearInterval(paneTitleSyncTimer)
    questionWatcher.stopAll()
    for (const t of heartbeats.values()) clearInterval(t)
    heartbeats.clear()
    cursorSubagents.stop()
    for (const r of opencodeReaders.values()) r.stop()
    for (const r of hermesReaders.values()) r.stop()
    for (const r of devinReaders.values()) r.stop()
    await cursorDiscovery.stop()
    await watcher.stop()
    hookServer.close()
    shutdownSummaryPool()
    shutdownVoiceRouter()
    await backend.stop()
    try { if (readPid() === process.pid) rmSync(PID_FILE, { force: true }) } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('exit', () => { shutdownSummaryPool(); shutdownVoiceRouter() })

  // This machine was deleted/revoked (from the web, or a 401 on reconnect) → clear the saved credential
  // and shut down. The user reconnects by copying a fresh token from the machine page.
  backend.onRevoked = () => {
    console.log('[cli] this computer was removed from the machine — clearing credentials and stopping')
    try { rmSync(TOKEN_FILE, { force: true }) } catch { /* ignore */ }
    void shutdown('revoked')
  }

  // Mirror the machine's display name to disk so `harness status` (a separate process) can print it.
  backend.onMachineMeta = (name) => {
    try {
      if (name) writeFileSync(MACHINE_NAME_FILE, name + '\n')
      else rmSync(MACHINE_NAME_FILE, { force: true })
    } catch { /* best effort */ }
  }

  // This machine is already connected from ANOTHER machine (HTTP 409). The credential is valid — it's
  // just in use elsewhere — so KEEP the token and stop (no retry loop, no token prompt). The
  // '[backend] machine busy' marker is what the detached parent's waitForReady() greps for.
  backend.onBusy = () => {
    console.log('[backend] machine busy — this machine is already connected from another computer; stopping')
    void shutdown('busy')
  }
}

// ── info block ───────────────────────────────────────────────────────────────────────────────────

/**
 * The version of the daemon that is ACTUALLY running, asked of the daemon itself.
 *
 * `VERSION` is a constant baked into whichever bundle is doing the printing, and that is not always the
 * one running: `harness update` downloads a new build, spawns it, and then prints this block — all from
 * the OLD process — so the block announced the version it was replacing (`✓ installed v0.0.22` followed
 * by `version v0.0.20`). Every other row here is a fact about the daemon (pid, sessions, dashboard); this
 * makes the version one too. Falls back to the local constant when the daemon cannot be reached, which is
 * exactly the case where the printing process IS the only build there is.
 */
async function runningDaemonVersion(): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/status`, {
      signal: AbortSignal.timeout(1_500),
    })
    if (!res.ok) return VERSION
    const body: unknown = await res.json()
    const version = (body as { version?: unknown } | null)?.version
    return typeof version === 'string' && version ? version : VERSION
  } catch {
    return VERSION
  }
}

// `status` is a definitive state — `launch` only prints this after "[backend] connected" (so it's
// "● connected", never a one-shot never-updating "connecting…"); `status` prints running/stopped.
function printInfoBlock(opts: {
  status: string; pid: number; token: string; sessions: number; version: string
}): void {
  const link = `${env.WEB_URL.replace(/\/$/, '')}/machine/${agentIdFromToken(opts.token)}`
  const row = (k: string, v: string): string => `   ${k.padEnd(10)} ${v}`
  const rule = '  ' + '─'.repeat(37)
  console.log('')
  console.log('  machine · remote machine connected')
  console.log(rule)
  console.log(row('status', opts.status))
  // Display name mirrored from the backend by the daemon (machine_meta) — only shown when named.
  const machineName = ((): string => {
    try { return readFileSync(MACHINE_NAME_FILE, 'utf-8').trim() } catch { return '' }
  })()
  if (machineName) console.log(row('machine', machineName))
  console.log(row('version', `v${opts.version}`))
  console.log(row('backend', env.BACKEND_WS_URL))
  console.log(row('watching', tildify(env.CLAUDE_PROJECTS_DIR)))
  console.log(row('agents', `${opts.sessions} running`))
  console.log(row('pid', String(opts.pid)))
  console.log(row('logs', tildify(LOG_FILE)))
  console.log(row('dashboard', `http://127.0.0.1:${daemonPort()}`))
  console.log(rule)
  console.log('   ▸ Open in your browser to chat with this computer:')
  console.log(`     ${link}`)
  console.log('   ▸ Set up a browser:')
  console.log('     harness browser-link')
  console.log('  running in background · stop with: harness stop')
  console.log('')
}

// 'fatal'       = misconfig; retrying is pointless → kill the daemon + error out.
// 'unreachable' = transient (backend deploying / 5xx / slow / not up yet) → the daemon keeps retrying
//                 in the background and connects on its own, so DON'T kill it — just report the state.
// 'deauth' = the saved credential is invalid/revoked (401/403) → clear it and ask for a fresh token.
// 'busy'   = this machine is already connected from another computer (409) → keep token, stop, inform.
interface ReadyResult { state: 'connected' | 'deauth' | 'fatal' | 'unreachable' | 'busy'; detail?: string }

/** Classify a backend connection error from the log tail: a human reason + fatal (won't self-heal) vs
 *  transient (will), and `deauth` for 401/403 (the token is no longer valid). null = no signal yet. */
function connectFailure(tail: string): { detail: string; fatal: boolean; deauth?: boolean; busy?: boolean } | null {
  // The daemon logs this marker when the backend rejected us with 409 (machine held by another computer).
  if (tail.includes('[backend] machine busy')) {
    return { detail: 'this machine is already connected from another computer', fatal: true, busy: true }
  }
  // The daemon couldn't bind the (fixed) hook port → another adapter is almost certainly already
  // running. Fatal: don't sit on "retrying"; tell the user how to find/stop the other one.
  if (/EADDRINUSE|already in use/.test(tail)) {
    return { detail: `hook port ${env.PORT} is already in use — is another machine daemon running? (harness stop, or lsof -ti :${env.PORT} | xargs kill)`, fatal: true }
  }
  const m = tail.match(/Unexpected server response: (\d+)/)
  if (m) {
    const code = Number(m[1])
    // 401/403 = this computer's machine was deleted/revoked (or a bad token) → deauth: clear + re-join.
    // 409 = one machine per machine: already connected from another computer → busy (keep token, stop).
    // 404 = wrong backend / route not deployed → misconfig (fatal, don't wipe the token).
    // 5xx (esp. 502/503/504) = gateway up but the app is deploying/restarting → transient, keep retrying.
    if (code === 409) return { detail: 'this machine is already connected from another computer', fatal: true, busy: true }
    const deauth = code === 401 || code === 403
    return { detail: `backend returned HTTP ${code}`, fatal: deauth || code === 404, deauth }
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(tail)) return { detail: 'host not found (DNS)', fatal: true }
  if (/certificate|CERT_|self-signed/i.test(tail)) return { detail: 'TLS certificate error', fatal: true }
  if (/ECONNREFUSED/.test(tail)) return { detail: 'connection refused', fatal: false } // backend not up yet → retry
  // A 1006 close with no HTTP code — generic "couldn't reach it right now"; transient.
  if (/disconnected \(close 1006\)/.test(tail)) return { detail: 'cannot reach backend', fatal: false }
  return null
}

/** Poll the log until the adapter connects, hits a FATAL error, or the window ends. Transient errors
 *  don't short-circuit — the connection may recover within the window (e.g. a 502 during a deploy). */
async function waitForReady(sinceOffset: number, timeoutMs = 8000): Promise<ReadyResult> {
  const deadline = Date.now() + timeoutMs
  let lastTransient: string | undefined
  while (Date.now() < deadline) {
    let tail = ''
    // Slice the raw BYTES from sinceOffset (a Buffer byte length) THEN decode. The log is full of
    // multi-byte glyphs (→ · ─ ● …), so decoding first and slicing the STRING by that byte count
    // overshoots (byte length > char length) and returns "" — the classic false "no connection".
    try { tail = readFileSync(LOG_FILE).subarray(sinceOffset).toString('utf-8') } catch { /* not yet */ }
    if (tail.includes('[backend] connected')) return { state: 'connected' }
    const fail = connectFailure(tail)
    if (fail?.busy) return { state: 'busy', detail: fail.detail }
    if (fail?.deauth) return { state: 'deauth', detail: fail.detail }
    if (fail?.fatal) return { state: 'fatal', detail: fail.detail }
    if (fail) lastTransient = fail.detail // remember, but keep waiting — it may connect on a retry
    await new Promise((r) => setTimeout(r, 250))
  }
  return { state: 'unreachable', detail: lastTransient ?? `no connection within ${timeoutMs / 1000}s` }
}

// ── daemon start / stop / status ───────────────────────────────────────────────────────────────

/** Daemonize (or run inline) + print the info block. Returns 'deauth' when the saved credential was
 *  rejected (401/403) so the caller (`joinCommand`) can ask for a fresh token; otherwise it exits. */
async function launch(token: string, foreground: boolean): Promise<'deauth' | void> {
  // Foreground mode (supervisor) OR dev/tsx (can't cleanly spawn a .ts detached) → run inline. A 401/403
  // there is handled by backendSocket.onRevoked (clears token + shuts down); no token prompt inline.
  if (foreground || SCRIPT_PATH.endsWith('.ts')) {
    if (!foreground) console.log('[cli] dev mode — running in the foreground (Ctrl-C to stop)')
    await runForeground(token)
    return
  }

  const running = readPid()
  if (running && isAlive(running)) {
    console.log(`machine already running (pid ${running}) — it auto-reconnects.`)
    console.log('  check: harness status   ·   stop: harness stop')
    process.exit(0)
  }

  mkdirSync(env.ADAPTER_DATA_DIR, { recursive: true })
  prepareLogFile(LOG_FILE, LEGACY_LOG_FILE) // adopt an older name + enforce the cap before we tail from here
  const logOffset = existsSync(LOG_FILE) ? readFileSync(LOG_FILE).length : 0
  const logFd = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [SCRIPT_PATH, '__run'], {
    detached: true,
    env: { ...process.env, ADAPTER_TOKEN: token },
    stdio: ['ignore', logFd, logFd],
  })
  writeFileSync(PID_FILE, String(child.pid) + '\n')
  child.unref()

  const ready = await waitForReady(logOffset, CONNECT_WAIT_MS)

  // DEAUTH (401/403): the saved credential is no longer valid — this computer was removed from the machine
  // (or the token is stale). Wipe it, stop the daemon, and signal the caller to ask for a fresh token.
  if (ready.state === 'deauth') {
    try { if (child.pid) process.kill(child.pid, 'SIGTERM') } catch { /* ignore */ }
    rmSync(PID_FILE, { force: true })
    rmSync(TOKEN_FILE, { force: true })
    return 'deauth' // caller decides what to say (saved-token vs. explicit-token error)
  }

  // BUSY (409): one machine per machine — this machine is already connected from another computer. The
  // credential is valid, just in use elsewhere, so KEEP the token; stop the daemon and inform (not a
  // failure, not a retry loop). The user stops the other machine first, then runs `harness join` here.
  if (ready.state === 'busy') {
    try { if (child.pid) process.kill(child.pid, 'SIGTERM') } catch { /* ignore */ }
    rmSync(PID_FILE, { force: true })
    // NB: TOKEN_FILE is intentionally NOT removed — the credential is valid.
    console.log('\n  ℹ This machine is already connected from another computer.')
    console.log('    Only one machine per machine — stop the adapter on that machine first,')
    console.log('    then run `harness join` here again.')
    process.exit(0)
  }

  // FATAL misconfig (wrong route → 404, DNS, TLS): retrying is pointless → kill the daemon and say what
  // to fix. (Not 401/403 — those are handled as deauth above.)
  if (ready.state === 'fatal') {
    try { if (child.pid) process.kill(child.pid, 'SIGTERM') } catch { /* ignore */ }
    rmSync(PID_FILE, { force: true })
    // A hook-port clash isn't a backend problem — it's a duplicate/leftover adapter. Report it as such.
    if (ready.detail?.startsWith('hook port')) {
      console.error(`\n✗ ${ready.detail}`)
      console.error(`  logs   ${tildify(LOG_FILE)}`)
    } else {
      console.error(`\n✗ Could not connect to the backend: ${ready.detail}`)
      console.error(`  backend   ${env.BACKEND_WS_URL}`)
      console.error(`  logs      ${tildify(LOG_FILE)}`)
      console.error('  If this computer was removed from your machine, copy a fresh token and run: harness join <token>')
    }
    process.exit(1)
  }

  // Not connected YET, but transient (backend deploying / 5xx / slow / not up). The daemon is alive and
  // retries with backoff — it will connect on its own — so leave it running and say so plainly (never a
  // meaningless one-shot "connecting…"). The user runs `harness join` once, not on a babysitting loop.
  if (ready.state === 'unreachable') {
    // Lead with the RUNNING state (+ pid), not the error — the daemon IS started and self-retrying, so
    // seeing a pid / "harness stop" later isn't a surprise. This is not a failure; it reconnects itself.
    console.log(`\n● adapter started · running in the background · pid ${child.pid}`)
    console.log(`  Not connected yet — ${ready.detail}. It keeps retrying and connects on its own`)
    console.log('  when the backend is reachable — no need to re-run.')
    console.log(`  backend  ${env.BACKEND_WS_URL}`)
    console.log(`  status   harness status   ·   stop   harness stop   ·   logs  ${tildify(LOG_FILE)}`)
    process.exit(0) // daemon stays alive
  }

  registry.load()
  printInfoBlock({
    status: '● connected',
    pid: child.pid ?? 0,
    token,
    sessions: registry.list().length,
    version: await runningDaemonVersion(),
  })
  process.exit(0)
}

async function stopDaemonProcess(): Promise<{ pid: number | null; stopped: boolean }> {
  const pid = readPid()
  if (!pid || !isAlive(pid)) {
    rmSync(PID_FILE, { force: true })
    return { pid: null, stopped: false }
  }
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && isAlive(pid)) await new Promise((r) => setTimeout(r, 150))
  if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
  rmSync(PID_FILE, { force: true })
  return { pid, stopped: true }
}

/** `harness stop` — SIGTERM the background adapter, SIGKILL if it lingers. */
async function stop(): Promise<void> {
  const r = await stopDaemonProcess()
  if (!r.pid) {
    console.log('machine is not running.')
    process.exit(0)
  }
  console.log(`machine stopped (pid ${r.pid}).`)
  process.exit(0)
}

function clearAdapterState(): void {
  const dataDir = resolve(env.ADAPTER_DATA_DIR)
  const cliDir = resolve(env.ADAPTER_CLI_DIR)
  const rmStateFiles = (dir: string): void => {
    for (const name of [
      'token',
      'adapter.pid',
      'machine.log',
      'adapter.log', // pre-rename name — still cleared so a reset leaves nothing behind
      'computer-id',
      'machine-name',
      'registry.json',
      'registry-boot',
      'agent-names.json',
      'summaries.json',
      'summary-scratch',
      'e2e',
    ]) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
  }
  if (dataDir === cliDir) rmStateFiles(dataDir)
  else rmSync(dataDir, { recursive: true, force: true })
  rmStateFiles(cliDir)
}

/** `adapter reset` — stop the daemon and clear local state so the next join starts fresh. */
async function resetCommand(): Promise<void> {
  const r = await stopDaemonProcess()
  clearAdapterState()
  console.log(`\n  ✓ Cleared local machine CLI state at ${tildify(env.ADAPTER_DATA_DIR)}.`)
  if (r.pid) console.log(`    Stopped adapter process ${r.pid}.`)
  if (env.ADAPTER_TOKEN) console.log('    Note: ADAPTER_TOKEN is still set in the environment and will override disk state.')
  console.log('\n  Start again with: harness join <token>\n')
  process.exit(0)
}

/** Call the running daemon's localhost control API. Exits with a friendly message if it's not up. */
async function daemonCall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ res: Response; json: Record<string, unknown> }> {
  const url = `http://127.0.0.1:${daemonPort()}${path}`
  let res: Response
  try {
    const headers: Record<string, string> = { 'x-adapter-local': '1' } // passes the dashboard CSRF gate
    if (body) headers['content-type'] = 'application/json'
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  } catch {
    console.error('\n  ✗ The adapter is not running on this computer.')
    console.error('    Start it first:  harness join\n')
    process.exit(1)
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { res, json }
}

/** `harness pair <code>` — send a browser/device pairing code to the running daemon (localhost). */
async function pairCommand(code: string | undefined): Promise<void> {
  if (!code) { console.error('Usage: harness pair <code>   (the code is shown on the browser or device)'); process.exit(1) }
  const { res, json } = await daemonCall('POST', '/api/pair', { code })
  const body = json as { label?: string; fingerprint?: string; error?: string }
  if (res.ok) {
    console.log(`\n  ✓ Paired  “${body.label ?? 'browser'}”`)
    console.log(`    fingerprint  ${body.fingerprint ?? '?'}   — verify it matches the browser\n`)
    process.exit(0)
  }
  const messages: Record<string, string> = {
    NO_INTENT: 'No browser or device is waiting to pair.',
    EXPIRED: 'That code expired. Use the fresh code shown on the browser or device.',
    CODE_MISMATCH: 'That code didn’t match. Use the fresh code shown on the browser or device.',
    BACKEND_DOWN: 'The adapter can’t reach the backend right now. Try again shortly.',
    RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
    BUSY: 'A pairing is already in progress.',
    TIMEOUT: 'The browser or device didn’t respond in time. Try again.',
    CANCELLED: 'Pairing was cancelled on the browser or device.',
    PAIRING_UNAVAILABLE: 'This adapter build does not support E2EE pairing.',
  }
  console.error(`\n  ✗ ${messages[body.error ?? ''] ?? `Pairing failed (${body.error ?? res.status}).`}\n`)
  process.exit(1)
}

/** `adapter browser-link` — print a one-time browser setup link for the current machine. */
async function browserLinkCommand(): Promise<void> {
  const token = readSavedToken()
  if (!token) { console.error('\n  ✗ This computer is not joined. Run: harness join <token>\n'); process.exit(1) }
  const agentId = agentIdFromToken(token)
  let url = ''
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort()}/api/e2ee/setup-link`, {
      method: 'POST',
      headers: { 'x-adapter-local': '1' },
    })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { url?: unknown; expiresAt?: unknown; fingerprint?: unknown } | null
      if (typeof body?.url === 'string') url = body.url
    }
  } catch { /* fall back to disk-backed token below */ }
  if (!url) {
    const setup = createSetupToken(agentId)
    url = setupBrowserLink(agentId, setup.token)
  }
  console.log('\n  Browser setup link (valid for 7 days):\n')
  console.log(`    ${url}\n`)
  if (!readPid()) console.log('  Start the adapter with `harness join` if the browser cannot connect.\n')
  process.exit(0)
}

/** `harness pairings` — list the browsers paired for end-to-end encryption. */
async function pairingsCommand(): Promise<void> {
  const { res, json } = await daemonCall('GET', '/api/pairs')
  if (!res.ok) { console.error(`\n  ✗ Could not list pairings (${json.error ?? res.status}).\n`); process.exit(1) }
  const pairs = (json.pairs ?? []) as Array<{ fingerprint: string; label: string; pairedAt: number; online: boolean }>
  if (!pairs.length) { console.log('\n  No browsers paired yet.\n  Open the agent page in a browser to get a pairing code.\n'); process.exit(0) }
  console.log('\n  Paired clients (end-to-end encrypted):\n')
  pairs.forEach((p, i) => {
    const when = new Date(p.pairedAt).toISOString().slice(0, 16).replace('T', ' ')
    console.log(`   ${String(i + 1).padStart(2)}. ${p.fingerprint}  ${p.online ? '● online ' : '○ offline'}  ${p.label}   (paired ${when})`)
  })
  console.log('\n  Unpair one:  harness unpair <#|fingerprint>     ·     Unpair all:  harness unpair --all\n')
  process.exit(0)
}

/** `harness unpair <#|fingerprint>` / `harness unpair --all` — revoke browser pairing(s). */
async function unpairCommand(id: string | undefined, all: boolean): Promise<void> {
  if (all) {
    const { res, json } = await daemonCall('POST', '/api/revoke-all')
    if (!res.ok) { console.error(`\n  ✗ Unpair-all failed (${json.error ?? res.status}).\n`); process.exit(1) }
    const count = Number(json.count ?? 0)
    console.log(`\n  ✓ Unpaired ${count} browser${count === 1 ? '' : 's'}.  Any open ones drop to the pairing screen.\n`)
    process.exit(0)
  }
  if (!id) { console.error('Usage: harness unpair <#|fingerprint>   |   harness unpair --all     (see: harness pairings)'); process.exit(1) }
  const { res, json } = await daemonCall('POST', '/api/revoke', { id })
  if (res.ok) {
    console.log(`\n  ✓ Unpaired  “${json.label ?? 'browser'}”  ${json.fingerprint ?? ''}`)
    console.log('    If that browser is open, it drops to the pairing screen; otherwise it will on next open.\n')
    process.exit(0)
  }
  const msg = json.error === 'AMBIGUOUS'
    ? 'That fingerprint prefix matches more than one browser — use more characters or the list number.'
    : json.error === 'NOT_FOUND' ? 'No paired client matches that id.  Run: harness pairings'
    : `Unpair failed (${json.error ?? res.status}).`
  console.error(`\n  ✗ ${msg}\n`)
  process.exit(1)
}

/** `harness status` — print the info block with the current running state. */
async function status(): Promise<void> {
  const pid = readPid()
  const alive = pid != null && isAlive(pid)
  let token = env.ADAPTER_TOKEN ?? ''
  if (!token) { try { token = readFileSync(TOKEN_FILE, 'utf-8').trim() } catch { /* none */ } }
  if (!token) { console.log('machine: not joined. Run: harness join <token>'); process.exit(0) }
  registry.load()
  printInfoBlock({
    status: alive ? '● running' : '○ stopped',
    pid: pid ?? 0,
    token,
    sessions: registry.list().length,
    // A stopped daemon answers nothing, so this falls back to the local build — which is what will run.
    version: alive ? await runningDaemonVersion() : VERSION,
  })
  process.exit(0)
}

// ── arg parse ──────────────────────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv
const flags = rest.filter((a) => a.startsWith('-'))
const args = rest.filter((a) => !a.startsWith('-'))
const foreground = flags.includes('--foreground') || flags.includes('-f')

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') usage()
if (cmd === 'version' || cmd === '--version' || cmd === '-v') { console.log(VERSION); process.exit(0) }

const onError = (err: unknown): never => {
  console.error('Failed to start adapter:', err)
  process.exit(1)
}

switch (cmd) {
  case 'join':
    joinCommand(foreground, args[0]).catch(onError)
    break
  case 'unjoin':
    unjoin().catch(onError)
    break
  // `start` is superseded by `join` (saved reconnect / `join <token>`). Kept as a deprecated
  // alias so muscle memory / old scripts don't break — including the old `start <token>` form.
  case 'start':
    console.error('(note: "harness start" is now "harness join")')
    joinCommand(foreground, args[0]).catch(onError)
    break
  case '__run': { // internal: the detached daemon child runs the adapter inline (token via env)
    const t = readSavedToken()
    if (!t) onError(new Error('no credential for __run'))
    else runForeground(t).catch(onError)
    break
  }
  case 'pair':
    pairCommand(args[0]).catch(onError)
    break
  case 'browser-link':
    browserLinkCommand().catch(onError)
    break
  case 'e2ee-link':
    console.error('(note: "harness e2ee-link" is deprecated — use "harness browser-link")')
    browserLinkCommand().catch(onError)
    break
  case 'pairings':
    pairingsCommand().catch(onError)
    break
  case 'unpair':
    unpairCommand(args[0], flags.includes('--all') || flags.includes('-a')).catch(onError)
    break
  // Hidden deprecated aliases (superseded by pairings / unpair) — kept so early scripts don't break.
  case 'pairs':
  case 'list-pairs':
    console.error(`(note: "${cmd}" is deprecated — use "harness pairings")`)
    pairingsCommand().catch(onError)
    break
  case 'revoke':
    console.error('(note: "revoke" is deprecated — use "harness unpair <#|fingerprint>")')
    unpairCommand(args[0], false).catch(onError)
    break
  case 'revoke-all':
    console.error('(note: "revoke-all" is deprecated — use "harness unpair --all")')
    unpairCommand(undefined, true).catch(onError)
    break
  case 'stop':
    stop().catch(onError)
    break
  case 'reset':
    resetCommand().catch(onError)
    break
  case 'status':
    status().catch(onError)
    break
  case 'update':
    updateCommand().catch(onError)
    break
  default:
    console.error(`Unknown command: ${cmd}`)
    usage()
}
