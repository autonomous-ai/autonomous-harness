import 'dotenv/config'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod'

// Packaged files (cli.js/notify.mjs) live in ~/.harness/cli; mutable state in ~/.harness/cli/data.
// `~/.harness` is the PRODUCT data root and does not move — see the naming discipline in CLAUDE.md.
const adapterCliDir = join(homedir(), '.harness', 'cli')
const adapterDataDir = join(adapterCliDir, 'data')

// ── One-time adoption of adapter state written under an older name ────────────────────────────────
//
// Two accidents from the machine rename, with different resolutions:
//
//  1. A released build resolved the root as `~/.machine/cli` instead of `~/.harness/cli`. Anyone who
//     ran it has been LIVING there since — that tree holds their current token, tmux registry and
//     E2EE pairings, while `~/.harness` is frozen at whatever it was when they upgraded. So the data
//     dir is FORCE-MOVED across: `~/.machine` wins outright. Anything else would silently roll those
//     users back to a stale token and an empty session registry.
//  2. Files INSIDE the data dir were renamed (machine-id → computer-id, harness-name → machine-name,
//     harness.log → machine.log). Within one tree there is nothing to arbitrate, so those only fire
//     when the new name is still free — and they run first, so the force-move above still wins.
//
// `renameSync` preserves the inode, so a daemon still holding an fd on the old path keeps writing
// into the same file under its new name.

/** Move `legacy` → `current` only when `current` is free (in-tree rename). */
function adoptPath(current: string, legacy: string): boolean {
  try {
    if (existsSync(current) || !existsSync(legacy)) return false
    renameSync(legacy, current)
    return true
  } catch {
    return false // best-effort: a failed adoption must never stop the CLI from starting
  }
}

/** Move `legacy` → `current`, replacing whatever is there. Used only for the ~/.machine data dir. */
function forceMove(current: string, legacy: string): boolean {
  try {
    rmSync(current, { recursive: true, force: true })
    renameSync(legacy, current)
    return true
  } catch {
    return false
  }
}

function migrateLegacyAdapterState(): void {
  // Only for the default location. An explicit ADAPTER_DATA_DIR (tests, custom installs) is the
  // caller's business and must not be reshaped underneath them.
  if (process.env.ADAPTER_DATA_DIR) return

  let moved = 0

  // In-tree renames first, so a machine that never saw the ~/.machine build still lands on the new
  // names. The force-move below overrides these where both exist.
  for (const [current, legacy] of [
    ['computer-id', 'machine-id'],
    ['machine-name', 'harness-name'],
    ['machine.log', 'harness.log'],
  ]) {
    if (adoptPath(join(adapterDataDir, current), join(adapterDataDir, legacy))) moved++
  }

  const strayDataDir = join(homedir(), '.machine', 'cli', 'data')
  if (existsSync(strayDataDir)) {
    mkdirSync(adapterDataDir, { recursive: true })
    for (const entry of readdirSync(strayDataDir)) {
      if (forceMove(join(adapterDataDir, entry), join(strayDataDir, entry))) moved++
    }
    // Whole stray tree goes: its cli.js/notify.mjs are only a bundle copy the launcher never runs
    // (it execs ~/.harness/cli/cli.js) and the next self-update rewrites them.
    try {
      rmSync(join(homedir(), '.machine'), { recursive: true, force: true })
    } catch { /* ignore */ }
    console.warn(`[machine] moved adapter state from ~/.machine/cli/data into ${adapterDataDir}`)
  } else if (moved) {
    console.warn(`[machine] renamed ${moved} pre-rename file(s) in ${adapterDataDir}`)
  }
}

