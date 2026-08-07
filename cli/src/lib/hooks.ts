/**
 * Idempotently install the machine-adapter SessionStart / SessionEnd hooks into
 * ~/.claude/settings.json so claude notifies us when tmux sessions start/end.
 *
 * Changes to settings.json take effect on the NEXT claude session start.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import type { AgentEngine } from '../engines/types.js'

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')
const CODEX_HOOKS_PATH = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json')
const CURSOR_HOOKS_PATH = join(process.env.CURSOR_HOME || join(homedir(), '.cursor'), 'hooks.json')

// notify.mjs location depends on the layout (import.meta.url is the REAL executing file at runtime):
//  - packaged/bundled: cli.js at ~/.harness/cli/cli.js → notify.mjs is a SIBLING (dist/ bundle too).
//  - dev/per-file:      hooks.js at <appRoot>/{src,dist}/lib/ → notify.mjs at ../../hook/notify.mjs.
// Prefer the sibling, fall back to the dev path.
const cliDir = dirname(fileURLToPath(import.meta.url))
const HOOK_SCRIPT =
  [join(cliDir, 'notify.mjs'), join(cliDir, '..', '..', 'hook', 'notify.mjs')].find(existsSync) ??
  join(cliDir, '..', '..', 'hook', 'notify.mjs')

// SessionStart/End drive register/remove. UserPromptSubmit is the CATCH hook: it re-registers on
// every prompt so a session whose SessionStart we missed (adapter started late, or hook installed
// after the session began) still appears on its first prompt. notify.mjs treats it like SessionStart.
// Stop/StopFailure are the authoritative turn-close signals (Stop = normal finish incl. max_tokens/
// refusal; StopFailure = turn ended on an API error, where Stop does NOT fire) — they close a turn even
// when the JSONL-derived turn_ended is missed. Neither supports a matcher (silently ignored).
const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure'] as const

interface CommandHook {
  type: string
  command: string
  timeout?: number
}
interface HookBlock {
  matcher?: string
  hooks: CommandHook[]
}
type Settings = { hooks?: Record<string, HookBlock[]> } & Record<string, unknown>

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function command(port: number, engine: 'claude' | 'codex' | 'cursor' | 'hermes' | 'commandcode' | 'devin'): string {
  return [
    'node',
    shellQuote(HOOK_SCRIPT),
    '--port', String(port),
    '--data-dir', shellQuote(env.ADAPTER_DATA_DIR),
    '--claude-projects-dir', shellQuote(env.CLAUDE_PROJECTS_DIR),
    '--codex-home', shellQuote(env.CODEX_HOME),
    '--cursor-home', shellQuote(env.CURSOR_HOME),
    '--commandcode-home', shellQuote(env.COMMANDCODE_HOME),
    '--devin-home', shellQuote(env.DEVIN_HOME),
    ...(engine !== 'claude' ? ['--engine', engine] : []),
  ].join(' ')
}

/** True if a block already points at our notify.mjs script (any path — robust across layout/version). */
function isOurs(block: HookBlock): boolean {
  return Array.isArray(block?.hooks) && block.hooks.some((h) => h?.command?.includes('notify.mjs'))
}

