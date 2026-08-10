/** tmux process matching, runtime validation, pane capture, and input injection. */

import { execFile, spawn } from 'child_process'
import { basename } from 'path'
import { registry, type ProcessIdentity, type RegisteredSession } from './registry.js'
import { engineBin } from './engineBin.js'

function cleanPaneTitle(title: string): string | null {
  const cleaned = title
    .trim()
    .replace(/^[\s"'`*✳✱✲✴✶✷✸✹✺✻✼✽✾✿❃❉❋•·.-]+/, '')
    .trim()
    .slice(0, 80)
  return cleaned || null
}

/** Current tmux pane titles keyed by pane id. AI CLIs update this with their live session title. */
export function listPaneTitles(): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    execFile('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_title}'], { timeout: 2000 }, (err, stdout) => {
      const titles = new Map<string, string>()
      if (err) { resolve(titles); return }
      for (const line of stdout.split('\n')) {
        const [pane, ...titleParts] = line.split('\t')
        if (!/^%\d+$/.test(pane)) continue
        const title = cleanPaneTitle(titleParts.join('\t'))
        if (title) titles.set(pane, title)
      }
      resolve(titles)
    })
  })
}

export interface ProcessRow extends ProcessIdentity {
  parentPid: number
  args: string
}

function argvTokens(args: string): string[] {
  return (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => {
    const quoted = (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
    return quoted ? token.slice(1, -1) : token
  })
}

/**
 * Return only the executable/script portion of argv, never prompt text or later CLI arguments.
 *
 * Looking for an engine word anywhere in `ps args` is unsafe: `python worker.py "compare codex and
 * claude"` is not two coding agents. Package-manager installs commonly leave `node`, `bun`, Python, or a
 * shell in `comm`, so for those interpreters the first non-option token is the real entrypoint. Absolute
 * prefixes are deliberately retained only for suffix/package-layout checks and are never hard-coded.
 */
function processEntrypoint(args: string): string {
  const tokens = argvTokens(args)
  if (!tokens.length) return ''
  let index = 0
  let command = basename(tokens[index]).toLowerCase()
  if (command === 'env') {
    index++
    while (index < tokens.length && (tokens[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index++
    command = basename(tokens[index] ?? '').toLowerCase()
  }
  if (!/^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)*)?|bash|zsh|sh)$/.test(command)) return tokens[index] ?? ''

  index++
  const optionsWithValue = new Set(['-r', '--require', '--loader', '--import', '--conditions', '--inspect-port'])
  const inlineCodeOptions = new Set(['-c', '--command', '-e', '--eval', '--print'])
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '--') { index++; break }
    if (token === '-m' && index + 1 < tokens.length) return tokens[index + 1]
    // Inline shell/Node/Python source is not an executable entrypoint. Its text can legitimately mention
    // an engine command; the real child process, if one is launched, will be discovered from its own row.
    if (inlineCodeOptions.has(token)) return ''
    if (!token.startsWith('-')) break
    index += optionsWithValue.has(token) && index + 1 < tokens.length ? 2 : 1
  }
  return tokens[index] ?? ''
}


/**
 * One `ps -axo pid=,ppid=,comm=,lstart=,args=` line → a row.
 *
 * `comm` can itself contain spaces: Command Code rewrites its argv to `⌘ <session title>` and macOS
 * prints that verbatim as the command name. Splitting comm off as a single `\S+` therefore shifted every
 * later field — `startMarker` came out as `"<rest of title> Thu Jul 30"` instead of a start time, so it
 * changed whenever Command Code renamed the session, `validateSessionRuntime` saw a different process,
 * and the reaper evicted a live pane ~10s after its first turn (observed four times on one session; the
 * pane went on serving turn-stop hooks after being declared "gone"). It also silently defeated the
 * PID-reuse guard that startMarker exists for.
 *
 * So anchor on `lstart` instead — it is the one field with a fixed shape (`DOW MON DD HH:MM:SS YYYY`) —
 * and let comm be lazy. The day/month names stay unconstrained so a non-English `LC_TIME` still parses.
 */
