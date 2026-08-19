#!/usr/bin/env node
/**
 * Pane-scoped session hook shared by the supported hook-capable engines.
 *
 * Self-contained — node built-ins only, no dependency on the adapter's
 * node_modules (it runs inside the user's `claude` process).
 *
 * SessionStart: registers terminal hints plus session metadata with the adapter,
 *   but only from an authenticated tmux or configured Herdr context.
 * SessionEnd:   asks the adapter to reconcile the terminal; process discovery remains
 *   the authority for whether the agent exists.
 *
 * Always exits 0 quickly and swallows every error, so it can never block or
 * delay claude's session start/teardown.
 */

import http from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
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
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { homedir, uptime } from 'node:os'

const BOOT_TOLERANCE_SEC = 120
const HOOK_STARTED_AT = performance.now()
// Self-imposed budget, well under the 10s timeout the vendor hook entries carry: a hook that overruns
// stalls the user's turn, so every optional step checks `remainingBudget()` and gives up rather than
// block. The override exists because that budget is a wall-clock assumption — on a loaded machine (a
// parallel test run, a busy CI box) a cold Node start plus lock retries can eat it before the offline
// registry fallback is reached, and the fallback then silently does nothing. Tests set it explicitly so
// they measure behaviour instead of the host's load. Clamped, and never below the shipped default.
const HOOK_DEADLINE_MS = Math.min(60_000, Math.max(4500, Number(process.env.HARNESS_HOOK_DEADLINE_MS) || 0))
const EXIT_RESERVE_MS = 500
const LOCK_RETRIES = 60
const LOCK_RETRY_MS = 25
const CURSOR_TASK_MAX_AGE_MS = 10 * 60_000
const CURSOR_TASK_MAX_ENTRIES = 64
const CURSOR_TASK_MAX_INPUT_BYTES = 128 * 1024
const CODEX_META_MAX_BYTES = 128 * 1024

function remainingBudget(reserve = EXIT_RESERVE_MS) {
  return Math.max(0, HOOK_DEADLINE_MS - (performance.now() - HOOK_STARTED_AT) - reserve)
}

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
  return value === 'codex' || value === 'cursor' || value === 'hermes' || value === 'commandcode' || value === 'devin' || value === 'muse' || value === 'grok' || value === 'agy' || value === 'copilot' ? value : 'claude'
}

/** Copilot names its hook event only on the command line, like agy. */
function argCopilotEvent() {
  const i = process.argv.indexOf('--copilot-event')
  const value = i !== -1 ? process.argv[i + 1] : ''
  return ['sessionStart', 'userPromptSubmitted', 'agentStop', 'sessionEnd'].includes(value) ? value : ''
}

/**
 * agy names its hook event nowhere in the payload, so the installer puts it on the command line.
 *
 * Everything else in the payload is camelCase (protojson): `conversationId`, `workspacePaths`,
 * `transcriptPath`, `modelName`, and on Stop `terminationReason` / `fullyIdle`.
 */
function argAgyEvent() {
  const i = process.argv.indexOf('--agy-event')
  const value = i !== -1 ? process.argv[i + 1] : ''
  return value === 'PreInvocation' || value === 'Stop' ? value : ''
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
  const copilotHome = argValue('--copilot-home', process.env.COPILOT_HOME || join(homedir(), '.copilot'))
  const agyHome = argValue('--agy-home', process.env.AGY_HOME || join(homedir(), '.gemini', 'antigravity-cli'))
  return {
    dataDir,
    registryFile: join(dataDir, 'registry.json'),
    bootFile: join(dataDir, 'registry-boot'),
    claudeProjectsDir,
    codexSessionsDir: join(codexHome, 'sessions'),
    grokHome,
    grokSessionsDir: join(grokHome, 'sessions'),
    cursorProjectsDir: join(cursorHome, 'projects'),
    hermesDb: join(hermesHome, 'state.db'),
    commandcodeProjectsDir: join(commandcodeHome, 'projects'),
    devinHome,
    devinLocksDir: join(devinHome, 'session_locks'),
    agyHome,
    agyBrainDir: join(agyHome, 'brain'),
    agyPresenceDir: join(agyHome, 'presence'),
    copilotHome,
    copilotSessionsDir: join(copilotHome, 'session-state'),
  }
}

/** Copilot's deterministic transcript layout, duplicated here because the hook cannot import src/. */
function copilotTranscriptPath(p, sessionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId || '')) return undefined
  return join(p.copilotSessionsDir, sessionId, 'events.jsonl')
}

/**
 * Is this agy conversation the PANE's, or a sub-agent's?
 *
 * agy gives every sub-agent its own conversation id, its own transcript AND its own hooks — fired with
 * the parent's `TMUX_PANE`. Registering those rebinds the pane to whichever child announced last:
 * measured on a three-sub-agent run as one agent attaching to three different sessions in four
 * seconds, after which the web pane showed the CHILDREN's messages and the parent's `Task` rows never
 * rendered at all.
 *
 * The discriminator is `presence/<id>.lock`, which agy creates only for a top-level conversation —
 * measured: four locks on this machine, all parents; the six sub-agent conversations have none. It is
 * also ordered safely, created BEFORE the first hook of that conversation (lock 17:57:14, first hook
 * 17:57:15, transcript not until 17:57:17), so a real new session is never mistaken for a child.
 */