export function installSessionHooks(port: number): void {
  let settings: Settings = {}
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Settings
  } catch {
    // missing / unreadable → start from empty settings
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  const cmd = command(port, 'claude')
  let changed = false
  let updated = false // true when an EXISTING block's command changed (path/port drift)

  for (const event of EVENTS) {
    const blocks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    // Collapse any duplicate "ours" blocks (e.g. from an earlier path) down to a single one, and
    // keep every non-ours block untouched.
    const foreign = blocks.filter((b) => !isOurs(b))
    const oursBlocks = blocks.filter(isOurs)
    if (oursBlocks.length > 1) changed = true // dropping duplicates is a change

    // The one canonical block for this event with the CURRENT command (path + port). If a prior
    // block existed with a different command (moved checkout / dev↔dist / changed port), this
    // overwrites it in place.
    const existingCmd = oursBlocks[0]?.hooks?.find((h) => isOurs({ hooks: [h] }))?.command
    if (oursBlocks.length === 0) changed = true
    else if (existingCmd !== cmd) { changed = true; updated = true }

    settings.hooks[event] = [...foreign, { hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]
  }

  if (!changed) {
    console.log('[hooks] Claude session + turn (Stop/StopFailure) hooks already installed')
    return
  }

  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
    console.log(
      updated
        ? `[hooks] updated (path/port changed) → ${HOOK_SCRIPT} --port ${port}`
        : `[hooks] installed Claude session + turn (Stop/StopFailure) hooks → ${SETTINGS_PATH}`,
    )
    console.log('[hooks] (takes effect on the next claude session start)')
  } catch (err) {
    console.error('[hooks] failed to write settings.json:', err)
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

/** Merge Machine's user-level Codex hooks without replacing unrelated hooks. A malformed existing file
 * is left untouched: silently replacing it could disable user security/automation hooks. */
export function installCodexHooks(port: number): void {
  let settings: Settings = {}
  if (existsSync(CODEX_HOOKS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(CODEX_HOOKS_PATH, 'utf-8')) as Settings
    } catch (err) {
      console.error(`[hooks] Codex hooks file is invalid JSON; leaving it unchanged: ${CODEX_HOOKS_PATH}`)
      console.error('[hooks] fix the file, then restart harness join')
      return
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  const cmd = command(port, 'codex')
  const required: Array<{ event: 'SessionStart' | 'UserPromptSubmit'; matcher?: string }> = [
    { event: 'SessionStart', matcher: 'startup|resume|clear|compact' },
    { event: 'UserPromptSubmit' },
  ]
  let changed = false
  for (const { event, matcher } of required) {
    const blocks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const foreign = blocks.filter((b) => !isOurs(b))
    const ours = blocks.filter(isOurs)
    const canonical: HookBlock = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd, timeout: 5 }],
    }
    const current = ours[0]
    if (ours.length !== 1 || current?.matcher !== matcher || current?.hooks?.[0]?.command !== cmd) changed = true
    settings.hooks[event] = [...foreign, canonical]
  }

  if (!changed) {
    console.log('[hooks] Codex SessionStart/UserPromptSubmit hooks already installed')
    return
  }
  try {
    writeJsonAtomic(CODEX_HOOKS_PATH, settings)
    console.log(`[hooks] installed Codex SessionStart/UserPromptSubmit hooks → ${CODEX_HOOKS_PATH}`)
    console.log('[hooks] Codex requires reviewing these user hooks with /hooks before normal use')
  } catch (err) {
    console.error('[hooks] failed to write Codex hooks.json:', err)
  }
}

interface CursorHook {
  command: string
  failClosed?: boolean
}

type CursorSettings = {
  version?: number
  hooks?: Record<string, CursorHook[]>
} & Record<string, unknown>

/** Merge Cursor's simpler user-hook schema. Cursor local CLI uses lower-camel event names and invokes
 * command entries directly, unlike Claude/Codex's nested matcher/hooks blocks. */
export function installCursorHooks(port: number): void {
  let settings: CursorSettings = {}
  if (existsSync(CURSOR_HOOKS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(CURSOR_HOOKS_PATH, 'utf-8')) as CursorSettings
    } catch {
      console.error(`[hooks] Cursor hooks file is invalid JSON; leaving it unchanged: ${CURSOR_HOOKS_PATH}`)
      return
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  if (typeof settings.version !== 'number') settings.version = 1

  const cmd = command(port, 'cursor')
  const events = ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'stop', 'sessionEnd'] as const
  let changed = false
  for (const event of events) {
    const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const foreign = entries.filter((entry) => !entry?.command?.includes('notify.mjs'))
    const ours = entries.filter((entry) => entry?.command?.includes('notify.mjs'))
    const canonical: CursorHook = { command: cmd, failClosed: false }
    if (ours.length !== 1 || ours[0]?.command !== cmd || ours[0]?.failClosed !== false) changed = true
    settings.hooks[event] = [...foreign, canonical]
  }
  if (!changed) {
    console.log('[hooks] Cursor lifecycle/task hooks already installed')
    return
  }
  try {
    writeJsonAtomic(CURSOR_HOOKS_PATH, settings)
    console.log(`[hooks] installed Cursor lifecycle/task hooks → ${CURSOR_HOOKS_PATH}`)
  } catch (err) {
    console.error('[hooks] failed to write Cursor hooks.json:', err)
  }
}

const OPENCODE_PLUGIN_PATH = join(env.OPENCODE_PLUGIN_DIR, 'launcher-register.js')

/** OpenCode has no shell hooks — discovery is a global plugin that POSTs each session to the daemon.
 * The plugin runs INSIDE every interactive `opencode` process (so it sees `$TMUX_PANE` + the cwd) and
 * fires on session.created/updated. The recap worker runs `opencode run --pure`, which skips external
 * plugins, so it never self-registers. */