export function parseProcessRow(line: string): ProcessRow | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/.exec(line)
  if (!match) return null
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    executable: match[3],
    startMarker: match[4],
    args: match[5],
  }
}

/** The process table, or null when `ps` itself failed — "we could not look" is not "nothing is there". */
function processRows(): Promise<ProcessRow[] | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,comm=,lstart=,args='], { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve(null); return }
      const rows: ProcessRow[] = []
      for (const line of stdout.split('\n')) {
        const row = parseProcessRow(line)
        if (row) rows.push(row)
      }
      resolve(rows)
    })
  })
}


function panePid(pane: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('tmux', ['display-message', '-p', '-t', pane, '#{pane_pid}'], { timeout: 2000 }, (err, stdout) => {
      const pid = Number(stdout.trim())
      resolve(!err && Number.isSafeInteger(pid) && pid > 0 ? pid : null)
    })
  })
}

export function engineProcessMatchScore(
  row: Pick<ProcessRow, 'executable' | 'args'>,
  engine: RegisteredSession['engine'],
): number {
  const executable = basename(row.executable).toLowerCase()
  const entrypoint = processEntrypoint(row.args).toLowerCase()
  const entrybase = basename(entrypoint).toLowerCase()
  // A user may point an engine at a symlink/custom install through `<ENGINE>_PATH`. Treat that configured
  // executable exactly like the vendor command without baking its machine-specific directory into rules.
  const configured = engineBin(engine).toLowerCase()
  const configuredBase = basename(configured).toLowerCase()
  if (configuredBase && (executable === configuredBase || entrybase === configuredBase
    || row.executable.toLowerCase() === configured || entrypoint === configured)) return 4
  if (engine === 'codex') {
    if (executable === 'codex' || entrybase === 'codex') return 3
    // npm/pnpm/bun global installs may leave node as `comm`; match the package entrypoint without
    // caring which prefix or package manager store contains it.
    return /@openai[\/\\]codex[\/\\]bin[\/\\]codex(?:\.js)?$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'cursor') {
    if (executable === 'agent' || executable === 'cursor-agent' || entrybase === 'agent' || entrybase === 'cursor-agent') return 3
    return /cursor-agent[\/\\]versions[\/\\][^/\\]+[\/\\]index\.js$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'opencode') {
    if (executable === 'opencode' || executable === 'opencode.exe' || entrybase === 'opencode' || entrybase === 'opencode.exe') return 3
    return /opencode-ai[\/\\]bin[\/\\]opencode(?:\.exe)?$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'kilo') {
    // `@kilocode/cli` installs the same file under both names, and kilo's own installer puts a second
    // copy at ~/.kilo/bin/kilo. The npm install measured on 2026-08-10 is a shallow
    // `node /usr/local/bin/kilo` wrapper with a `.kilo` child, so recognize both public command names
    // in argv while depth selection keeps the wrapper as the process-agent identity.
    if (executable === 'kilo' || executable === 'kilocode' || executable === '.kilo'
      || entrybase === 'kilo' || entrybase === 'kilocode' || entrybase === '.kilo') return 3
    return /@kilocode[\/\\]cli[\/\\]bin[\/\\](?:\.kilo|kilo|kilocode)$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'commandcode') {
    // The TUI overwrites its own argv within the first second — `ps` shows `⌘ Command Code · <dir>` and
    // then `⌘ <session title>`, with no trace of the node entrypoint. So the ⌘ (U+2318) prefix is the
    // only marker present for a pane's whole life; without it a live session fails validateSessionRuntime
    // and the reaper evicts it. The entrypoint rules below still cover a non-renaming/wrapped launch.
    if (/^\s*⌘(?:\s|$)/.test(row.executable) || /^\s*⌘(?:\s|$)/.test(row.args)) return 3
    if (executable === 'cmd' || executable === 'commandcode' || executable === 'command-code'
      || entrybase === 'cmd' || entrybase === 'commandcode' || entrybase === 'command-code') return 3
    return /command-code[\/\\]dist[\/\\]index\.mjs$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'devin') {
    // `~/.local/bin/devin` is a symlink into `…/devin/cli/_versions/<ver>/bin/devin`, but the pane process
    // keeps the bare `devin` argv (verified live: `ps -o command=` prints exactly `devin`), so the
    // basename is the primary signal and the versioned path only covers a direct/wrapped launch.
    if (executable === 'devin' || entrybase === 'devin') return 3
    return /devin[\/\\]cli[\/\\]_versions[\/\\][^/\\]+[\/\\]bin[\/\\]devin$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'hermes') {
    // The launcher shim `exec`s away, so the pane process is `…/venv/bin/python …/hermes-agent/hermes`.
    if (executable === 'hermes' || entrybase === 'hermes') return 3
    return /hermes-agent[\/\\]hermes$/.test(entrypoint) || /^(?:hermes|hermes_cli)(?:\.|$)/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'pi') {
    // Pi sets process.title = 'pi'; when the platform ignores that it stays `node …/pi-coding-agent/dist/cli.js`.
    if (executable === 'pi' || entrybase === 'pi') return 3
    return /pi-coding-agent[\/\\]dist[\/\\]cli\.js$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'muse') {
    // `~/.local/bin/muse` is a bash launcher that `exec`s the real binary, so the pane process is
    // `muse-bin-<version>` — the bare name only appears before the exec.
    if (executable === 'muse' || /^muse-bin-/.test(executable) || entrybase === 'muse' || /^muse-bin-/.test(entrybase)) return 3
    return 0
  }
  if (engine === 'amp') {
    // `~/.local/bin/amp` symlinks to `~/.amp/bin/amp`, a single compiled binary that does NOT re-exec:
    // measured live, the pane process is `amp` with argv `amp` and no children at all.
    if (executable === 'amp' || entrybase === 'amp') return 3
    return /\.amp[\/\\]bin[\/\\]amp$/.test(entrypoint) ? 2 : 0
  }
  if (engine === 'grok') {
    // Grok ships as a single binary at ~/.grok/bin/grok and keeps the bare executable name in tmux.
    if (executable === 'grok' || entrybase === 'grok') return 3
    return /\.grok[\/\\]bin[\/\\]grok$/.test(entrypoint) ? 2 : 0
  }
  if (executable === 'claude' || entrybase === 'claude') return 3
  return /@anthropic-ai[\/\\]claude-code[\/\\]cli\.js$/.test(entrypoint) ? 2 : 0
}