migrateLegacyAdapterState()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Localhost port the SessionStart/SessionEnd hook callbacks POST to (hook/notify.mjs). A quiet FIXED
  // value (below the OS ephemeral range, outside the project's 80xx/8100-8999/9001-9999 ranges). No
  // free-port fallback — if it's taken, the adapter reports it (another adapter is likely running).
  PORT: z.string().default('18473').transform(Number),
  // The backend the CLI dials (`/api/adapter-ws`). Local dev: ws://localhost:8090.
  BACKEND_WS_URL: z.string().default('wss://harness-api.autonomous.ai'),
  // Web app base URL — used to print the agent's chat link on `adapter start`. Local: http://localhost:3000.
  WEB_URL: z.string().default('https://harness.autonomous.ai'),
  // Connect token (the agent apiKey). Usually passed as `adapter start <token>` and persisted to
  // ${ADAPTER_DATA_DIR}/token; this env var overrides both.
  ADAPTER_TOKEN: z.string().optional(),
  // Where Claude Code writes its per-session JSONL transcripts.
  CLAUDE_PROJECTS_DIR: z.string().default(join(homedir(), '.claude', 'projects')),
  // Codex state root. Only hook-registered rollout files beneath <CODEX_HOME>/sessions are exposed.
  CODEX_HOME: z.string().default(join(homedir(), '.codex')),
  // Grok state root. Conversation records live below <GROK_HOME>/sessions/<encoded-cwd>/<uuid>/updates.jsonl.
  GROK_HOME: z.string().default(join(homedir(), '.grok')),
  // Cursor state root. Interactive transcripts live below <CURSOR_HOME>/projects and local
  // subagent linkage metadata lives below <CURSOR_HOME>/chats.
  CURSOR_HOME: z.string().default(join(homedir(), '.cursor')),
  // OpenCode state root — the SQLite store lives at <OPENCODE_DATA_DIR>/opencode.db (honors
  // XDG_DATA_HOME). Sessions are polled from that DB (no per-session transcript file).
  OPENCODE_DATA_DIR: z
    .string()
    .default(join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode')),
  // OpenCode plugin dir the adapter drops its discovery plugin into (honors XDG_CONFIG_HOME).
  OPENCODE_PLUGIN_DIR: z
    .string()
    .default(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'plugin')),
  // Kilo state root — the SQLite store lives at <KILO_DATA_DIR>/kilo.db. Kilo is an opencode fork and
  // keeps the same layout, but NOT the same overrides: measured on 7.4.20 via `kilo debug paths`, it
  // honours XDG_DATA_HOME and ignores both `KILO_DATA_DIR` and `OPENCODE_DATA_DIR`. So this variable
  // steers the ADAPTER's reads only; anything that has to move KILO's own writes (the recap one-shot)
  // must set XDG_DATA_HOME on the child instead — see `KiloWorker` in lib/oneshot.ts.
  KILO_DATA_DIR: z
    .string()
    .default(join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'kilo')),
  // Kilo plugin dir the adapter drops its discovery plugin into (honors XDG_CONFIG_HOME — measured).
  KILO_PLUGIN_DIR: z
    .string()
    .default(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'kilo', 'plugin')),
  // Pi state root. Session transcripts live under <PI_HOME>/agent/sessions/--<mangled-cwd>--/*.jsonl and
  // the adapter's discovery extension is installed into <PI_HOME>/agent/extensions.
  PI_HOME: z.string().default(join(homedir(), '.pi')),
  // Hermes state root — the SQLite store is <HERMES_HOME>/state.db and the shell hooks the adapter
  // installs live in <HERMES_HOME>/config.yaml (+ shell-hooks-allowlist.json).
  HERMES_HOME: z.string().default(join(homedir(), '.hermes')),
  // Command Code state root — transcripts live under <COMMANDCODE_HOME>/projects/<cwd-slug>/<id>.jsonl
  // and the adapter installs its shell hooks into <COMMANDCODE_HOME>/settings.json.
  COMMANDCODE_HOME: z.string().default(join(homedir(), '.commandcode')),
  // Devin CLI state root — history is the SQLite store <DEVIN_HOME>/sessions.db (WAL, no transcript file
  // unless the user passes --export) and <DEVIN_HOME>/session_locks/<id>.lock holds the owning PID.
  DEVIN_HOME: z.string().default(join(homedir(), '.local', 'share', 'devin', 'cli')),
  // Muse Code state root. Transcripts are JSONL but the layout is DATE-SHARDED, not hashed by project
  // path: <MUSE_HOME>/sessions/YYYY/MM/DD/<session-uuid>/session.jsonl, with sub-agents one level deeper
  // under `subagent/<child-uuid>/`. The only link back to a project is `workspace_root`, carried in the
  // FIRST record of each file — which is why this engine is discovered by scanning rather than by a hook.
  MUSE_HOME: z.string().default(join(homedir(), '.local', 'share', 'muse')),
  MUSE_CONFIG_DIR: z.string().default(join(homedir(), '.config', 'muse')),
  // Amp plugin dir the adapter drops its discovery plugin into (honors XDG_CONFIG_HOME). Amp calls these
  // "system plugins" and loads every `*.ts` there for EVERY thread, which is what makes one install cover
  // all projects — the project-local `.amp/plugins/` alternative would need one copy per repo.
  AMP_PLUGIN_DIR: z
    .string()
    .default(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'amp', 'plugins')),
  // Where the Amp plugin writes the transcripts this adapter tails.
  //
  // Amp is the only supported engine that keeps NO conversation on disk: threads live on the server and
  // the sole local artefacts are a metadata-only debug log (no message text at all — measured) and
  // `session.json`. `amp threads export` can fetch the content, but it costs a ~1.5s network round trip
  // per read and never shows a message before it is complete. So the plugin writes the transcript we tail,
  // and this directory — ours, not Amp's — is the trusted root for it.
  AMP_SESSIONS_DIR: z.string().default(join(adapterDataDir, 'amp-sessions')),
  // Amp's own state dir, read-only for us: `session.json` there maps a tmux pane to the thread started in
  // it, which is how a re-attaching daemon re-binds a pane without guessing.
  AMP_STATE_DIR: z
    .string()
    .default(join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'amp')),
  // Devin's user-level config, where the adapter merges its hooks under a "hooks" key. Devin reads
  // Claude's hook schema verbatim, so the installed block is shaped exactly like ~/.claude/settings.json.
  DEVIN_CONFIG_PATH: z.string().default(join(homedir(), '.config', 'devin', 'config.json')),
  // Where the tmux-session registry + connect token are persisted.
  ADAPTER_DATA_DIR: z.string().default(adapterDataDir),
  // ---- Harness Analytics (see autonomous-code docs/design/harness-analytics.md) ----
  // Collection is ON by default, but this computer uploads NOTHING until the account owner has
  // acknowledged the field list — the backend answers `consent: "unacknowledged"` until then. This
  // flag exists to switch the collector off entirely (tests, air-gapped installs).
  ANALYTICS_ENABLED: z.string().default('true').transform((v) => v !== 'false'),
  // Defaults to BACKEND_WS_URL over https — the ingest endpoint is the same host, and deliberately
  // NOT the adapter socket: analytics must not share a pipe with the E2EE content channel.
  ANALYTICS_BACKEND_URL: z.string().optional(),
  ANALYTICS_FLUSH_INTERVAL_MS: z.string().default('60000').transform(Number),
  // Set to 'true' to skip auto-installing lifecycle hooks for every supported engine.
  DISABLE_HOOK_INSTALL: z.string().default('false').transform((v) => v === 'true'),
  // How often (ms) the reaper checks tmux panes and drops dead sessions.
  TMUX_REAP_INTERVAL_MS: z.string().default('5000').transform(Number),
  // Path to the `claude` CLI for the device turn-recap one-shot (else resolved from PATH).
  CLAUDE_PATH: z.string().optional(),
  // Path to the Cursor Agent CLI for recap one-shots (else a verified `agent`/`cursor-agent` is used).
  CURSOR_PATH: z.string().optional(),
  // Path to the `opencode` CLI for OpenCode recap one-shots (else `opencode` is resolved from PATH).
  OPENCODE_PATH: z.string().optional(),
  // Path to the `pi` CLI for Pi recap one-shots (else `pi` is resolved from PATH).
  PI_PATH: z.string().optional(),
  // Path to the `hermes` CLI for Hermes recap one-shots (else `hermes` is resolved from PATH).
  HERMES_PATH: z.string().optional(),
  // Path to the `commandcode` CLI for Command Code recap one-shots (else resolved from PATH).
  COMMANDCODE_PATH: z.string().optional(),
  // Path to the `devin` CLI for Devin recap one-shots (else `devin` is resolved from PATH).
  DEVIN_PATH: z.string().optional(),
  MUSE_PATH: z.string().optional(),
  // Path to the `amp` CLI for Amp recap one-shots (else `amp` is resolved from PATH).
  AMP_PATH: z.string().optional(),
  // Path to the `kilo` CLI for Kilo recap one-shots (else `kilo` is resolved from PATH). `@kilocode/cli`
  // also installs it as `kilocode`; both are the same file.
  KILO_PATH: z.string().optional(),
  // Path to the xAI Grok CLI for interactive sessions and recap one-shots.
  GROK_PATH: z.string().optional(),
  // Model for the device turn-recap one-shot.
  SUMMARY_MODEL: z.string().default('sonnet'),
  // Balanced Codex counterpart used only for recap workers; never inherits the interactive CLI model.
  CODEX_SUMMARY_MODEL: z.string().default('gpt-5.5'),
  // Cursor's Auto model keeps recap availability aligned with the user's Cursor account.
  CURSOR_SUMMARY_MODEL: z.string().default('auto'),
  // OpenCode recap model (`provider/model`). Empty → use the user's opencode config default model.
  OPENCODE_SUMMARY_MODEL: z.string().default(''),
  // Kilo recap model (`provider/model` as `kilo models` prints it). Empty → the user's kilo default.
  KILO_SUMMARY_MODEL: z.string().default(''),
  // Grok recap model. Empty → use the user's Grok CLI default model.
  GROK_SUMMARY_MODEL: z.string().default(''),
  // Pi recap model (`provider/model` or a model pattern). Empty → use the user's pi config default.
  PI_SUMMARY_MODEL: z.string().default(''),
  // Hermes recap model. Empty → use the user's ~/.hermes/config.yaml default (keeps their provider).
  HERMES_SUMMARY_MODEL: z.string().default(''),
  // Command Code recap model. Empty → use the user's own account default.
  COMMANDCODE_SUMMARY_MODEL: z.string().default(''),
  // Devin recap model. Empty → use the user's own account default (their plan decides what is available).
  DEVIN_SUMMARY_MODEL: z.string().default(''),
  MUSE_SUMMARY_MODEL: z.string().default(''),
  // Amp recap agent mode. Amp exposes no model list — `-m` picks a MODE (low|medium|high|ultra) and the
  // mode picks the model. `medium` on the project owner's call: `low` was the cheaper default but is no
  // more reliable on this path (both modes hit Amp's ~30s network timeout at similar rates, measured),
  // so the better answer wins over the cheaper one.
  AMP_SUMMARY_MODE: z.string().default('medium'),
  // Shared recap reasoning level for Claude and Codex. Cursor effort is part of its model identifier.
  SUMMARY_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  // Model for the voice router one-shot classifier (Overview voice → pick the agent). Small/fast by default.
  VOICE_ROUTE_MODEL: z.string().default('haiku'),
  // Test override: run the recap even with no device connected (mirrors node isRecapForced()).
  RECAP_FORCE: z.string().default('false').transform((v) => v === 'true'),

  // ── self-update (the daemon polls a GCS manifest and swaps its own bundle) ──────────────────────
  // Manifest URL (same GCS bucket + metadata.json shape as the device OTA; key = ADAPTER_UPDATE_KEY).
  ADAPTER_UPDATE_URL: z
    .string()
    .default('https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/cli/metadata.json'),
  ADAPTER_UPDATE_KEY: z.string().default('cli'),
  // How often the daemon checks for a newer build (ms). The poll is a tiny no-cache metadata fetch;
  // the artifact is downloaded only when the manifest version is strictly newer.
  ADAPTER_UPDATE_CHECK_MS: z.string().default('60000').transform(Number),
  // Set 'true' to disable self-update entirely.
  ADAPTER_UPDATE_DISABLE: z.string().default('false').transform((v) => v === 'true'),
  // Install dir holding the packaged cli.js + notify.mjs that the self-updater swaps in place.
  ADAPTER_CLI_DIR: z.string().default(adapterCliDir),
})

export type Env = z.infer<typeof envSchema>

function validateEnv(): Env {
  const parsed = envSchema.safeParse(process.env)

  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors)
    process.exit(1)
  }

  const data = parsed.data
  // Pair WEB_URL to the backend's environment. The `join` link is served by the WEB app that talks to
  // the SAME backend the adapter dials — so a code created on a LOCAL backend must be confirmed on the
  // LOCAL web. If WEB_URL wasn't set explicitly and BACKEND_WS_URL is loopback, default WEB_URL to the
  // local web (:3000) instead of prod — otherwise the printed link points at prod, which can't see it.
  if (!process.env.WEB_URL && /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(data.BACKEND_WS_URL)) {
    data.WEB_URL = 'http://localhost:3000'
  }
  return data
}

export const env = validateEnv()