function opencodePluginSource(port: number): string {
  return `// launcher-register — auto-installed by the machine adapter. Registers this OpenCode session with the
// local machine daemon (127.0.0.1:${port}) so it can be mirrored to web/device. No-op if machine isn't running.
export const MachineRegister = async ({ directory, worktree, project }) => {
  const seen = new Set()
  const post = async (sessionID) => {
    const pane = process.env.TMUX_PANE
    // The launcher (\`harness opencode\`) mints a UUID per launch and exports it as MACHINE_ID; the daemon
    // binds a session's lifetime to that launcher and REFUSES a registration without one. This plugin runs
    // inside the engine, so it inherits the variable — and an engine started outside the launcher has none,
    // which is exactly when it should not register. Same rule notify.mjs applies for every other engine.
    const launcherId = process.env.MACHINE_ID
    if (!pane || !launcherId || !sessionID || seen.has(sessionID)) return
    seen.add(sessionID)
    try {
      await fetch("http://127.0.0.1:${port}/api/hook/session-start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          engine: "opencode",
          pluginVersion: ${JSON.stringify(VERSION)},
          launcherId,
          sessionId: sessionID,
          cwd: directory || worktree || (project && project.worktree) || null,
          tmuxPane: pane,
        }),
      })
    } catch {}
  }
  return {
    event: async ({ event }) => {
      if (!event) return
      if (event.type === "session.created" || event.type === "session.updated") {
        const p = event.properties || {}
        const info = p.info || {}
        if (info.parentID) return // sub-agent child session — shown under its parent's Task card, not a top-level agent
        await post(info.id || p.sessionID || p.sessionId)
      }
    },
  }
}
`
}

const COMMANDCODE_SETTINGS_PATH = join(env.COMMANDCODE_HOME, 'settings.json')
// Command Code exposes only SessionStart / PreToolUse / PostToolUse / Stop — there is NO
// UserPromptSubmit (so no catch-hook re-register) and no SessionEnd (the tmux reaper covers that).
// Stop is the authoritative turn close, same as claude's.
//
// PreToolUse is here as the TURN-OPEN signal, and it is the only one this engine has. Command Code
// writes its transcript in one flush when the turn finishes — the user line and the assistant line carry
// the same millisecond — so tailing the JSONL cannot open a turn either. With only SessionStart/Stop the
// adapter first heard about a turn when it was already over and emitted turn_started+turn_ended in the
// same millisecond, so the device never showed "working": the tile went straight from idle to the recap.
const COMMANDCODE_EVENTS = ['SessionStart', 'PreToolUse', 'Stop'] as const

/**
 * Command Code's hook file is `~/.commandcode/settings.json` with the SAME nested `matcher`/`hooks`
 * schema as `~/.claude/settings.json`, so this mirrors installSessionHooks — including its dedup
 * discipline: every "ours" block (any command mentioning notify.mjs, whatever its old path/port) is
 * collapsed into exactly one canonical entry, and foreign blocks are preserved untouched.
 */
