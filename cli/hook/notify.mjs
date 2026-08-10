#!/usr/bin/env node
/**
 * Pane-scoped session hook shared by the supported hook-capable engines.
 *
 * Self-contained — node built-ins only, no dependency on the adapter's
 * node_modules (it runs inside the user's `claude` process).
 *
 * SessionStart: registers { tmuxPane, sessionId, transcriptPath, cwd } with the
 *   adapter — but only when running inside tmux ($TMUX_PANE set).
 * SessionEnd:   asks the adapter to reconcile the pane; process discovery remains
 *   the authority for whether the agent exists.
 *
 * Always exits 0 quickly and swallows every error, so it can never block or
 * delay claude's session start/teardown.
 */

import http from 'node:http'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { homedir, uptime } from 'node:os'

const BOOT_TOLERANCE_SEC = 120
const LOCK_STALE_MS = 5000
const LOCK_RETRIES = 20
const LOCK_RETRY_MS = 25
const CURSOR_TASK_MAX_AGE_MS = 10 * 60_000
const CURSOR_TASK_MAX_ENTRIES = 64
const CURSOR_TASK_MAX_INPUT_BYTES = 128 * 1024
const CODEX_META_MAX_BYTES = 128 * 1024

// Claude Code reports the model as {id, display_name}; Codex/Cursor as a plain string. The registry stores
// a string, so pick the id rather than shipping the object.
function modelName(value) {
  if (typeof value === 'string') return value
  return typeof value?.id === 'string' ? value.id : null
}