function selectEngineProcess(
  rows: ProcessRow[],
  rootPid: number,
  engine: RegisteredSession['engine'],
): ProcessRow | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.parentPid) ?? []
    list.push(row)
    children.set(row.parentPid, list)
  }
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }]
  let best: { row: ProcessRow; depth: number; score: number } | null = null
  while (queue.length > 0) {
    const current = queue.shift()!
    const row = byPid.get(current.pid)
    const score = row ? engineProcessMatchScore(row, engine) : 0
    if (row && score > 0 && (!best || current.depth < best.depth || (current.depth === best.depth && score > best.score))) {
      best = { row, depth: current.depth, score }
    }
    for (const child of children.get(current.pid) ?? []) queue.push({ pid: child.pid, depth: current.depth + 1 })
  }
  return best?.row ?? null
}

/**
 * How each engine names an already-existing session on its command line, and what its ids look like.
 *
 * This exists because RESUMING is the one way to start an agent that announces nothing: the engine's
 * SessionStart hook fires for a NEW session, so a pane that reattached to an old one is invisible to the
 * daemon until the user happens to type. Read from each CLI's own `--help` on 2026-08-03.
 *
 * Two deliberate holes:
 *   - `--continue` / `-c` carries NO id on any of these CLIs. Nothing can be recovered from argv there.
 *   - claude and codex are absent: `registry.register` demands a transcript path for those two, which
 *     argv does not carry — and both DO fire SessionStart on resume, so there is nothing to repair.
 *
 * The id pattern is a filter, not decoration: `-r` on Command Code takes "a name (use quotes for
 * multi-word names)", so a title would otherwise be registered as a session id.
 */