export function installCommandCodeHooks(port: number): void {
  let settings: Settings = {}
  if (existsSync(COMMANDCODE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(COMMANDCODE_SETTINGS_PATH, 'utf-8')) as Settings
    } catch {
      console.error(`[hooks] Command Code settings file is invalid JSON; leaving it unchanged: ${COMMANDCODE_SETTINGS_PATH}`)
      return
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  const cmd = command(port, 'commandcode')
  let changed = false
  for (const event of COMMANDCODE_EVENTS) {
    const blocks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const foreign = blocks.filter((b) => !isOurs(b))
    const ours = blocks.filter(isOurs)
    if (ours.length !== 1 || ours[0]?.hooks?.[0]?.command !== cmd) changed = true
    settings.hooks[event] = [...foreign, { hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]
  }

  if (!changed) {
    console.log('[hooks] Command Code session hooks already installed')
    return
  }
  try {
    writeJsonAtomic(COMMANDCODE_SETTINGS_PATH, settings)
    console.log(`[hooks] installed Command Code SessionStart/Stop hooks → ${COMMANDCODE_SETTINGS_PATH}`)
    console.log('[hooks] (takes effect on the next commandcode session start)')
  } catch (err) {
    console.error('[hooks] failed to write Command Code settings.json:', err)
  }
}

// Devin reads Claude's hook schema verbatim (its binary parses `ClaudeHookConfig`/`ClaudeHookMatcherConfig`),
// so the only differences from installSessionHooks are the file and that hooks nest under a "hooks" key of
// the user's general config — which also holds `devin.org_id`, `theme_mode`, etc, so this MERGES and never
// rewrites the file wholesale. Verified live: SessionStart/UserPromptSubmit/Stop all fire with
// `$TMUX_PANE` intact; the payload carries {hook_event_name, session_id, prompt_id, prompt, source} but
// NO transcript_path and NO cwd (notify.mjs derives cwd from its own process).
const DEVIN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const

export function installDevinHooks(port: number): void {
  let config: Settings & Record<string, unknown> = {}
  if (existsSync(env.DEVIN_CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(env.DEVIN_CONFIG_PATH, 'utf-8')) as Settings & Record<string, unknown>
    } catch {
      console.error(`[hooks] Devin config file is invalid JSON; leaving it unchanged: ${env.DEVIN_CONFIG_PATH}`)
      return
    }
  }
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {}

  const cmd = command(port, 'devin')
  let changed = false
  for (const event of DEVIN_EVENTS) {
    const blocks = Array.isArray(config.hooks[event]) ? config.hooks[event] : []
    const foreign = blocks.filter((b) => !isOurs(b))
    const ours = blocks.filter(isOurs)
    if (ours.length !== 1 || ours[0]?.hooks?.[0]?.command !== cmd) changed = true
    config.hooks[event] = [...foreign, { hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]
  }

  if (!changed) {
    console.log('[hooks] Devin session hooks already installed')
    return
  }
  try {
    writeJsonAtomic(env.DEVIN_CONFIG_PATH, config)
    console.log(`[hooks] installed Devin SessionStart/UserPromptSubmit/Stop/SessionEnd hooks → ${env.DEVIN_CONFIG_PATH}`)
    console.log('[hooks] (takes effect on the next devin session start)')
  } catch (err) {
    console.error('[hooks] failed to write Devin config.json:', err)
  }
}

const HERMES_CONFIG_PATH = join(env.HERMES_HOME, 'config.yaml')
const HERMES_ALLOWLIST_PATH = join(env.HERMES_HOME, 'shell-hooks-allowlist.json')
// The managed block is delimited by BEGIN/END so it can be replaced unambiguously. (An earlier version
// used a single marker line and a lookahead regex, which only replaced the comment and orphaned the old
// `hooks:` mapping — YAML then took the LAST duplicate key, so a stale block silently won.)
const HERMES_BLOCK_BEGIN = '# machine-adapter: session discovery (managed block — safe to delete)'
const HERMES_BLOCK_END = '# machine-adapter: end'
// `on_session_start` fires ONLY for brand-new sessions, so `pre_llm_call` (once per turn, in every
// session incl. `hermes -c`/`--resume`) is the real beacon. Registration is idempotent.
const HERMES_HOOK_EVENTS = ['on_session_start', 'pre_llm_call'] as const

/** Hermes gates every (event, command) pair behind ~/.hermes/shell-hooks-allowlist.json; an unapproved
 * hook is SILENTLY skipped in non-TTY runs. Record ours so it fires without an interactive prompt. */
function allowlistHermesHook(cmd: string): void {
  let data: { approvals?: Array<{ event?: string; command?: string }> } = { approvals: [] }
  try {
    const parsed = JSON.parse(readFileSync(HERMES_ALLOWLIST_PATH, 'utf-8')) as typeof data
    if (parsed && Array.isArray(parsed.approvals)) data = parsed
  } catch { /* absent or unreadable → start from an empty skeleton */ }
  const approvals = data.approvals ?? []
  let changed = false
  for (const event of HERMES_HOOK_EVENTS) {
    // Hermes matches on EXACT (event, command) string equality.
    if (approvals.some((a) => a?.event === event && a?.command === cmd)) continue
    approvals.push({ event, command: cmd })
    changed = true
  }
  if (!changed) return
  writeJsonAtomic(HERMES_ALLOWLIST_PATH, { ...data, approvals })
}

function hermesHooksBlock(cmd: string): string {
  const entries = HERMES_HOOK_EVENTS
    .map((event) => `  ${event}:\n    - command: ${JSON.stringify(cmd)}\n      timeout: 10`)
    .join('\n')
  return `\n${HERMES_BLOCK_BEGIN}\nhooks:\n${entries}\n${HERMES_BLOCK_END}\n`
}

/** True for a top-level `hooks:` mapping that is ours (every command runs our notify.mjs for hermes). */
function isMachineHooksBody(body: string[]): boolean {
  const commands = body.filter((line) => /^\s*- command:/.test(line))
  return commands.length > 0 && commands.every((line) => line.includes('notify.mjs') && line.includes('--engine hermes'))
}

/**
 * Strip every block this installer owns: the delimited BEGIN…END form AND any bare `hooks:` mapping
 * left behind by the earlier buggy rewrite (identified by its notify.mjs commands). Returns the cleaned
 * document plus whether a FOREIGN `hooks:` key survives — the caller must not touch the file then.
 */
function stripMachineHermesBlocks(config: string): { cleaned: string; foreignHooks: boolean; removed: number } {
  const lines = config.split('\n')
  const out: string[] = []
  let removed = 0
  let foreignHooks = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === HERMES_BLOCK_BEGIN) {
      // Skip through the END marker (or, for a truncated block, to the end of the mapping).
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== HERMES_BLOCK_END) j++
      i = j < lines.length ? j : lines.length - 1
      removed++
      continue
    }
    if (/^hooks:\s*$/.test(line)) {
      let j = i + 1
      while (j < lines.length && (lines[j].startsWith(' ') || lines[j].startsWith('\t') || lines[j].trim() === '')) j++
      const body = lines.slice(i + 1, j)
      if (isMachineHooksBody(body)) { removed++; i = j - 1; continue }
      foreignHooks = true
      out.push(line)
      continue
    }
    out.push(line)
  }
  return { cleaned: out.join('\n').replace(/\n{3,}$/, '\n'), foreignHooks, removed }
}