function argPort() {
  const i = process.argv.indexOf('--port')
  if (i !== -1 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10)
  return parseInt(process.env.AGENT_ADAPTER_PORT || '18473', 10)
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function argEngine() {
  const i = process.argv.indexOf('--engine')
  const value = i !== -1 ? process.argv[i + 1] : ''
  return value === 'codex' || value === 'cursor' || value === 'hermes' || value === 'commandcode' || value === 'devin' || value === 'muse' || value === 'grok' ? value : 'claude'
}

function paths() {
  const cliDir = join(homedir(), '.harness', 'cli')
  const dataDir = argValue('--data-dir', process.env.ADAPTER_DATA_DIR || join(cliDir, 'data'))
  const claudeProjectsDir = argValue('--claude-projects-dir', process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects'))
  const codexHome = argValue('--codex-home', process.env.CODEX_HOME || join(homedir(), '.codex'))
  const grokHome = argValue('--grok-home', process.env.GROK_HOME || join(homedir(), '.grok'))
  const cursorHome = argValue('--cursor-home', process.env.CURSOR_HOME || join(homedir(), '.cursor'))
  const hermesHome = argValue('--hermes-home', process.env.HERMES_HOME || join(homedir(), '.hermes'))
  const commandcodeHome = argValue('--commandcode-home', process.env.COMMANDCODE_HOME || join(homedir(), '.commandcode'))
  const devinHome = argValue('--devin-home', process.env.DEVIN_HOME || join(homedir(), '.local', 'share', 'devin', 'cli'))
  return {
    dataDir,
    registryFile: join(dataDir, 'registry.json'),
    bootFile: join(dataDir, 'registry-boot'),
    claudeProjectsDir,
    codexSessionsDir: join(codexHome, 'sessions'),
    grokSessionsDir: join(grokHome, 'sessions'),
    cursorProjectsDir: join(cursorHome, 'projects'),
    hermesDb: join(hermesHome, 'state.db'),
    commandcodeProjectsDir: join(commandcodeHome, 'projects'),
    devinHome,
    devinLocksDir: join(devinHome, 'session_locks'),
  }
}

/** True when the path is a real file on disk right now (undefined/missing → false). */
function existsPath(file) {
  if (typeof file !== 'string' || !file) return false
  try { return statSync(file).isFile() } catch { return false }
}

/** Resolve Grok's authoritative update log. Normal paths use URL-encoded cwd; very long paths use a
 * hashed directory with a `.cwd` sidecar, so scan only that one level as a bounded fallback. */
function grokTranscriptPath(p, cwd, sessionId) {
  if (typeof cwd !== 'string' || !cwd || typeof sessionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return ''
  const direct = join(p.grokSessionsDir, encodeURIComponent(cwd), sessionId, 'updates.jsonl')
  if (existsPath(direct)) return direct
  try {
    for (const entry of readdirSync(p.grokSessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const group = join(p.grokSessionsDir, entry.name)
      let recorded = ''
      try { recorded = readFileSync(join(group, '.cwd'), 'utf8').trim() } catch { continue }
      if (recorded !== cwd) continue
      const candidate = join(group, sessionId, 'updates.jsonl')
      if (existsPath(candidate)) return candidate
    }
  } catch { /* state root may not exist yet */ }
  return ''
}

function grokHookEvent(value) {
  const key = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  return ({
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    stop: 'Stop',
    stop_failure: 'StopFailure',
  })[key] || ''
}

/**
 * True when a hook payload came from Devin rather than the engine the hook was armed for. Devin session
 * ids are lowercase word slugs (`blue-agustinia`) and every live session holds
 * `<DEVIN_HOME>/session_locks/<id>.lock`, while claude's are UUIDs — so the lock file is the tell.
 */
function isDevinSession(input, p) {
  const id = typeof input?.session_id === 'string' ? input.session_id : ''
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) return false
  try { return statSync(join(p.devinLocksDir, `${id}.lock`)).isFile() } catch { return false }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
    // Safety: if stdin never ends, don't hang.
    setTimeout(() => resolve(data), 1000)
  })
}

function post(port, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 1500,
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300))
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.write(payload)
    req.end()
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function execFileText(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

async function panePid(pane) {
  const stdout = await execFileText('tmux', ['display-message', '-p', '-t', pane, '#{pane_pid}'], 2000)
  if (stdout === null) return undefined
  const pid = Number((stdout || '').trim())
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function argvTokens(args) {
  return (String(args || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => {
    const quoted = (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
    return quoted ? token.slice(1, -1) : token
  })
}

function processEntrypoint(args) {
  const tokens = argvTokens(args)
  if (!tokens.length) return ''
  let index = 0
  let command = basename(tokens[index]).toLowerCase()
  if (command === 'env') {
    index++
    while (index < tokens.length && (tokens[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index++
    command = basename(tokens[index] || '').toLowerCase()
  }
  if (!/^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)*)?|bash|zsh|sh)$/.test(command)) return tokens[index] || ''
  index++
  const optionsWithValue = new Set(['-r', '--require', '--loader', '--import', '--conditions', '--inspect-port'])
  const inlineCodeOptions = new Set(['-c', '--command', '-e', '--eval', '--print'])
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '--') { index++; break }
    if (token === '-m' && index + 1 < tokens.length) return tokens[index + 1]
    if (inlineCodeOptions.has(token)) return ''
    if (!token.startsWith('-')) break
    index += optionsWithValue.has(token) && index + 1 < tokens.length ? 2 : 1
  }
  return tokens[index] || ''
}

const ENGINE_COMMANDS = {
  claude: 'claude', codex: 'codex', cursor: 'agent', hermes: 'hermes', commandcode: 'cmd',
  devin: 'devin', muse: 'muse', grok: 'grok',
}
const ENGINE_PATH_ENV = {
  claude: 'CLAUDE_PATH', codex: 'CODEX_PATH', cursor: 'CURSOR_PATH', hermes: 'HERMES_PATH',
  commandcode: 'COMMANDCODE_PATH', devin: 'DEVIN_PATH', muse: 'MUSE_PATH', grok: 'GROK_PATH',
}

function processMatchScore(row, engine) {
  const executable = basename(row.executable).toLowerCase()
  const entrypoint = processEntrypoint(row.args).toLowerCase()
  const entrybase = basename(entrypoint).toLowerCase()
  const configured = String(process.env[ENGINE_PATH_ENV[engine]] || ENGINE_COMMANDS[engine] || '').toLowerCase()
  const configuredBase = basename(configured).toLowerCase()
  if (configuredBase && (executable === configuredBase || entrybase === configuredBase
    || row.executable.toLowerCase() === configured || entrypoint === configured)) return 4
  if (engine === 'codex') return /@openai[\/\\]codex[\/\\]bin[\/\\]codex(?:\.js)?$/.test(entrypoint) ? 2 : 0
  if (engine === 'cursor') {
    if (executable === 'cursor-agent' || entrybase === 'cursor-agent') return 3
    return /cursor-agent[\/\\]versions[\/\\][^/\\]+[\/\\]index\.js$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'commandcode') {
    if (/^\s*⌘(?:\s|$)/.test(row.executable) || /^\s*⌘(?:\s|$)/.test(row.args)
      || executable === 'commandcode' || executable === 'command-code'
      || entrybase === 'commandcode' || entrybase === 'command-code') return 3
    return /command-code[\/\\]dist[\/\\]index\.mjs$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'devin') return /devin[\/\\]cli[\/\\]_versions[\/\\][^/\\]+[\/\\]bin[\/\\]devin$/.test(entrypoint) ? 2 : 0
  if (engine === 'hermes') return /hermes-agent[\/\\]hermes$/.test(entrypoint)
    || /^(?:hermes|hermes_cli)(?:\.|$)/.test(entrypoint) ? 2 : 0
  if (engine === 'muse') return /^muse-bin-/.test(executable) || /^muse-bin-/.test(entrybase) ? 3 : 0
  if (engine === 'grok') return /\.grok[\/\\]bin[\/\\]grok$/.test(entrypoint) ? 2 : 0
  return /@anthropic-ai[\/\\]claude-code[\/\\]cli\.js$/.test(entrypoint) ? 2 : 0
}

async function processRows() {
  const stdout = await execFileText('ps', ['-axo', 'pid=,ppid=,comm=,lstart=,args='], 3000)
  if (stdout === null) return null
  const rows = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      executable: match[3],
      startMarker: match[4],
      args: match[5],
    })
  }
  return rows
}