const RESUME_ARGS: Partial<Record<RegisteredSession['engine'], { flags: string[]; id: RegExp }>> = {
  cursor: { flags: ['--resume'], id: /^[0-9a-f-]{16,}$/i },
  opencode: { flags: ['--session', '-s'], id: /^ses_[A-Za-z0-9]+$/ },
  // Kilo inherits opencode's resume flags and its `ses_` id prefix — measured on this machine's kilo.db:
  // `ses_024a007fdffe11yG68JPxsHJly`. `--fork` is deliberately NOT here: it CONTINUES from an id but
  // writes a NEW session, so the id in argv is the parent's and would bind the agent to the wrong row.
  kilo: { flags: ['--session', '-s'], id: /^ses_[A-Za-z0-9]+$/ },
  pi: { flags: ['--session', '--session-id'], id: /^[0-9a-f][0-9a-f-]{7,}$/i },
  // Hermes ids are timestamps: 20260728_115628_f2c86a.
  hermes: { flags: ['--resume'], id: /^\d{8}_\d{6}_[0-9a-z]+$/i },
  commandcode: { flags: ['--resume', '-r', '--session'], id: /^[0-9a-f-]{16,}$/i },
  // `muse resume <uuid>` names the session; `muse resume --last` does not, so that form falls through
  // to the scan in sessionRepair instead.
  muse: { flags: ['resume', '--session-id'], id: /^[0-9a-f-]{16,}$/i },
  // `amp threads continue <id>` names the thread; the bare `amp last` does not. Amp's ids are the only
  // ones here with a fixed prefix (`T-019fda49-…`), so the pattern doubles as proof it IS an amp id.
  amp: { flags: ['continue', '-c'], id: /^T-[0-9a-f-]{16,}$/i },
  // Grok 1.0.0 accepts both spellings and persists UUID session ids below ~/.grok/sessions.
  grok: { flags: ['--resume', '-r'], id: /^[0-9a-f-]{16,}$/i },
}

