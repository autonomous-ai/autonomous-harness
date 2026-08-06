/**
 * tmux integration: pane liveness (reaper) + typing messages into a pane.
 *
 * The reaper handles hard-killed panes: a killed pane (or a dead tmux server) terminates claude
 * before SessionEnd can fire, which would leave the session registered forever. It periodically
 * checks which panes still exist and drops any registered session whose pane is gone (debounced
 * by 2 consecutive misses).
 */

import { execFile, spawn } from 'child_process'
import { basename } from 'path'
import { registry, type ProcessIdentity, type RegisteredSession } from './registry.js'
import { launcherSessions } from './launcherSessions.js'

const MISS_LIMIT = 2

type PaneListResult =
  | { ok: true; panes: Set<string> }
  | { ok: false; error: string }

/** Live tmux pane ids (e.g. "%0","%3"). Empty set if tmux is unreachable. */
export function listLivePanes(): Promise<PaneListResult> {
  return new Promise((resolve) => {
    execFile('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { timeout: 2000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: err.message })
        return
      }
      const panes = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      resolve({ ok: true, panes: new Set(panes) })
    })
  })
}

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

interface ProcessRow extends ProcessIdentity {
  parentPid: number
  args: string
}

interface TmuxPaneProcess {
  tmuxPane: string
  rootPid: number
  cwd: string
}