function agyIsPaneConversation(p, conversationId) {
  if (!conversationId) return false
  try {
    return statSync(join(p.agyPresenceDir, `${conversationId}.lock`)).isFile()
  } catch {
    return false
  }
}

/** agy's deterministic transcript layout, duplicated here because the hook cannot import from src/. */
function agyTranscriptPath(p, conversationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId || '')) return undefined
  return join(p.agyBrainDir, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
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
    const credential = readHookCredential()
    if (!credential) { resolve(false); return }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Harness-Hook-Token': credential,
        },
        timeout: Math.max(1, Math.min(500, remainingBudget())),
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

function secureStateDirectory(directory, create = true) {
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) {
      throw new Error('state directory has unsafe owner or type')
    }
    const mode = stat.mode & 0o777
    if (mode & 0o022) throw new Error('state directory is group/world writable')
    if (mode !== 0o700) {
      fchmodSync(fd, 0o700)
      if ((fstatSync(fd).mode & 0o777) !== 0o700) {
        throw new Error('state directory permissions could not be tightened')
      }
    }
  } finally { closeSync(fd) }
}

function inspectPrivateStateFile(fd, maxBytes = Number.MAX_SAFE_INTEGER) {
  const stat = fstatSync(fd)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (!stat.isFile() || (uid !== null && stat.uid !== uid)) throw new Error('state file has unsafe owner or type')
  if (stat.size > maxBytes) throw new Error('state file exceeds its size limit')
  const mode = stat.mode & 0o777
  if (mode & 0o022) throw new Error('state file is group/world writable')
  if (mode !== 0o600) {
    fchmodSync(fd, 0o600)
    if ((fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error('state file permissions could not be tightened')
    }
  }
}

function readPrivateStateFile(file, maxBytes = Number.MAX_SAFE_INTEGER) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

function hardenPrivateStateFileIfPresent(file, maxBytes = Number.MAX_SAFE_INTEGER) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  try {
    inspectPrivateStateFile(fd, maxBytes)
    return true
  } finally { closeSync(fd) }
}

function readHookCredential() {
  let fd = null
  try {
    const dataDir = paths().dataDir
    secureStateDirectory(dataDir, false)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const file = join(dataDir, 'hook-credential')
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 128 || (stat.mode & 0o777) !== 0o600) return ''
    if (uid !== null && stat.uid !== uid) return ''
    const value = readFileSync(fd, 'utf8').trim()
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ''
  } catch { return '' } finally {
    if (fd !== null) closeSync(fd)
  }
}