/**
 * Install the Hermes shell hooks. Unlike the other engines Hermes has no dedicated hooks file — they
 * live in the user's main `~/.hermes/config.yaml`. We therefore own exactly one delimited block: every
 * previous machine block is stripped first and a single fresh one appended, so a port/path change can
 * never leave a duplicate `hooks:` key behind (YAML resolves duplicates to the LAST one, which silently
 * pinned sessions to a stale block). A `hooks:` key that is NOT ours means the user manages their own —
 * leave the file untouched and print what to add.
 */
export function installHermesHooks(port: number): void {
  const cmd = command(port, 'hermes')
  let config = ''
  try {
    config = readFileSync(HERMES_CONFIG_PATH, 'utf-8')
  } catch {
    console.log(`[hooks] no Hermes config at ${HERMES_CONFIG_PATH} — skipping (run hermes once first)`)
    return
  }

  const { cleaned, foreignHooks, removed } = stripMachineHermesBlocks(config)
  if (foreignHooks) {
    console.error(`[hooks] ${HERMES_CONFIG_PATH} has its own \`hooks:\` block — leaving it untouched.`)
    console.error('[hooks] add these entries under it manually to mirror Hermes sessions:')
    for (const event of HERMES_HOOK_EVENTS) console.error(`[hooks]   ${event}: [{ command: ${JSON.stringify(cmd)}, timeout: 10 }]`)
    return
  }

  const next = `${cleaned.replace(/\s*$/, '')}\n${hermesHooksBlock(cmd)}`
  if (next === config) {
    allowlistHermesHook(cmd) // keep the allowlist in sync even when the block is current
    console.log('[hooks] Hermes session hooks already installed')
    return
  }

  try {
    writeFileSync(HERMES_CONFIG_PATH, next)
    allowlistHermesHook(cmd)
    console.log(
      removed > 1
        ? `[hooks] installed Hermes session hooks (collapsed ${removed} stale blocks) → ${HERMES_CONFIG_PATH}`
        : `[hooks] installed Hermes session hooks → ${HERMES_CONFIG_PATH}`,
    )
    console.log('[hooks] (takes effect on the next hermes session start)')
  } catch (err) {
    console.error('[hooks] failed to write Hermes config.yaml:', err)
  }
}

const PI_EXTENSION_PATH = join(env.PI_HOME, 'agent', 'extensions', 'launcher-register.ts')

/** Pi has no shell hooks either — discovery is a global TypeScript extension. It runs INSIDE every
 * interactive `pi` process (so it sees `$TMUX_PANE` and the session's own file path) and registers the
 * session with the local daemon. Pi buffers the transcript until the first assistant message, so the
 * session file may not exist yet at `session_start`; the extension re-registers on the first turn, once
 * `getSessionFile()` points at a real file. The recap worker runs with `--no-extensions`, so it never
 * registers itself. Global extensions load before the project-trust prompt, so this always fires. */
function piExtensionSource(port: number): string {
  return `// launcher-register — auto-installed by the machine adapter. Registers this Pi session with the local
// machine daemon (127.0.0.1:${port}) so it can be mirrored to web/device. No-op if machine isn't running.
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let announced = false;   // posted at least once (the transcript may not exist yet)
  let registered = false;  // posted with a real, on-disk transcript — nothing left to do

  const register = async (ctx: any) => {
    const pane = process.env.TMUX_PANE;
    if (!pane) return; // tmux-only, like every other engine
    // The launcher (\`harness pi\`) exports MACHINE_ID per launch, and the daemon refuses a registration
    // without it — the id is what binds the session's lifetime to a live launcher. This extension runs
    // inside pi, so it inherits the variable; started outside the launcher there is none, and registering
    // is exactly the wrong thing to do. Same rule notify.mjs applies for every other engine.
    const launcherId = process.env.MACHINE_ID;
    if (!launcherId) return;
    // Pi knows the session file path immediately but only WRITES it once the first assistant message
    // lands. Sending a path that isn't on disk yet is rejected by the daemon (it validates the file),
    // so announce without one first and attach the real path on a later turn.
    const file = ctx?.sessionManager?.getSessionFile?.() ?? null;
    const ready = !!file && existsSync(file);
    if (registered || (announced && !ready)) return;
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    try {
      const res = await fetch("http://127.0.0.1:${port}/api/hook/session-start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          engine: "pi",
          pluginVersion: ${JSON.stringify(VERSION)},
          launcherId,
          sessionId,
          transcriptPath: ready ? file : undefined,
          cwd: ctx?.cwd ?? undefined,
          tmuxPane: pane,
        }),
      });
      if (!res.ok) return; // daemon refused (e.g. transcript not readable yet) — retry on the next turn
      announced = true;
      if (ready) registered = true;
    } catch {}
  };

  // session_start fires before the transcript exists; the turn hooks catch it once it does.
  pi.on("session_start", async (_event, ctx) => { await register(ctx); });
  pi.on("turn_start", async (_event, ctx) => { await register(ctx); });
  pi.on("turn_end", async (_event, ctx) => { await register(ctx); });
}
`
}