async function paneEngineProcess(pane, engine) {
  const rootPid = await panePid(pane)
  if (rootPid === undefined) return { state: 'unknown' }
  if (!rootPid) return { state: 'gone' }
  const rows = await processRows()
  if (!rows) return { state: 'unknown' }
  const children = new Map()
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  for (const row of rows) {
    const list = children.get(row.parentPid) || []
    list.push(row)
    children.set(row.parentPid, list)
  }
  const queue = [{ pid: rootPid, depth: 0 }]
  let best = null
  while (queue.length > 0) {
    const current = queue.shift()
    const row = byPid.get(current.pid)
    const score = row ? processMatchScore(row, engine) : 0
    if (row && score > 0 && (!best || current.depth < best.depth || (current.depth === best.depth && score > best.score))) {
      best = { row, depth: current.depth, score }
    }
    for (const child of children.get(current.pid) || []) queue.push({ pid: child.pid, depth: current.depth + 1 })
  }
  return best ? {
    state: 'alive',
    identity: { pid: best.row.pid, executable: best.row.executable, startMarker: best.row.startMarker },
  } : { state: 'gone' }
}

/**
 * Hermes delegation children execute the same pane-scoped hook as the visible CLI session. During
 * daemon downtime the regular hook server cannot apply its source guard, so consult Hermes' own store
 * before writing the offline registry. Unknown is deliberately fail-closed: the startup reconciler can
 * still create the process-owned agent and session repair can bind it once the daemon returns, whereas
 * accepting an unknown row can replace the parent's session with a child.
 */
async function hermesTopLevelSession(dbPath, sessionId) {
  if (!/^[0-9]{8}_[0-9]{6}_[0-9a-fA-F]{4,16}$/.test(String(sessionId || ''))) return false
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(75)
    const raw = await execFileText('sqlite3', [
      '-json', '-cmd', '.timeout 500', '-cmd', 'PRAGMA query_only=1', `file:${dbPath}?mode=ro`,
      `SELECT source FROM sessions WHERE id = '${sessionId}';`,
    ], 1000)
    if (raw === null) return false
    try {
      const rows = JSON.parse(raw.trim() || '[]')
      if (!Array.isArray(rows) || rows.length === 0) continue
      const source = typeof rows[0]?.source === 'string' ? rows[0].source : ''
      return source === '' || source === 'cli'
    } catch {
      return false
    }
  }
  return false
}