function terminalHookFields(tmuxPane) {
  const runtimeHints = []
  if (tmuxPane) runtimeHints.push({ backend: 'tmux', paneId: tmuxPane })
  if (process.env.HERDR_PANE_ID) runtimeHints.push({
    backend: 'herdr',
    paneId: process.env.HERDR_PANE_ID,
    sessionName: process.env.HERDR_SESSION,
    socketPath: process.env.HERDR_SOCKET_PATH,
  })
  return { tmuxPane, runtimeHints, callerPid: process.ppid }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function execFileText(cmd, args, timeout) {
  return new Promise((resolve) => {
    const budget = Math.min(timeout, remainingBudget())
    if (budget < 50) { resolve(null); return }
    execFile(cmd, args, { timeout: budget }, (err, stdout) => {
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
  devin: 'devin', muse: 'muse', grok: 'grok', agy: 'agy', copilot: 'copilot',
}
const ENGINE_PATH_ENV = {
  claude: 'CLAUDE_PATH', codex: 'CODEX_PATH', cursor: 'CURSOR_PATH', hermes: 'HERMES_PATH',
  commandcode: 'COMMANDCODE_PATH', devin: 'DEVIN_PATH', muse: 'MUSE_PATH', grok: 'GROK_PATH',
  agy: 'AGY_PATH', copilot: 'COPILOT_PATH',
}

function executableIdentity(path) {
  try {
    const realPath = realpathSync(path)
    const stat = statSync(realPath)
    return stat.isFile() ? { realPath, fileKey: `${String(stat.dev)}:${String(stat.ino)}` } : null
  } catch {
    return null
  }
}

function commandIdentity(command) {
  if (!command) return null
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    try { accessSync(command, constants.X_OK) } catch { return null }
    return executableIdentity(command)
  }
  for (const dir of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const path = join(dir, command)
    try { accessSync(path, constants.X_OK) } catch { continue }
    const identity = executableIdentity(path)
    if (identity) return identity
  }
  return null
}

function hookCommandOwnership(p) {
  const agent = commandIdentity('agent')
  const cursor = commandIdentity(process.env.CURSOR_PATH || 'cursor-agent')
  const grok = commandIdentity(process.env.GROK_PATH || 'grok') || commandIdentity(join(p.grokHome, 'bin', 'grok'))
  const cursorKeys = new Set(cursor ? [cursor.fileKey] : [])
  const grokKeys = new Set(grok ? [grok.fileKey] : [])
  if (agent && /\/cursor-agent\/versions\/[^/]+\/cursor-agent$/.test(agent.realPath.split(sep).join('/'))) {
    cursorKeys.add(agent.fileKey)
  }
  return { agentFileKey: agent?.fileKey, cursorKeys, grokKeys }
}

function hookFileOwner(fileKey, ownership) {
  if (!fileKey) return 'unknown'
  const isCursor = ownership.cursorKeys.has(fileKey)
  const isGrok = ownership.grokKeys.has(fileKey)
  if (isCursor && isGrok) return 'conflict'
  if (isCursor) return 'cursor'
  if (isGrok) return 'grok'
  return 'unknown'
}

function processMatchScore(row, engine, ownership, allowAgentHint = false) {
  const executable = basename(row.executable).toLowerCase()
  const entrypoint = processEntrypoint(row.args).toLowerCase()
  const entrybase = basename(entrypoint).toLowerCase()
  const explicit = process.env[ENGINE_PATH_ENV[engine]]
  const configured = String(explicit || ENGINE_COMMANDS[engine] || '').toLowerCase()
  const configuredBase = basename(configured).toLowerCase()
  if (configuredBase && configuredBase !== 'agent' && (row.executable.toLowerCase() === configured
    || entrypoint === configured || executable === configuredBase || entrybase === configuredBase)) return 4
  if (engine === 'codex') return /@openai[\/\\]codex[\/\\]bin[\/\\]codex(?:\.js)?$/.test(entrypoint) ? 2 : 0
  if (engine === 'cursor') {
    if (executable === 'cursor-agent' || entrybase === 'cursor-agent') return 3
    if (argvTokens(row.args).slice(0, 8).some((token) =>
      /cursor-agent[\/\\]versions[\/\\][^/\\]+[\/\\]index\.js$/i.test(token))) return 3
    if (executable === 'agent' || entrybase === 'agent') {
      const aliasOwner = hookFileOwner(row.imageFileKey, ownership) !== 'unknown'
        ? hookFileOwner(row.imageFileKey, ownership)
        : hookFileOwner(ownership.agentFileKey, ownership)
      if (aliasOwner === 'cursor') return 4
      if (aliasOwner === 'grok' || aliasOwner === 'conflict') return 0
      return allowAgentHint ? 1 : 0
    }
    return 0
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
  if (engine === 'grok') {
    if (executable === 'grok' || entrybase === 'grok') return 3
    if (executable === 'agent' || entrybase === 'agent') {
      const aliasOwner = hookFileOwner(row.imageFileKey, ownership) !== 'unknown'
        ? hookFileOwner(row.imageFileKey, ownership)
        : hookFileOwner(ownership.agentFileKey, ownership)
      if (aliasOwner === 'grok') return 4
      if (aliasOwner === 'cursor' || aliasOwner === 'conflict') return 0
      return allowAgentHint ? 1 : 0
    }
    return /\.grok[\/\\]bin[\/\\]grok$/.test(entrypoint) ? 2 : 0
  }
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

function aliasRows(rows) {
  return rows.filter((row) => basename(row.executable).toLowerCase() === 'agent'
    || basename(processEntrypoint(row.args)).toLowerCase() === 'agent')
}

async function enrichProcessImages(rows) {
  const candidates = aliasRows(rows)
  if (!candidates.length) return rows
  const images = new Map()
  if (process.platform === 'linux') {
    for (const row of candidates) {
      const identity = executableIdentity(`/proc/${row.pid}/exe`)
      if (identity) images.set(row.pid, identity.fileKey)
    }
  } else if (process.platform === 'darwin') {
    const stdout = await execFileText('lsof', ['-a', '-p', candidates.map((row) => row.pid).join(','), '-d', 'txt', '-Fn'], 1500)
    let pid = null
    let textFile = false
    for (const line of String(stdout || '').split('\n')) {
      if (/^p\d+$/.test(line)) {
        pid = Number(line.slice(1))
        textFile = false
      } else if (line === 'ftxt') {
        textFile = true
      } else if (textFile && pid && line.startsWith('n') && !images.has(pid)) {
        const identity = executableIdentity(line.slice(1).replace(/ \(deleted\)$/, ''))
        if (identity) images.set(pid, identity.fileKey)
        textFile = false
      }
    }
  }
  return rows.map((row) => images.has(row.pid) ? { ...row, imageFileKey: images.get(row.pid) } : row)
}

async function paneEngineProcess(pane, engine) {
  const rootPid = await panePid(pane)
  if (rootPid === undefined) return { state: 'unknown' }
  if (!rootPid) return { state: 'gone' }
  return rootEngineProcess(rootPid, engine)
}

async function rootEngineProcess(rootPid, engine) {
  const rawRows = await processRows()
  if (!rawRows) return { state: 'unknown' }
  const rows = await enrichProcessImages(rawRows)
  const ownership = hookCommandOwnership(paths())
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
    const score = row ? processMatchScore(row, engine, ownership, true) : 0
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

function safePathComponents(path) {
  const root = parse(path).root
  const result = [root]
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    result.push(resolve(result[result.length - 1], component))
  }
  return result
}

function readTerminalSnapshot(p) {
  try {
    const file = join(p.dataDir, 'terminal-config.json')
    secureStateDirectory(p.dataDir, false)
    const snapshot = JSON.parse(readPrivateStateFile(file, 64 * 1024))
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.backends) || !Array.isArray(snapshot.herdrEndpoints)) return null
    return snapshot
  } catch { return null }
}

function checkedHerdrEndpoint(endpoint) {
  try {
    if (!endpoint || typeof endpoint.socketPath !== 'string' || !isAbsolute(endpoint.socketPath)) return false
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (uid === null) return false
    for (const component of safePathComponents(dirname(endpoint.socketPath))) {
      const stat = lstatSync(component)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0)) return false
      if ((stat.mode & 0o002) || (stat.uid === 0 && (stat.mode & 0o020))) return false
    }
    const parent = lstatSync(dirname(endpoint.socketPath))
    const socket = lstatSync(endpoint.socketPath)
    if (parent.uid !== uid || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) return false
    if (realpathSync(endpoint.socketPath) !== resolve(endpoint.socketPath)) return false
    return socket.dev === endpoint.generation?.device && socket.ino === endpoint.generation?.inode
  } catch { return false }
}

function herdrRequest(endpoint, method, params) {
  return new Promise((resolveRequest) => {
    const budget = Math.min(1500, remainingBudget())
    if (budget < 50 || !checkedHerdrEndpoint(endpoint)) { resolveRequest(null); return }
    const id = randomUUID()
    const frame = Buffer.from(`${JSON.stringify({ id, method, params })}\n`)
    if (frame.byteLength > 1024 * 1024) { resolveRequest(null); return }
    let response = Buffer.alloc(0)
    let settled = false
    let socket
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolveRequest(value)
    }
    const timer = setTimeout(() => finish(null), budget)
    try { socket = createConnection({ path: endpoint.socketPath }) } catch { finish(null); return }
    socket.once('connect', () => {
      if (!checkedHerdrEndpoint(endpoint)) { finish(null); return }
      try { socket.end(frame) } catch { finish(null) }
    })
    socket.on('data', (chunk) => {
      response = Buffer.concat([response, chunk])
      if (response.byteLength > 1024 * 1024) { finish(null); return }
      const newline = response.indexOf(0x0a)
      if (newline < 0) return
      if (response.subarray(newline + 1).toString('utf8').trim()) { finish(null); return }
      try {
        const parsed = JSON.parse(response.subarray(0, newline).toString('utf8'))
        finish(parsed?.id === id && parsed.result && !parsed.error ? parsed.result : null)
      } catch { finish(null) }
    })
    socket.once('end', () => finish(null))
    socket.once('error', () => finish(null))
  })
}

async function herdrFallbackRuntime(engine) {
  const hint = terminalHookFields(process.env.TMUX_PANE).runtimeHints.find((runtime) => runtime.backend === 'herdr')
  if (!hint?.sessionName || !hint.socketPath || !hint.paneId) return null
  const snapshot = readTerminalSnapshot(paths())
  if (!snapshot?.backends.includes('herdr')) return null
  const endpoint = snapshot.herdrEndpoints.find((candidate) =>
    candidate?.sessionName === hint.sessionName && candidate?.socketPath === hint.socketPath)
  if (!endpoint || !checkedHerdrEndpoint(endpoint)) return null
  const pong = await herdrRequest(endpoint, 'ping', {})
  if (pong?.type !== 'pong' || pong.protocol !== 19 || !/^0\.8\./.test(String(pong.version || ''))) return null
  const [pane, info] = await Promise.all([
    herdrRequest(endpoint, 'pane.get', { pane_id: hint.paneId }),
    herdrRequest(endpoint, 'pane.process_info', { pane_id: hint.paneId }),
  ])
  if (pane?.type !== 'pane_info' || typeof pane.pane?.terminal_id !== 'string'
    || info?.type !== 'pane_process_info' || !Number.isSafeInteger(info.process_info?.shell_pid)) return null
  const owner = await rootEngineProcess(info.process_info.shell_pid, engine)
  if (owner.state !== 'alive' || !owner.identity) return null
  const rows = await processRows()
  if (!rows) return null
  const parents = new Map(rows.map((row) => [row.pid, row.parentPid]))
  let caller = process.ppid
  const visited = new Set()
  while (caller > 0 && !visited.has(caller) && caller !== owner.identity.pid) {
    visited.add(caller)
    caller = parents.get(caller) || 0
  }
  if (caller !== owner.identity.pid) return null
  return {
    identity: owner.identity,
    runtime: {
      backend: 'herdr', endpointId: endpoint.endpointId, sessionName: endpoint.sessionName,
      terminalId: pane.pane.terminal_id, paneId: pane.pane.pane_id,
    },
  }
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

function currentBootId() {
  try {
    const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (/^[0-9a-f-]{36}$/i.test(value)) return `linux:${value}`
  } catch { /* non-Linux fallback below */ }
  return `time:${bootTimeSec()}`
}

function readSavedBoot(bootFile) {
  try {
    secureStateDirectory(dirname(bootFile), false)
    const raw = readPrivateStateFile(bootFile, 256).trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : raw
    } catch { return raw }
  } catch {
    return null
  }
}

function writeBoot(bootFile) {
  let tmp = ''
  let renamed = false
  try {
    secureStateDirectory(dirname(bootFile))
    hardenPrivateStateFileIfPresent(bootFile, 256)
    tmp = `${bootFile}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, currentBootId()); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, bootFile)
    renamed = true
    const directoryFd = openSync(dirname(bootFile), 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  } catch {
    // best effort
  } finally {
    if (tmp && !renamed) {
      try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    }
  }
}

function rebootedSinceSnapshot(bootFile) {
  const saved = readSavedBoot(bootFile)
  if (saved === null) return false
  const current = currentBootId()
  if (saved.startsWith('linux:')) return saved !== current
  const savedNumber = Number(saved.replace(/^time:/, ''))
  const currentNumber = current.startsWith('time:') ? Number(current.slice(5)) : bootTimeSec()
  return !Number.isFinite(savedNumber) || Math.abs(currentNumber - savedNumber) > BOOT_TOLERANCE_SEC
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
        : engine === 'agy' ? p.agyBrainDir
        : engine === 'copilot' ? p.copilotSessionsDir
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

function removeLockOwnedBy(lockDir, token) {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'))
    if (owner?.token === token) rmSync(lockDir, { recursive: true, force: true })
  } catch { /* another owner or unsafe artifact must not be removed */ }
}

function processStartMarker(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (fields[19]) return `linux:${fields[19]}`
  } catch { /* non-Linux or exited process; use ps below */ }
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1000,
    }).trim()
    return started ? `ps:${started}` : null
  } catch { return null }
}

function processAlive(pid, startMarker = '') {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0) } catch (error) { if (error?.code !== 'EPERM') return false }
  if (!startMarker) return true
  const current = processStartMarker(pid)
  return current === null || current === startMarker
}

async function withRegistryLock(registryFile, fn) {
  const lockDir = `${registryFile}.lock`
  const dataDir = dirname(registryFile)
  try {
    secureStateDirectory(dataDir)
  } catch { return }
  const processMarker = processStartMarker(process.pid) || ''
  for (let i = 0; i < LOCK_RETRIES; i++) {
    if (remainingBudget(750) < 50) return
    const token = randomUUID()
    let created = false
    try {
      mkdirSync(lockDir, { mode: 0o700 })
      created = true
      const ownerFile = join(lockDir, 'owner.json')
      const ownerFd = openSync(ownerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeFileSync(ownerFd, JSON.stringify({ pid: process.pid, startMarker: processMarker, token }))
        fsyncSync(ownerFd)
      } finally { closeSync(ownerFd) }
      try {
        return fn()
      } finally {
        removeLockOwnedBy(lockDir, token)
      }
    } catch (error) {
      if (created) removeLockOwnedBy(lockDir, token)
      if (error?.code !== 'EEXIST') return
      try {
        const uid = typeof process.getuid === 'function' ? process.getuid() : null
        const st = lstatSync(lockDir)
        const ownerStat = lstatSync(join(lockDir, 'owner.json'))
        if (!st.isDirectory() || st.isSymbolicLink() || (uid !== null && st.uid !== uid) || (st.mode & 0o777) !== 0o700
          || !ownerStat.isFile() || ownerStat.isSymbolicLink() || (uid !== null && ownerStat.uid !== uid)
          || (ownerStat.mode & 0o777) !== 0o600) return
        const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'))
        const ownerPid = Number(owner?.pid)
        const ownerStartMarker = typeof owner?.startMarker === 'string' ? owner.startMarker : ''
        const ownerToken = typeof owner?.token === 'string' ? owner.token : ''
        if (!processAlive(ownerPid, ownerStartMarker) && ownerPid > 0 && ownerToken) {
          const current = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'))
          if (Number(current?.pid) === ownerPid
            && current?.startMarker === ownerStartMarker
            && current?.token === ownerToken
            && !processAlive(ownerPid, ownerStartMarker)) {
            rmSync(lockDir, { recursive: true, force: true })
            continue
          }
        }
      } catch {
        // Lock disappeared or is still being initialized; wait without stealing it.
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
}

function readJsonArray(file) {
  try {
    secureStateDirectory(dirname(file), false)
    const arr = JSON.parse(readPrivateStateFile(file))
    return Array.isArray(arr) ? arr : []
  } catch (error) {
    return error?.code === 'ENOENT' ? [] : null
  }
}

function readRegistryState(file) {
  try {
    secureStateDirectory(dirname(file), false)
    const rows = JSON.parse(readPrivateStateFile(file))
    if (!Array.isArray(rows)) return null
    if (rows.some((row) => row && typeof row === 'object'
      && Object.hasOwn(row, 'schemaVersion') && row.schemaVersion !== 2)) return null
    const legacyRows = rows.filter((row) => !row || typeof row !== 'object' || !Object.hasOwn(row, 'schemaVersion'))
    if (legacyRows.some((row) => !validLegacyRegistryRow(row))) return null
    const v2Rows = rows.filter((row) => row && typeof row === 'object' && row.schemaVersion === 2)
    if (v2Rows.length && !validV2Registry(v2Rows)) return null
    return rows
  } catch (error) {
    return error?.code === 'ENOENT' ? [] : null
  }
}

function writeRegistry(file, sessions) {
  secureStateDirectory(dirname(file))
  hardenPrivateStateFileIfPresent(file)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(sessions, null, 2))
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(tmp, file)
    renamed = true
    const directoryFd = openSync(dirname(file), 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  } finally {
    if (!renamed) {
      try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }
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
    const current = readJsonArray(file)
    if (current === null) return
    const existing = current.filter((item) =>
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
    const current = readJsonArray(file)
    if (current === null) return
    const next = current.filter((item) => !item || item.sessionId !== sessionId)
    if (next.length) writeRegistry(file, next)
    else {
      try { rmSync(file, { force: true }) } catch { /* best effort */ }
    }
  })
}

function runtimeRouteKey(runtime) {
  return runtime.backend === 'tmux'
    ? `tmux\u0000${runtime.paneId}`
    : `herdr\u0000${runtime.endpointId}\u0000${runtime.paneId}`
}

function runtimePlacementKey(runtime) {
  return runtime.backend === 'tmux'
    ? runtimeRouteKey(runtime)
    : `herdr\u0000${runtime.endpointId}\u0000${runtime.terminalId}`
}

function mergeRuntimes(current, observed) {
  const merged = new Map()
  for (const runtime of [...(Array.isArray(current) ? current : []), ...observed]) {
    if (runtime?.backend === 'tmux' || runtime?.backend === 'herdr') merged.set(runtimePlacementKey(runtime), runtime)
  }
  return [...merged.values()].sort((a, b) => runtimePlacementKey(a).localeCompare(runtimePlacementKey(b)))
}

const REGISTRY_ENGINES = new Set([
  'claude', 'codex', 'cursor', 'opencode', 'pi', 'hermes', 'commandcode', 'devin', 'muse', 'amp', 'kilo', 'grok',
  'agy', 'copilot',
])

function validRegistryString(value, max = 4096) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function validRegistryRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return false
  if (runtime.backend === 'tmux') return typeof runtime.paneId === 'string' && /^%\d+$/.test(runtime.paneId)
  return runtime.backend === 'herdr'
    && validRegistryString(runtime.endpointId, 200) && runtime.endpointId.length > 0
    && validRegistryString(runtime.sessionName, 64) && runtime.sessionName.length > 0
    && validRegistryString(runtime.terminalId, 200) && runtime.terminalId.length > 0
    && validRegistryString(runtime.paneId, 200) && runtime.paneId.length > 0
}

function validRegistryProcess(identity) {
  return identity === null || (!!identity && typeof identity === 'object'
    && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && validRegistryString(identity.executable, 1000)
    && validRegistryString(identity.startMarker, 200) && identity.startMarker.length > 0)
}

function validV2Registry(rows) {
  const agents = new Set()
  const sessions = new Set()
  const processes = new Set()
  const routes = new Set()
  for (const row of rows) {
    if (row.schemaVersion !== 2 || row.active !== true && row.active !== false
      || !validRegistryString(row.agentId, 200) || !row.agentId
      || !validRegistryString(row.sessionId, 200)
      || !REGISTRY_ENGINES.has(row.engine)
      || !validRegistryString(row.projectDir)
      || !Array.isArray(row.runtimes) || !row.runtimes.length || !row.runtimes.every(validRegistryRuntime)
      || typeof row.primaryRuntimeKey !== 'string'
      || !validRegistryProcess(row.processIdentity)) return false
    const placementKeys = row.runtimes.map(runtimePlacementKey)
    if (new Set(placementKeys).size !== placementKeys.length) return false
    const routeKeys = row.runtimes.map(runtimeRouteKey)
    if (row.active ? !routeKeys.includes(row.primaryRuntimeKey) : row.primaryRuntimeKey !== '') return false
    const tmuxProjection = row.runtimes.find((runtime) => runtime.backend === 'tmux')?.paneId
    if (tmuxProjection ? row.tmuxPane !== tmuxProjection : Object.hasOwn(row, 'tmuxPane')) return false
    if (agents.has(row.agentId)) return false
    agents.add(row.agentId)
    if (row.sessionId) {
      if (sessions.has(row.sessionId)) return false
      sessions.add(row.sessionId)
    }
    if (row.processIdentity) {
      const processKey = `${row.engine}\u0000${row.processIdentity.pid}\u0000${row.processIdentity.startMarker}`
      if (processes.has(processKey)) return false
      processes.add(processKey)
    }
    for (const route of routeKeys) {
      if (routes.has(route)) return false
      routes.add(route)
    }
  }
  return true
}

function validLegacyRegistryRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.hasOwn(row, 'schemaVersion')) return false
  const id = typeof row.agentId === 'string' && row.agentId ? row.agentId : row.launcherId
  if (!validRegistryString(id, 200) || !id) return false
  if (row.engine !== undefined && !REGISTRY_ENGINES.has(row.engine)) return false
  if (row.tmuxPane !== undefined && (typeof row.tmuxPane !== 'string' || !/^%\d+$/.test(row.tmuxPane))) return false
  if (row.runtimes !== undefined
    && (!Array.isArray(row.runtimes) || !row.runtimes.length || !row.runtimes.every(validRegistryRuntime))) return false
  return /^%\d+$/.test(row.tmuxPane || '') || (Array.isArray(row.runtimes) && row.runtimes.length > 0)
}

async function callerOwns(identity) {
  const rows = await processRows()
  if (!rows) return false
  const parents = new Map(rows.map((row) => [row.pid, row.parentPid]))
  let pid = process.ppid
  const visited = new Set()
  while (pid > 0 && !visited.has(pid)) {
    if (pid === identity.pid) return true
    visited.add(pid)
    pid = parents.get(pid) || 0
  }
  return false
}

async function fallbackRegister(input, engine, tmuxPane) {
  const p = paths()
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  const rawSessionId = input.session_id || input.conversation_id
  const sessionId = typeof rawSessionId === 'string' && rawSessionId
    ? rawSessionId
    : (transcriptPath ? basename(transcriptPath).replace(/\.jsonl$/, '') : '')
  if (!sessionId) return
  const transcriptOptional = ['cursor', 'opencode', 'kilo', 'pi', 'hermes', 'commandcode', 'devin', 'grok', 'agy', 'copilot'].includes(engine)
  if (!transcriptOptional && !transcriptPath) return
  if (transcriptPath && !validTranscriptPath(engine, transcriptPath, p)) return
  const observations = []
  if (/^%\d+$/.test(tmuxPane || '')) {
    const tmux = await paneEngineProcess(tmuxPane, engine)
    if (tmux.state === 'alive' && tmux.identity && await callerOwns(tmux.identity)) {
      observations.push({ identity: tmux.identity, runtime: { backend: 'tmux', paneId: tmuxPane } })
    }
  }
  const herdr = await herdrFallbackRuntime(engine)
  if (herdr) observations.push(herdr)
  if (!observations.length) return
  const process = observations[0]
  if (observations.some((observation) => observation.identity.pid !== process.identity.pid
    || observation.identity.startMarker !== process.identity.startMarker)) return
  const observedRuntimes = observations.map((observation) => observation.runtime)
  if (engine === 'hermes' && !await hermesTopLevelSession(p.hermesDb, sessionId)) return

  await withRegistryLock(p.registryFile, () => {
    if (remainingBudget(600) < 50) return
    const loaded = rebootedSinceSnapshot(p.bootFile) ? [] : readRegistryState(p.registryFile)
    // Corrupt/non-array/unknown-schema/unsafe bytes are operator-owned recovery data. Never turn them
    // into an empty registry merely because the daemon is down.
    if (loaded === null) return
    let sessions = loaded
    writeBoot(p.bootFile)
    const now = Date.now()
    const sameRuntime = (s) => s && s.engine === engine
      && s.processIdentity?.pid === process.identity.pid && s.processIdentity?.startMarker === process.identity.startMarker
    const existingIndex = sessions.findIndex(sameRuntime)
    const existing = existingIndex >= 0 ? sessions[existingIndex] : null
    // A resumed session moves to this process agent; the previous process remains visible but unbound.
    sessions = sessions.map((s) => s && s.sessionId === sessionId && !sameRuntime(s)
      ? { ...s, sessionId: '', boundAt: null, transcriptPath: null, source: null, updatedAt: now }
      : s)
    const routeKeys = new Set(observedRuntimes.map(runtimeRouteKey))
    if (existingIndex < 0) sessions = sessions.filter((s) => !s || !(Array.isArray(s.runtimes)
      ? s.runtimes.some((runtime) => routeKeys.has(runtimeRouteKey(runtime)))
      : s.tmuxPane && routeKeys.has(runtimeRouteKey({ backend: 'tmux', paneId: s.tmuxPane }))))
    const agentId = typeof existing?.agentId === 'string' && existing.agentId ? existing.agentId : randomUUID()
    const runtimes = mergeRuntimes(existing?.runtimes, observedRuntimes)
    const tmuxProjection = runtimes.find((runtime) => runtime.backend === 'tmux')?.paneId || ''
    const entry = {
      schemaVersion: 2,
      active: true,
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
      runtimes,
      primaryRuntimeKey: existing?.primaryRuntimeKey && runtimes.some((runtime) => runtimeRouteKey(runtime) === existing.primaryRuntimeKey)
        ? existing.primaryRuntimeKey
        : runtimeRouteKey(observedRuntimes[0]),
      tmuxPane: tmuxProjection,
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
    if (!tmuxProjection) delete entry.tmuxPane
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
  if (!tmuxPane && !process.env.HERDR_PANE_ID) return
  const mutationFields = { engine, ...terminalHookFields(tmuxPane) }
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
  // Copilot: every event carries `sessionId` and `cwd`, and `agentStop` additionally names the
  // transcript. `sessionStart` fires AFTER the first prompt (measured: userPromptSubmitted at
  // …796411, sessionStart at …798963), so registration is driven by whichever arrives first —
  // both are idempotent.
  if (engine === 'copilot') {
    const copilotEvent = argCopilotEvent()
    if (!copilotEvent) return
    const sessionId = input.sessionId
    const p = paths()
    const transcriptPath = existsPath(input.transcriptPath) ? input.transcriptPath : copilotTranscriptPath(p, sessionId)
    const cwd = input.cwd
    if (copilotEvent === 'sessionEnd') {
      const ok = await post(port, '/api/hook/session-end', { sessionId, reason: input.reason, ...mutationFields })
      if (!ok) await fallbackSessionEnd(sessionId, input.reason, engine, tmuxPane)
      return
    }
    if (copilotEvent === 'agentStop') {
      // `stopReason` is `end_turn` on a clean finish; anything else ended the loop early.
      const failed = typeof input.stopReason === 'string' && input.stopReason !== '' && input.stopReason !== 'end_turn'
      await post(port, '/api/hook/turn-stop', {
        sessionId, transcriptPath, status: failed ? 'error' : undefined, ...mutationFields,
      })
      return
    }
    const body = {
      engine,
      hookEvent: 'SessionStart',
      sessionId,
      transcriptPath,
      cwd,
      ...terminalHookFields(tmuxPane),
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (!registered) {
      await fallbackRegister({
        ...input, hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: transcriptPath, cwd,
      }, engine, tmuxPane)
    }
    return
  }

  // agy: the hook is the whole binding. Its `PreInvocation` fires before every model round-trip, so the
  // FIRST one of a turn is the session announce; `Stop` fires exactly once when the execution loop ends
  // and is the authoritative turn boundary (the transcript records no closing marker of its own, and a
  // backgrounded step stays `status: RUNNING` forever because the file is append-only).
  if (engine === 'agy') {
    const agyEvent = argAgyEvent()
    if (!agyEvent) return
    const sessionId = input.conversationId
    const p = paths()
    // A sub-agent's hooks carry the parent's pane; only the pane's own conversation may register.
    if (!agyIsPaneConversation(p, sessionId)) return
    // Trust the payload's path when it resolves; agy's own docs show a workspace-scoped example that
    // does not match what the CLI actually writes, so the derived path is the fallback that does.
    const transcriptPath = existsPath(input.transcriptPath) ? input.transcriptPath : agyTranscriptPath(p, sessionId)
    const cwd = Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : undefined
    if (agyEvent === 'Stop') {
      // agy stops its execution loop as soon as the MODEL has nothing left to say — including the moment
      // it has launched sub-agents and is waiting on them. Measured on a two-sub-agent run: the parent
      // fired Stop twice, first `fullyIdle: false` at the "standing by for their reports" point, then
      // again `fullyIdle: true` when the reports were in. Closing on the first one ended the turn and
      // ran the recap while the work was still going ("chưa done đã recap").
      //
      // So `fullyIdle` is the turn boundary, not Stop itself. A build that omits the field is treated as
      // idle, which is the pre-existing behaviour.
      //
      // A waiting Stop is still REPORTED, as `status: 'waiting'`, rather than swallowed: one measured run
      // finished its sub-agents and never sent another Stop at all, leaving the turn open with nothing
      // coming to close it. The daemon uses this to arm a pane-idle backstop.
      // `terminationReason` is NO_TOOL_CALL on a clean finish; anything else ended the loop early.
      const failed = typeof input.terminationReason === 'string'
        && input.terminationReason !== ''
        && input.terminationReason !== 'NO_TOOL_CALL'
        && input.terminationReason !== 'model_stop'
      const status = input.fullyIdle === false ? 'waiting' : failed || input.error ? 'error' : undefined
      await post(port, '/api/hook/turn-stop', { sessionId, transcriptPath, status, ...mutationFields })
      return
    }
    const body = {
      engine,
      hookEvent: 'SessionStart',
      sessionId,
      transcriptPath,
      cwd,
      ...terminalHookFields(tmuxPane),
      model: modelName(input.modelName),
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (!registered) {
      await fallbackRegister({
        ...input,
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd,
      }, engine, tmuxPane)
    }
    return
  }

  if (engine === 'grok') {
    const grokEventName = grokHookEvent(event)
    const sessionId = input.sessionId || input.session_id
    const cwd = input.cwd || input.workspaceRoot
    const transcriptPath = grokTranscriptPath(paths(), cwd, sessionId)
    if (grokEventName === 'SessionEnd') {
      const ok = await post(port, '/api/hook/session-end', { sessionId, reason: input.reason, ...mutationFields })
      if (!ok) await fallbackSessionEnd(sessionId, input.reason, engine, tmuxPane)
      return
    }
    if (grokEventName === 'StopFailure') {
      await post(port, '/api/hook/turn-stop', { sessionId, transcriptPath, status: 'error', ...mutationFields })
      return
    }
    if (grokEventName !== 'SessionStart' && grokEventName !== 'UserPromptSubmit') return
    const body = {
      engine,
      hookEvent: grokEventName,
      sessionId,
      transcriptPath,
      cwd,
      ...terminalHookFields(tmuxPane),
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
      ...mutationFields,
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
      ...mutationFields,
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
        ...mutationFields,
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
      ...terminalHookFields(tmuxPane),
      model: modelName(input.model),
      cliVersion: input.cursor_version || input.version,
    }
    const registered = await post(port, '/api/hook/session-start', body)
    if (!registered) await fallbackRegister(input, engine, tmuxPane)
    const stopped = await post(port, '/api/hook/turn-stop', {
      sessionId,
      status: input.status,
      transcriptPath: input.transcript_path,
      ...mutationFields,
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
        ...terminalHookFields(tmuxPane),
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
      ...mutationFields,
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
    ...terminalHookFields(tmuxPane),
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
    // agy REQUIRES a JSON object on stdout. `{}` is the safe no-op for both events it fires: on Stop,
    // only `{"decision":"continue"}` would block the stop. It is also why PreToolUse is never installed
    // — there `decision` is required, and `{}` reads as a denial (measured: every tool call of the turn
    // came back "Tool call denied by pre-tool hook").
    // Copilot parses stdout as JSON too; `{}` is the documented no-op for every event installed here.
    if (e === 'cursor' || e === 'hermes' || e === 'agy' || e === 'copilot') process.stdout.write('{}\n', () => process.exit(0))
    else process.exit(0)
  })