/** The session id an engine was told to resume, or null when argv does not name one. */
export function resumeSessionId(engine: RegisteredSession['engine'], args: string): string | null {
  const spec = RESUME_ARGS[engine]
  if (!spec) return null
  for (const flag of spec.flags) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const value = new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(\\S+)`, 'i').exec(args)?.[1]
    if (value && spec.id.test(value)) return value
  }
  return null
}

/**
 * Resolve the stable CLI process below one tmux pane, ahead of short-lived helper descendants — and say
 * whether a negative answer means "nothing is running there" or "the probe itself failed". Those are not
 * the same fact: `tmux display-message` and `ps` are subprocesses with 2-3s timeouts, and treating a
 * timeout as proof of death evicts a live session.
 */
type PaneProcessLookup =
  | { ok: true; identity: ProcessIdentity }
  | { ok: false; unknown: boolean; reason: string }

async function lookupPaneEngineProcess(
  pane: string,
  engine: RegisteredSession['engine'],
): Promise<PaneProcessLookup> {
  const rootPid = await panePid(pane)
  // The caller already confirmed the pane is in `tmux list-panes`, so a failure here is the tmux call,
  // not a missing pane.
  if (!rootPid) return { ok: false, unknown: true, reason: `tmux could not resolve pane ${pane}` }
  const rows = await processRows()
  if (!rows) return { ok: false, unknown: true, reason: 'the process table could not be read' }
  const process = selectEngineProcess(rows, rootPid, engine)
  if (!process) return { ok: false, unknown: false, reason: `no ${engine} process under pane ${pane}` }
  return {
    ok: true,
    identity: { pid: process.pid, executable: process.executable, startMarker: process.startMarker },
  }
}

/** Boolean form for callers that only need "is it there". */
export async function resolvePaneEngineProcess(
  pane: string,
  engine: RegisteredSession['engine'],
): Promise<ProcessIdentity | null> {
  const found = await lookupPaneEngineProcess(pane, engine)
  return found.ok ? found.identity : null
}

/** A whole `lstart` stamp — `DOW MON DD HH:MM:SS YYYY` — and nothing else. */
const LSTART_MARKER_RE = /^\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4}$/

/** Pane + engine process validation. A saved identity prevents PID reuse from reviving a stale entry. */
export async function validateSessionRuntime(session: RegisteredSession): Promise<boolean> {
  return (await checkSessionRuntime(session)).state === 'alive'
}

/**
 * The same check, but three-valued and with a reason — the reaper needs both.
 *
 * `unknown` exists because a failed probe is not evidence of death. The reaper already refuses to evict
 * when `tmux list-panes` fails; the per-session probes (`tmux display-message`, `ps`) deserve exactly the
 * same treatment, and did not get it: a live Command Code pane was dropped with "no commandcode process
 * under pane %3" 14s after attaching, while that process was demonstrably running — still alive minutes
 * later, and matched by this very resolver run by hand. The eviction landed 3.6s into a 5s tick, i.e.
 * `ps` had hit its 3s timeout during the load spike of a freshly started daemon warming its pools.
 *
 * The reason string matters just as much. "process for pane %3 gone" read identically whether the user
 * had quit the CLI or the adapter had simply lost sight of it, and telling those apart after the fact
 * means reconstructing a process table that no longer exists.
 */
export type RuntimeCheck =
  | { state: 'alive' }
  | { state: 'gone'; reason: string }
  | { state: 'unknown'; reason: string }

export async function checkSessionRuntime(session: RegisteredSession): Promise<RuntimeCheck> {
  const found = await lookupPaneEngineProcess(session.tmuxPane, session.engine)
  if (!found.ok) return { state: found.unknown ? 'unknown' : 'gone', reason: found.reason }
  const live = found.identity
  const saved = session.processIdentity
  // A persisted identity whose startMarker is not an lstart stamp was written by the pre-fix parser (see
  // parseProcessRow) — its fields are shifted, so it can NEVER match the corrected ones again. Adopt the
  // corrected identity instead of failing: the pane still has a matching engine process, and failing here
  // would drop a live session for good (Command Code, the only engine affected, does not re-register on
  // its Stop hook). One-time, per session.
  if (saved && !LSTART_MARKER_RE.test(saved.startMarker)) {
    registry.updateProcessIdentity(session.sessionId, live)
    return { state: 'alive' }
  }
  // pid + start time IS the identity of a process, and neither can change under it — that is the whole
  // PID-reuse guard. `executable` is argv-derived and therefore mutable (Command Code rewrites its own
  // argv to `⌘ <session title>` and renames the session mid-life), so it is recorded but not compared:
  // comparing it evicted live panes for renaming themselves.
  if (saved && (saved.pid !== live.pid || saved.startMarker !== live.startMarker)) {
    return {
      state: 'gone',
      reason: `process changed under pane ${session.tmuxPane}`
        + ` (was pid ${saved.pid} @ ${saved.startMarker}, now pid ${live.pid} @ ${live.startMarker})`,
    }
  }
  if (!saved) registry.updateProcessIdentity(session.sessionId, live)
  return { state: 'alive' }
}

// A short single-line message fits in ONE pty write, so `send-keys -l` + an immediate Enter submits
// instantly. Anything longer or multi-line takes the bracketed-paste path below (see sendToTmux).
const INJECT_FASTPATH_MAXLEN = 500
// Base settle time before the submit Enter; grows with length (Claude needs time to ingest a big paste
// and collapse it to `[Pasted text]` before a clean Enter counts as submit rather than paste content).
const INJECT_PASTE_DELAY_BASE_MS = 400
// A NAMED tmux buffer so we never clobber the user's default paste buffer; `-d` deletes it after paste.
let injectBufferSequence = 0

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function tmuxEnter(pane: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tmux', ['send-keys', '-t', pane, 'Enter'], { timeout: 2000 }, (err) => {
      if (err) console.error(`[tmux] Enter to ${pane} failed:`, err.message)
      resolve(!err)
    })
  })
}

/** Stage text in a NAMED tmux buffer via stdin (avoids arg-length limits + the user's default buffer). */
function tmuxLoadBuffer(name: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn('tmux', ['load-buffer', '-b', name, '-'])
    c.on('error', () => resolve(false))
    c.on('close', (code) => resolve(code === 0))
    c.stdin.on('error', () => { /* EPIPE if tmux died first — 'close' still resolves false */ })
    c.stdin.end(content)
  })
}

/**
 * Type a message into a tmux pane and submit it — the web-chat/device → terminal injection point.
 *
 * SHORT single-line: `send-keys -l` (literal, so "Enter"/"C-m" in the body aren't read as key names) +
 * an immediate Enter. Fast, no added latency.
 *
 * LONG / multi-line: a big `send-keys -l` is split by tmux into several pty writes, so Claude Code's
 * paste heuristic collapses each chunk into its own `[Pasted text]` block and the immediate Enter lands
 * mid-burst and is SWALLOWED (never submits). Instead we stage the text in a named buffer and
 * bracketed-paste it as ONE unit (`paste-buffer -p`), let Claude settle, then send a clean separate
 * Enter. (Verified: reliably submits up to ~28 KB.)
 */
export function sendToTmux(pane: string, text: string): Promise<boolean> {
  const content = text.replace(/[\r\n]+$/, '') // strip trailing newlines so the submit Enter isn't doubled
  if (content.length <= INJECT_FASTPATH_MAXLEN && !content.includes('\n')) {
    return new Promise((resolve) => {
      execFile('tmux', ['send-keys', '-t', pane, '-l', content], { timeout: 2000 }, (err) => {
        if (err) { console.error(`[tmux] send-keys to ${pane} failed:`, err.message); resolve(false); return }
        void tmuxEnter(pane).then(resolve)
      })
    })
  }
  return (async () => {
    const bufferName = `machinemsg-${process.pid}-${++injectBufferSequence}`
    if (!(await tmuxLoadBuffer(bufferName, content))) {
      console.error(`[tmux] load-buffer for ${pane} failed`)
      return false
    }
    const pasted = await new Promise<boolean>((resolve) => {
      execFile('tmux', ['paste-buffer', '-t', pane, '-b', bufferName, '-p', '-d'], { timeout: 2000 }, (err) => {
        if (err) console.error(`[tmux] paste-buffer to ${pane} failed:`, err.message)
        resolve(!err)
      })
    })
    if (!pasted) return false
    await sleep(Math.min(1500, INJECT_PASTE_DELAY_BASE_MS + Math.floor(content.length / 60)))
    return tmuxEnter(pane)
  })()
}

/** Send a control key (e.g. 'C-c' to interrupt) to a pane. */
/**
 * Type text into a pane WITHOUT submitting it. Needed by filter boxes that act on every keystroke: pi's
 * settings list opens a row as soon as the filter narrows to one, so the Enter `sendToTmux` appends would
 * land on the row that just opened and pick whatever was already highlighted.
 */
export function sendLiteralToTmux(pane: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tmux', ['send-keys', '-t', pane, '-l', text], { timeout: 2000 }, (err) => {
      if (err) console.error(`[tmux] literal send to ${pane} failed:`, err.message)
      resolve(!err)
    })
  })
}

export function sendKeyToTmux(pane: string, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tmux', ['send-keys', '-t', pane, key], { timeout: 2000 }, (err) => resolve(!err))
  })
}

/** Capture terminal text plus SGR style codes. Styles distinguish a dim CLI placeholder from a real draft. */
export function captureTmuxPane(pane: string, historyLines = 100): Promise<string | null> {
  const bounded = Math.max(20, Math.min(300, Math.floor(historyLines)))
  return new Promise((resolve) => {
    execFile('tmux', ['capture-pane', '-p', '-e', '-J', '-t', pane, '-S', `-${bounded}`], { timeout: 2000 }, (err, stdout) => {
      if (err) { resolve(null); return }
      resolve(stdout)
    })
  })
}