export interface TmuxResume {
  engine: RegisteredSession['engine']
  sessionId: string
  tmuxPane: string
  cwd: string
  processIdentity: ProcessIdentity
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

function tmuxPaneProcesses(): Promise<TmuxPaneProcess[]> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{pane_current_path}'],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) { resolve([]); return }
        const panes: TmuxPaneProcess[] = []
        for (const line of stdout.split('\n')) {
          const [tmuxPane, pidText, ...cwdParts] = line.split('\t')
          const rootPid = Number(pidText)
          if (!/^%\d+$/.test(tmuxPane) || !Number.isSafeInteger(rootPid) || rootPid <= 0) continue
          panes.push({ tmuxPane, rootPid, cwd: cwdParts.join('\t') })
        }
        resolve(panes)
      },
    )
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
  const haystack = `${row.executable} ${row.args}`.toLowerCase()
  const executable = basename(row.executable).toLowerCase()
  if (engine === 'codex') {
    if (executable === 'codex') return 3
    return /(^|[\/\s])codex(?:[\s]|$)/.test(haystack) ? 1 : 0
  }
  if (engine === 'cursor') {
    if (executable === 'agent' || executable === 'cursor-agent') return 3
    return /cursor-agent[\/\\]versions[\/\\][^/\\\s]+[\/\\]index\.js(?:\s|$)/.test(haystack) ? 1 : 0
  }
  if (engine === 'opencode') {
    if (executable === 'opencode') return 3
    return /(^|[\/\s])opencode(?:[\s]|$)/.test(haystack) ? 1 : 0
  }
  if (engine === 'commandcode') {
    // The TUI overwrites its own argv within the first second — `ps` shows `⌘ Command Code · <dir>` and
    // then `⌘ <session title>`, with no trace of the node entrypoint. So the ⌘ (U+2318) prefix is the
    // only marker present for a pane's whole life; without it a live session fails validateSessionRuntime
    // and the reaper evicts it. The entrypoint rules below still cover a non-renaming/wrapped launch.
    if (/^\s*⌘(?:\s|$)/.test(haystack)) return 3
    if (/command-code[\/\\]dist[\/\\]index\.mjs(?:\s|$)/.test(haystack)) return 3
    if (executable === 'commandcode' || executable === 'command-code') return 3
    return /(^|[\/\s])commandcode(?:[\s]|$)/.test(haystack) ? 1 : 0
  }
  if (engine === 'devin') {
    // `~/.local/bin/devin` is a symlink into `…/devin/cli/_versions/<ver>/bin/devin`, but the pane process
    // keeps the bare `devin` argv (verified live: `ps -o command=` prints exactly `devin`), so the
    // basename is the primary signal and the versioned path only covers a direct/wrapped launch.
    if (executable === 'devin') return 3
    if (/devin[\/\\]cli[\/\\]_versions[\/\\][^/\\\s]+[\/\\]bin[\/\\]devin(?:\s|$)/.test(haystack)) return 3
    return /(^|[\/\s])devin(?:[\s]|$)/.test(haystack) ? 1 : 0
  }
  if (engine === 'hermes') {
    // The launcher shim `exec`s away, so the pane process is `…/venv/bin/python …/hermes-agent/hermes`.
    if (/hermes-agent[\/\\]hermes(?:\s|$)/.test(haystack)) return 3
    if (executable === 'hermes') return 3
    return /(^|[\/\s])hermes(?:[\s]|$)/.test(haystack) ? 1 : 0
  }
  if (engine === 'pi') {
    // Pi sets process.title = 'pi'; when the platform ignores that it stays `node …/pi-coding-agent/dist/cli.js`.
    if (executable === 'pi') return 3
    return /pi-coding-agent[\/\\]dist[\/\\]cli\.js(?:\s|$)|(^|[\/\s])pi(?:[\s]|$)/.test(haystack) ? 1 : 0
  }
  if (engine === 'muse') {
    // `~/.local/bin/muse` is a bash launcher that `exec`s the real binary, so the pane process is
    // `muse-bin-<version>` — the bare name only appears before the exec.
    if (executable === 'muse' || /^muse-bin-/.test(executable)) return 3
    return /(^|[\/\s])muse(?:-bin-[^\s]+)?(?:[\s]|$)/.test(haystack) ? 1 : 0
  }
  if (executable === 'claude') return 3
  return /(^|[\/\s])claude(?:[\s]|$)/.test(haystack) ? 1 : 0
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
    if (row && score > 0 && (!best || score > best.score || (score === best.score && current.depth < best.depth))) {
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
  pi: { flags: ['--session', '--session-id'], id: /^[0-9a-f][0-9a-f-]{7,}$/i },
  // Hermes ids are timestamps: 20260728_115628_f2c86a.
  hermes: { flags: ['--resume'], id: /^\d{8}_\d{6}_[0-9a-z]+$/i },
  commandcode: { flags: ['--resume', '-r', '--session'], id: /^[0-9a-f-]{16,}$/i },
  // `muse resume <uuid>` names the session; `muse resume --last` does not, so that form falls through
  // to the scan in sessionRepair instead.
  muse: { flags: ['resume', '--session-id'], id: /^[0-9a-f-]{16,}$/i },
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
 * Every tmux pane whose engine was launched against an EXISTING session, from the stable CLI process.
 * Ambiguous duplicate resumes are ignored rather than assigning one remote tab to an arbitrary pane.
 *
 * Only the pane and its argv are read here; whether such a session may be adopted is the caller's call
 * (it needs a live launcher on that pane — see cli.ts).
 */
export async function discoverTmuxResumes(): Promise<TmuxResume[]> {
  const [panes, probed] = await Promise.all([tmuxPaneProcesses(), processRows()])
  const rows = probed ?? []
  const candidates = new Map<string, TmuxResume[]>()
  for (const pane of panes) {
    for (const engine of Object.keys(RESUME_ARGS) as Array<RegisteredSession['engine']>) {
      const process = selectEngineProcess(rows, pane.rootPid, engine)
      if (!process) continue
      const sessionId = resumeSessionId(engine, process.args)
      if (!sessionId) continue
      const candidate: TmuxResume = {
        engine,
        sessionId,
        tmuxPane: pane.tmuxPane,
        cwd: pane.cwd,
        processIdentity: {
          pid: process.pid,
          executable: process.executable,
          startMarker: process.startMarker,
        },
      }
      const matches = candidates.get(sessionId) ?? []
      matches.push(candidate)
      candidates.set(sessionId, matches)
      break // one engine per pane: the first match owns it
    }
  }
  return [...candidates.values()].filter((matches) => matches.length === 1).map(([match]) => match)
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
type RuntimeCheck =
  | { state: 'alive' }
  | { state: 'gone'; reason: string }
  | { state: 'unknown'; reason: string }

async function checkSessionRuntime(session: RegisteredSession): Promise<RuntimeCheck> {
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

/**
 * Nothing here kills a pane, on purpose.
 *
 * Deleting an agent used to run `tmux kill-pane` — which also closed the window, and the session when it
 * was the last pane. That destroys the user's workspace to end OUR process. Deletion now asks the
 * launcher to stop its engine and exit (see `deleteAgentFallback.ts`), leaving the pane and its shell.
 *
 * Known limit: a pane whose ROOT process is the launcher itself (`tmux new-session 'harness claude'`,
 * with no shell in between) still disappears when the launcher exits. Nothing at this layer can change
 * that — it follows from how the pane was created.
 */

export function startTmuxReaper(
  intervalMs: number,
  onRemoved: (sessionId: string) => void,
): NodeJS.Timeout {
  const misses = new Map<string, number>()

  // A tick shells out to tmux + `ps` per session. `setInterval` does not wait for the previous one, so a
  // slow tick used to overlap the next — piling on more `ps` calls exactly when the computer is already too
  // busy to answer them, which is how two probes time out back to back and a live pane looks dead.
  let ticking = false

  const tick = async (): Promise<void> => {
    if (ticking) return
    const sessions = registry.list()
    if (sessions.length === 0) {
      misses.clear()
      return
    }
    ticking = true
    try {
      await sweep(sessions)
    } finally {
      ticking = false
    }
  }

  const sweep = async (sessions: RegisteredSession[]): Promise<void> => {
    const live = await listLivePanes()
    if (!live.ok) {
      misses.clear()
      console.warn(`[reaper] tmux list-panes failed; keeping ${sessions.length} registered session(s): ${live.error}`)
      return
    }

    for (const s of sessions) {
      // The launcher's socket outranks every probe below. An agent exists exactly as long as its wrapper
      // is connected (launcherSessions.ts), and that is a fact the daemon HOLDS — while `tmux` and `ps` are
      // subprocesses that can time out, and whose answer already cost a live Command Code pane once (it
      // renames its own argv mid-life). If the wrapper is still there, so is the agent; nothing to check.
      if (launcherSessions.has(s.launcherId)) {
        misses.delete(s.sessionId)
        continue
      }
      const check: RuntimeCheck = live.panes.has(s.tmuxPane)
        ? await checkSessionRuntime(s)
        : { state: 'gone', reason: `pane ${s.tmuxPane} is gone` }
      if (check.state === 'alive') {
        misses.delete(s.sessionId)
        continue
      }
      // Inconclusive: hold the session and the miss count where they are. Same rule as the list-panes
      // failure above — the adapter only evicts on evidence that the process is gone, never on a probe
      // it could not complete.
      if (check.state === 'unknown') {
        console.warn(`[reaper] keeping ${s.engine} session ${s.sessionId} · ${check.reason}`)
        continue
      }
      const n = (misses.get(s.sessionId) ?? 0) + 1
      if (n >= MISS_LIMIT) {
        misses.delete(s.sessionId)
        console.log(`[reaper] removing ${s.engine} session ${s.sessionId} · ${check.reason}`)
        onRemoved(s.sessionId)
      } else {
        misses.set(s.sessionId, n)
      }
    }
  }

  return setInterval(() => void tick(), intervalMs)
}