/** Idempotently drop the Pi discovery extension into <PI_HOME>/agent/extensions/. */
export function installPiExtension(port: number): void {
  const source = piExtensionSource(port)
  try {
    if (existsSync(PI_EXTENSION_PATH) && readFileSync(PI_EXTENSION_PATH, 'utf-8') === source) {
      console.log('[hooks] Pi discovery extension already installed')
      return
    }
  } catch { /* unreadable — rewrite it */ }
  try {
    mkdirSync(dirname(PI_EXTENSION_PATH), { recursive: true })
    const tmp = `${PI_EXTENSION_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, source)
    renameSync(tmp, PI_EXTENSION_PATH)
    console.log(`[hooks] installed Pi discovery extension → ${PI_EXTENSION_PATH}`)
    console.log('[hooks] (takes effect on the next pi session start)')
  } catch (err) {
    console.error('[hooks] failed to write Pi extension:', err)
  }
}

const AMP_PLUGIN_PATH = join(env.AMP_PLUGIN_DIR, 'launcher-register.ts')

/**
 * Amp's plugin does more than discovery — it WRITES the transcript, because Amp keeps none.
 *
 * Every other engine here leaves a conversation on disk and the adapter tails it. Amp does not: threads
 * live on its server, and the only local artefacts are `session.json` and a debug log that records
 * `blockCount`/`frameLength` and no message text whatsoever (measured across two real sessions).
 * `amp threads export` can fetch the content, but it is a ~1.5s network round trip that never shows a
 * message before it is complete — useless for a live tail.
 *
 * The plugin API is the way in. Five events fire (measured, in the TUI, not read off a doc):
 * `session.start`, `agent.start`, `tool.call`, `tool.result`, `agent.end`. So this plugin writes the
 * JSONL the watcher tails, and from there Amp is an ordinary file-backed engine.
 *
 * Two details are load-bearing:
 *
 *   - **Text comes from `ctx.thread.messages()`, not from the events.** No event carries assistant text.
 *     But the thread handle reads the client's own local state, and at `tool.call` it ALREADY contains
 *     the in-flight assistant message (measured) — so snapshotting on each event emits a message's text
 *     BEFORE the tool it called, which is the order a transcript has to be in. Nothing is fetched.
 *   - **Blocks are emitted once, keyed `<messageId>#<index>`.** Each snapshot re-reads the same recent
 *     messages, so without that key every event would re-emit the whole tail of the conversation.
 *
 * Being a SYSTEM plugin it loads in every `amp` the user runs, including ones this adapter knows nothing
 * about. The `TMUX_PANE` + `MACHINE_ID` guard is what keeps it inert there — same rule as pi/opencode.
 */
function ampPluginSource(port: number, sessionsDir: string): string {
  return `// launcher-register — auto-installed by the machine adapter. Registers this Amp thread with the local
// machine daemon (127.0.0.1:${port}) and writes the transcript the daemon tails, because Amp keeps none
// on disk. No-op unless started by \`harness amp\` (MACHINE_ID) inside tmux.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const description = 'Mirrors this Amp thread to the machine adapter (web + device)'

const SESSIONS_DIR = ${JSON.stringify(sessionsDir)}

export default function (amp: any) {
  const pane = process.env.TMUX_PANE
  // The launcher (\`harness amp\`) mints a UUID per launch and exports it as MACHINE_ID; the daemon binds
  // a session's lifetime to that launcher and REFUSES a registration without one. An amp started outside
  // the launcher inherits neither variable, which is exactly when this plugin must do nothing at all.
  const launcherId = process.env.MACHINE_ID
  if (!pane || !launcherId) return

  // NOT \`process.cwd()\`: Bun runs a plugin with the PLUGIN's directory as its cwd, so that reports
  // \`<project>/.amp/plugins\` (measured). \`harness amp\` exports the real one; \`PWD\` from the launching
  // shell is the fallback for an amp the launcher did not start — which the MACHINE_ID guard above has
  // already excluded, so it is only ever a belt-and-braces third choice.
  const workdir = process.env.HARNESS_AGENT_CWD || process.env.PWD || process.cwd()

  const emitted = new Set()
  // Turn ids already opened/closed. Amp re-dispatches a message it could not deliver, firing agent.start
  // a SECOND time for the same message id (measured: two identical turn_start records 61s apart, then a
  // turn_end 'done' and a turn_end 'error' for the one turn). Written straight through, that is two turns
  // on web and device and two user bubbles in history.
  const turnsStarted = new Set()
  const turnsEnded = new Set()
  // Tool ids already written, so a tool seen BOTH as an event and as a message block is written once.
  const toolCalls = new Set()
  const toolResults = new Set()
  let registered = false
  let file = ''
  let seeded = false

  const line = (record: any) => {
    try {
      mkdirSync(SESSIONS_DIR, { recursive: true })
      appendFileSync(file, JSON.stringify(record) + '\\n')
    } catch {}
  }

  const open = (threadId: string) => {
    if (file) return
    file = join(SESSIONS_DIR, threadId + '.jsonl')
    // \`cwd\` on the first line is what lets the daemon re-find this session by directory after a restart,
    // the same way it reads claude's and pi's transcripts. It must be a top-level string field.
    line({ t: 'session', threadId, cwd: workdir, at: Date.now() })
  }

  const register = async (threadId: string) => {
    open(threadId)
    if (registered || !existsSync(file)) return
    try {
      const res = await fetch('http://127.0.0.1:${port}/api/hook/session-start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          engine: 'amp',
          pluginVersion: ${JSON.stringify(VERSION)},
          launcherId,
          sessionId: threadId,
          transcriptPath: file,
          cwd: workdir,
          tmuxPane: pane,
        }),
      })
      if (res.ok) registered = true
    } catch {}
  }

  const resultId = (block: any) => String(block.toolUseID || block.tool_use_id || '')

  /**
   * Write everything in the thread that has not been written yet.
   *
   * This reads message BLOCKS rather than events, because the events do not cover the thread:
   *
   *   - no event carries assistant text at all, and
   *   - \`tool.call\`/\`tool.result\` only fire for tools the CLIENT executes. MEASURED: a \`web_search\`
   *     turn produced no tool event and no tool lease in Amp's own log, yet the message plainly held a
   *     \`tool_use\` block — Amp runs that tool on its server. Skipping blocks meant a search rendered as
   *     nothing at all on web and device while the pane showed "Explored 1 search".
   *
   * \`seed\` marks what already exists WITHOUT writing it, for a thread that is being resumed: those
   * messages belong to earlier turns, and replaying them made a fresh turn open with an old answer in it.
   */
  const drain = async (ctx: any) => {
    let messages: any[] = []
    try { messages = await ctx.thread.messages({ from: 'end', limit: 20 }) } catch { return }
    // The FIRST drain of this plugin instance only claims what it finds; it writes nothing. That covers
    // both ways a plugin meets a thread that already has messages: a resumed thread, and a plugin reload
    // (Amp loads a plugin ONCE per process, so reload is how a running pane picks up a new build). Without
    // it, the next prompt replayed the whole recent history as if it had just happened.
    const seed = !seeded
    seeded = true
    for (const message of messages) {
      const blocks = Array.isArray(message.content) ? message.content : []
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        if (!block) continue
        if (block.type === 'text' || block.type === 'thinking') {
          if (message.role !== 'assistant') continue
          const key = String(message.id) + '#' + i
          if (emitted.has(key)) continue
          const text = typeof block.text === 'string' ? block.text : block.thinking
          if (typeof text !== 'string' || !text) continue
          emitted.add(key)
          if (!seed) line({ t: block.type, id: message.id, i, text })
        } else if (block.type === 'tool_use') {
          const id = String(block.id || '')
          if (!id || toolCalls.has(id)) continue
          toolCalls.add(id)
          if (!seed) line({ t: 'tool_call', id, tool: block.name, input: block.input })
        } else if (block.type === 'tool_result') {
          const id = resultId(block)
          if (!id || toolResults.has(id)) continue
          toolResults.add(id)
          // A server-run tool puts its payload under \`run\`; a client-run one under \`content\`/\`output\`.
          if (!seed) line({ t: 'tool_result', id, status: 'done', output: block.run ?? block.content ?? block.output })
        }
      }
    }
  }

  amp.on('session.start', async (event: any, ctx: any) => {
    await register(event.thread.id)
    await drain(ctx)
  })

  amp.on('agent.start', async (event: any, ctx: any) => {
    await register(event.thread.id)
    const id = String(event.id)
    if (!turnsStarted.has(id)) {
      turnsStarted.add(id)
      line({ t: 'turn_start', id: event.id, message: event.message, at: Date.now() })
    }
    await drain(ctx)
  })

  amp.on('tool.call', async (event: any, ctx: any) => {
    await register(event.thread.id)
    // CLAIM THE ID FIRST. \`drain\` runs before this card so a message's prose lands ahead of the tool it
    // called — but by then the tool_use block for THIS tool is already in the thread, so draining without
    // claiming wrote the card twice (measured: one Task turn produced two identical \`skill\` cards).
    toolCalls.add(String(event.toolUseID))
    await drain(ctx)
    line({ t: 'tool_call', id: event.toolUseID, tool: event.tool, input: event.input })
  })

  amp.on('tool.result', async (event: any, ctx: any) => {
    // Same rule as tool.call: claim before draining.
    toolResults.add(String(event.toolUseID))
    line({
      t: 'tool_result',
      id: event.toolUseID,
      tool: event.tool,
      status: event.status,
      output: event.output,
    })
    await drain(ctx)
  })

  amp.on('agent.end', async (event: any, ctx: any) => {
    await drain(ctx)
    // \`message\` is the prompt that STARTED this turn, and agent.end carries it even when
    // agent.start never fired (a prompt queued while Amp was connecting). Recording it here is what
    // lets history still show what was asked — see the replay branch in the normalizer.
    const id = String(event.id)
    if (turnsEnded.has(id)) return
    turnsEnded.add(id)
    line({ t: 'turn_end', id: event.id, status: event.status, message: event.message, at: Date.now() })
  })
}
`
}

/** Idempotently drop the Amp plugin into ~/.config/amp/plugins/. */
export function installAmpPlugin(port: number): void {
  const source = ampPluginSource(port, env.AMP_SESSIONS_DIR)
  try {
    if (existsSync(AMP_PLUGIN_PATH) && readFileSync(AMP_PLUGIN_PATH, 'utf-8') === source) {
      console.log('[hooks] Amp plugin already installed')
      return
    }
  } catch { /* unreadable — rewrite it */ }
  try {
    mkdirSync(dirname(AMP_PLUGIN_PATH), { recursive: true })
    mkdirSync(env.AMP_SESSIONS_DIR, { recursive: true })
    const tmp = `${AMP_PLUGIN_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, source)
    renameSync(tmp, AMP_PLUGIN_PATH)
    console.log(`[hooks] installed Amp plugin → ${AMP_PLUGIN_PATH}`)
    // Amp loads a plugin ONCE per process, so a pane that is already open keeps running the old one —
    // measured the hard way: an amp started at 11:49 went on writing tool-less transcripts for hours
    // after the fix landed on disk. Say what to do about it rather than leaving it to be discovered.
    console.log('[hooks] a NEW amp session picks this up automatically; for one already open, run')
    console.log("[hooks]   ctrl+o → 'plugins: reload'   (or restart that pane)")
  } catch (err) {
    console.error('[hooks] failed to write Amp plugin:', err)
  }
}

/** Idempotently drop the OpenCode discovery plugin into ~/.config/opencode/plugin/. */
export function installOpencodePlugin(port: number): void {
  const source = opencodePluginSource(port)
  try {
    if (existsSync(OPENCODE_PLUGIN_PATH) && readFileSync(OPENCODE_PLUGIN_PATH, 'utf-8') === source) {
      console.log('[hooks] OpenCode discovery plugin already installed')
      return
    }
  } catch { /* unreadable — rewrite it */ }
  try {
    mkdirSync(dirname(OPENCODE_PLUGIN_PATH), { recursive: true })
    const tmp = `${OPENCODE_PLUGIN_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, source)
    renameSync(tmp, OPENCODE_PLUGIN_PATH)
    console.log(`[hooks] installed OpenCode discovery plugin → ${OPENCODE_PLUGIN_PATH}`)
    console.log('[hooks] (takes effect on the next opencode session start)')
  } catch (err) {
    console.error('[hooks] failed to write OpenCode plugin:', err)
  }
}

/**
 * Install/refresh the hook (or plugin/extension) for ONE engine.
 *
 * Used by the `harness <engine>` launcher, which calls this immediately BEFORE spawning the CLI. Every
 * installer above ends with "(takes effect on the next session start)" — running it here means the
 * session we are about to start IS that next one, closing the gap where a freshly-installed machine
 * missed the very first session because its hooks landed too late.
 *
 * Installers are idempotent (they collapse any block whose command contains `notify.mjs` into one
 * canonical entry and leave foreign blocks alone), so calling this on every launch is cheap and safe.
 */
export function installHooksFor(engine: AgentEngine, port: number): void {
  switch (engine) {
    case 'claude': installSessionHooks(port); break
    case 'codex': installCodexHooks(port); break
    case 'cursor': installCursorHooks(port); break
    case 'opencode': installOpencodePlugin(port); break
    case 'pi': installPiExtension(port); break
    case 'hermes': installHermesHooks(port); break
    case 'commandcode': installCommandCodeHooks(port); break
    case 'devin': installDevinHooks(port); break
    case 'amp': installAmpPlugin(port); break
  }
}