function bootTimeSec() {
  return Math.round(Date.now() / 1000 - uptime())
}

function readSavedBoot(bootFile) {
  try {
    const n = Number(readFileSync(bootFile, 'utf-8').trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeBoot(bootFile) {
  try {
    mkdirSync(dirname(bootFile), { recursive: true })
    writeFileSync(bootFile, String(bootTimeSec()))
  } catch {
    // best effort
  }
}

function rebootedSinceSnapshot(bootFile) {
  const saved = readSavedBoot(bootFile)
  return saved !== null && Math.abs(bootTimeSec() - saved) > BOOT_TOLERANCE_SEC
}

function isWithin(root, file) {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

function validTranscriptPath(engine, filePath, p) {
  try {
    const actual = realpathSync(filePath)
    const root = realpathSync(
      engine === 'codex' ? p.codexSessionsDir
        : engine === 'grok' ? p.grokSessionsDir
        : engine === 'cursor' ? p.cursorProjectsDir
        : engine === 'commandcode' ? p.commandcodeProjectsDir
        : p.claudeProjectsDir,
    )
    const st = statSync(actual)
    if (!st.isFile() || !isWithin(root, actual)) return false
    if (engine === 'cursor') {
      const id = basename(actual).replace(/\.jsonl$/, '')
      if (!id || basename(dirname(actual)) !== id || basename(dirname(dirname(actual))) !== 'agent-transcripts') return false
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return uid === null || st.uid === uid
  } catch {
    return false
  }
}

function isCodexSubagent(input, p) {
  const source = input && typeof input.source === 'object' && !Array.isArray(input.source)
    ? input.source
    : null
  if (source && source.subagent != null) return true
  const file = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  if (!file || !validTranscriptPath('codex', file, p)) return false
  let fd = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(CODEX_META_MAX_BYTES)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytes).toString('utf8').split('\n').find((line) => line.trim())
    if (!firstLine) return false
    const record = JSON.parse(firstLine)
    return record?.type === 'session_meta' && record?.payload?.source?.subagent != null
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

async function withRegistryLock(registryFile, fn) {
  const lockDir = `${registryFile}.lock`
  try { mkdirSync(dirname(registryFile), { recursive: true }) } catch { return }
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      mkdirSync(lockDir)
      try {
        return fn()
      } finally {
        try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    } catch {
      try {
        const st = statSync(lockDir)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) rmSync(lockDir, { recursive: true, force: true })
      } catch {
        // lock disappeared between mkdir attempts
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
}

function readRegistry(file) {
  try {
    const arr = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function writeRegistry(file, sessions) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(sessions, null, 2))
  renameSync(tmp, file)
}

function cursorPendingFile() {
  return join(paths().dataDir, 'cursor-pending-tasks.json')
}

function boundedJson(value) {
  try {
    const serialized = JSON.stringify(value ?? {})
    if (Buffer.byteLength(serialized) <= CURSOR_TASK_MAX_INPUT_BYTES) return JSON.parse(serialized)
  } catch {
    // use the bounded fallback
  }
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    description: typeof input.description === 'string' ? input.description.slice(0, 2_000) : '',
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 16_000) : '',
    model: typeof input.model === 'string' ? input.model.slice(0, 200) : '',
  }
}

async function persistCursorTask(input) {
  const sessionId = input.session_id || input.conversation_id
  const toolUseId = input.tool_use_id
  if (typeof sessionId !== 'string' || !sessionId || typeof toolUseId !== 'string' || !toolUseId) return
  const file = cursorPendingFile()
  await withRegistryLock(file, () => {
    const now = Date.now()
    const existing = readRegistry(file).filter((item) =>
      item
      && typeof item.sessionId === 'string'
      && typeof item.toolUseId === 'string'
      && typeof item.createdAt === 'number'
      && now - item.createdAt <= CURSOR_TASK_MAX_AGE_MS
      && item.toolUseId !== toolUseId)
    existing.push({ sessionId, toolUseId, input: boundedJson(input.tool_input), createdAt: now })
    writeRegistry(file, existing.slice(-CURSOR_TASK_MAX_ENTRIES))
  })
}

async function clearCursorTasks(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return
  const file = cursorPendingFile()
  await withRegistryLock(file, () => {
    const current = readRegistry(file)
    const next = current.filter((item) => !item || item.sessionId !== sessionId)
    if (next.length) writeRegistry(file, next)
    else {
      try { rmSync(file, { force: true }) } catch { /* best effort */ }
    }
  })
}

async function fallbackRegister(input, engine, tmuxPane) {
  const p = paths()
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  const rawSessionId = input.session_id || input.conversation_id
  const sessionId = typeof rawSessionId === 'string' && rawSessionId
    ? rawSessionId
    : (transcriptPath ? basename(transcriptPath).replace(/\.jsonl$/, '') : '')
  if (!sessionId || !/^%\d+$/.test(tmuxPane)) return
  const transcriptOptional = ['cursor', 'opencode', 'kilo', 'pi', 'hermes', 'commandcode', 'devin', 'grok'].includes(engine)
  if (!transcriptOptional && !transcriptPath) return
  if (transcriptPath && !validTranscriptPath(engine, transcriptPath, p)) return
  const process = await paneEngineProcess(tmuxPane, engine)
  if (process.state !== 'alive' || !process.identity) return
  if (engine === 'hermes' && !await hermesTopLevelSession(p.hermesDb, sessionId)) return

  await withRegistryLock(p.registryFile, () => {
    let sessions = rebootedSinceSnapshot(p.bootFile) ? [] : readRegistry(p.registryFile)
    writeBoot(p.bootFile)
    const now = Date.now()
    const sameRuntime = (s) => s && s.tmuxPane === tmuxPane && s.engine === engine
      && (!s.processIdentity || (s.processIdentity.pid === process.identity.pid && s.processIdentity.startMarker === process.identity.startMarker))
    const existingIndex = sessions.findIndex(sameRuntime)
    const existing = existingIndex >= 0 ? sessions[existingIndex] : null
    // A resumed session moves to this process agent; the previous process remains visible but unbound.
    sessions = sessions.map((s) => s && s.sessionId === sessionId && !sameRuntime(s)
      ? { ...s, sessionId: '', boundAt: null, transcriptPath: null, source: null, updatedAt: now }
      : s)
    if (existingIndex < 0) sessions = sessions.filter((s) => !s || s.tmuxPane !== tmuxPane)
    const agentId = typeof existing?.agentId === 'string' && existing.agentId ? existing.agentId : randomUUID()
    const entry = {
      agentId,
      sessionId,
      engine,
      boundAt: Date.now(),
      transcriptPath: transcriptPath || existing?.transcriptPath || null,
      projectDir: engine === 'grok'
        ? basename(typeof input.cwd === 'string' ? input.cwd : '') || sessionId
        : transcriptPath
        ? basename(dirname(transcriptPath))
        : basename(typeof input.cwd === 'string' ? input.cwd : '') || sessionId,
      cwd: typeof input.cwd === 'string' ? input.cwd : (existing?.cwd ?? null),
      tmuxPane,
      source: typeof input.source === 'string' ? input.source : (existing?.source ?? null),
      title: typeof input.session_title === 'string' ? input.session_title : (existing?.title ?? null),
      model: typeof input.model === 'string' ? input.model : (existing?.model ?? null),
      cliVersion: typeof (input.cli_version || input.version) === 'string' ? (input.cli_version || input.version) : (existing?.cliVersion ?? null),
      processIdentity: process.identity,
      registeredAt: typeof existing?.registeredAt === 'number' ? existing.registeredAt : now,
      updatedAt: now,
      lastHookAt: now,
      lastTranscriptAt: typeof existing?.lastTranscriptAt === 'number' ? existing.lastTranscriptAt : now,
    }
    if (existingIndex >= 0) sessions[existingIndex] = entry
    else sessions.push(entry)
    writeRegistry(p.registryFile, sessions)
  })
}

async function fallbackSessionEnd(sessionId, reason, engine, tmuxPane) {
  // SessionEnd is not process-lifetime authority. If the daemon is down, its startup scan will reconcile
  // the actual tmux process; deleting the offline record here would hide a still-running CLI.
  void sessionId; void reason; void engine; void tmuxPane
}

async function main() {
  const port = argPort()
  const engine = argEngine()
  const raw = await readStdin()
  let input = {}
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }

  const event = input.hook_event_name || input.hookEventName
  const tmuxPane = process.env.TMUX_PANE
  if (!tmuxPane) return // tmux-only: ignore every lifecycle event from standalone CLI sessions
  if (engine === 'cursor' && input.is_background_agent === true) return
  if (engine === 'codex' && isCodexSubagent(input, paths())) return
  // Devin's documented user-level hook locations include ~/.claude.json and ~/.claude/settings.json, so a
  // Devin session can fire the machine's CLAUDE hook and register itself as claude (wrong engine, and a
  // session id claude's path validation then rejects). Devin has its own hook installed with
  // `--engine devin`; drop the claude-armed duplicate. Cheap and scoped: a real claude session has a UUID
  // session id and no Devin lock file.
  if (engine === 'claude' && isDevinSession(input, paths())) return

  // Grok's hook payload and event records are camelCase, while every Claude-compatible engine above is
  // snake_case. Its Stop hook is deliberately NOT installed: Grok persists that hook_execution before
  // the final assistant chunk, so treating Stop as authoritative would close the turn too early. The
  // transcript's `turn_completed` record closes normal turns; only StopFailure is needed as an error
  // fallback here.
  if (engine === 'grok') {
    const grokEventName = grokHookEvent(event)
    const sessionId = input.sessionId || input.session_id
    const cwd = input.cwd || input.workspaceRoot
    const transcriptPath = grokTranscriptPath(paths(), cwd, sessionId)
    if (grokEventName === 'SessionEnd') {
      const ok = await post(port, '/api/hook/session-end', { sessionId, reason: input.reason })
      if (!ok) await fallbackSessionEnd(sessionId, input.reason, engine, tmuxPane)
      return
    }
    if (grokEventName === 'StopFailure') {
      await post(port, '/api/hook/turn-stop', { sessionId, transcriptPath, status: 'error' })
      return
    }
    if (grokEventName !== 'SessionStart' && grokEventName !== 'UserPromptSubmit') return
    const body = {
      engine,
      hookEvent: grokEventName,
      sessionId,
      transcriptPath,
      cwd,
      tmuxPane,
      model: modelName(input.model),
      cliVersion: input.cliVersion || input.version,
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (!registered) {
      await fallbackRegister({
        ...input,
        hook_event_name: grokEventName,
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd,
        cli_version: input.cliVersion || input.version,
      }, engine, tmuxPane)
    }
    return
  }

  if (((engine === 'claude' || engine === 'devin') && event === 'SessionEnd') || (engine === 'cursor' && event === 'sessionEnd')) {
    const ok = await post(port, '/api/hook/session-end', {
      sessionId: input.session_id || input.conversation_id,
      reason: input.reason,
    })
    if (!ok) await fallbackSessionEnd(input.session_id || input.conversation_id, input.reason, engine, tmuxPane)
    if (engine === 'cursor' && ok) await clearCursorTasks(input.session_id || input.conversation_id)
    return
  }

  // Command Code's only live signal that a turn is running. Fired per tool call, so the adapter side is
  // idempotent (see onTurnStart) — this opens a turn at the FIRST tool of a turn and is a no-op after.
  if (engine === 'commandcode' && (event === 'PreToolUse' || event === 'preToolUse')) {
    await post(port, '/api/hook/turn-start', {
      sessionId: input.session_id || input.conversation_id,
    })
    return
  }

  if (engine === 'cursor' && event === 'preToolUse') {
    if (input.tool_name === 'Task' && typeof input.tool_use_id === 'string') {
      await persistCursorTask(input)
      await post(port, '/api/hook/tool-start', {
        sessionId: input.session_id || input.conversation_id,
        toolUseId: input.tool_use_id,
        toolName: input.tool_name,
        input: input.tool_input,
      })
    }
    return
  }

  if (engine === 'cursor' && event === 'stop') {
    const sessionId = input.session_id || input.conversation_id
    const body = {
      engine,
      hookEvent: event,
      sessionId,
      transcriptPath: input.transcript_path,
      cwd: Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : input.cwd,
      tmuxPane,
      model: modelName(input.model),
      cliVersion: input.cursor_version || input.version,
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (!registered) await fallbackRegister(input, engine, tmuxPane)
    const stopped = await post(port, '/api/hook/turn-stop', {
      sessionId,
      status: input.status,
      transcriptPath: input.transcript_path,
    })
    if (stopped) await clearCursorTasks(sessionId)
    return
  }

  // Stop / StopFailure (claude): the authoritative turn-close signal, independent of JSONL parsing.
  // Stop fires when Claude finishes responding (incl. max_tokens / refusal); StopFailure fires when the
  // turn ends on an API error (Stop does NOT fire then). Both → tell the adapter to close the turn. We
  // write nothing to stdout so Claude stops normally (only exit 2 / decision:block would continue it).
  // Command Code exposes no UserPromptSubmit, so Stop is its only turn-close signal (same shape as claude's).
  if ((engine === 'claude' || engine === 'commandcode' || engine === 'devin') && (event === 'Stop' || event === 'StopFailure')) {
    // Command Code's whole hook set is PreToolUse/PostToolUse/Stop/SessionStart — no UserPromptSubmit, so
    // Stop is also its ONLY catch hook. Without re-registering here, a session that left the registry for
    // any reason (a reaper miss, a daemon restart, a fresh data dir) can never come back while the CLI
    // keeps running: the web/device just show nothing until the user quits and relaunches commandcode.
    // Registration is idempotent, and this is also where a session first announced without a transcript
    // (Command Code fires SessionStart before creating the file) finally gets its real path.
    if (engine === 'commandcode') {
      const registered = await post(port, '/api/hook/session-start', {
        engine,
        hookEvent: event,
        sessionId: input.session_id,
        transcriptPath: existsPath(input.transcript_path) ? input.transcript_path : undefined,
        cwd: input.cwd,
        tmuxPane,
        title: input.session_title,
        model: modelName(input.model),
        cliVersion: input.cli_version || input.version,
      })
      if (!registered) await fallbackRegister(input, engine, tmuxPane)
    }
    await post(port, '/api/hook/turn-stop', {
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
      status: event === 'StopFailure' ? 'error' : undefined,
    })
    return
  }

  // SessionStart or UserPromptSubmit (the catch hook) → register the session. Registration is
  // idempotent, so re-registering on every prompt is cheap. (We print nothing to stdout, so this
  // never injects context into a UserPromptSubmit turn.)
  // Command Code fires SessionStart BEFORE it writes the transcript, and the daemon validates the path
  // (realpath) — sending one that isn't on disk yet gets the whole registration rejected. Announce
  // without it; the session is registered again with the real path on the first Stop. Scoped to
  // commandcode: every other engine REQUIRES a transcriptPath, so dropping it would break them.
  // Devin keeps history in sessions.db and writes no transcript file (unless the user passes --export),
  // so it registers with none — like opencode/pi/hermes.
  const transcriptPath = engine === 'devin'
    ? undefined
    : engine === 'commandcode' && !existsPath(input.transcript_path)
      ? undefined
      : input.transcript_path
  const body = {
    engine,
    hookEvent: event,
    sessionId: input.session_id || input.conversation_id,
    transcriptPath,
    // Devin's payload carries no cwd; the hook process inherits the session's working directory.
    cwd: Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : (input.cwd || (engine === 'devin' ? process.cwd() : undefined)),
    source: input.source,
    tmuxPane,
    title: input.session_title,
    model: modelName(input.model),
    cliVersion: input.cli_version || input.cursor_version || input.version,
  }
  const ok = await post(port, '/api/hook/session-start', body)
  if (!ok) await fallbackRegister(input, engine, tmuxPane)
}

main()
  .catch(() => {})
  .finally(() => {
    // Cursor and Hermes parse the hook's stdout as JSON; `{}` is the explicit no-op (for Hermes it also
    // guarantees a pre_llm_call hook never injects context). Claude/Codex want no stdout at all.
    const e = argEngine()
    if (e === 'cursor' || e === 'hermes') process.stdout.write('{}\n', () => process.exit(0))
    else process.exit(0)
  })
