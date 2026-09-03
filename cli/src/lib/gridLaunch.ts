/**
 * Pointing a newly created agent at an Autonomous Grid instead of the engine's own login.
 *
 * The desktop app lets a user pick a grid (and optionally a model), mints a short-lived relay key for
 * it, and sends the result as `payload.grid` on `agent_create`. Nothing about that reaches an engine
 * by itself: this CLI is what spawns the engine, so this module turns that payload into the
 * environment the engine is launched with.
 *
 * ## The relay is OpenAI-compatible, and that is not enough
 *
 * Every engine here can in principle be pointed somewhere else, but only through the mechanism its
 * own vendor supports, and those genuinely differ — Claude Code reads environment variables, while
 * the Codex CLI needs a `[model_providers.*]` block in `~/.codex/config.toml` (verified in the grid
 * repo's `docs/codex-quickstart.md`; `wire_api = "responses"` is mandatory there and has no
 * environment-only spelling). Writing another tool's config file on a user's behalf is a side effect
 * that outlives the agent, so this module does not do it, and an engine whose contract we have not
 * verified is refused rather than guessed at — the same rule `BYPASS_PERMISSION_FLAGS` already
 * follows in `engineLaunch.ts`.
 *
 * Refusing is the point. Silently launching against the engine's own login would put the agent
 * somewhere other than where the user said, spend the wrong account, and look like it worked.
 */

import type { AgentEngine } from '../engines/types.js'

/** What the desktop sends, once validated. Mirrors `GridAgentOverride` in the desktop app. */
export interface GridLaunchOverride {
  networkId: string
  /** The grid's display name — for log lines and error text, never for routing. */
  networkName: string
  /**
   * The grid's OpenAI-compatible relay root, as the control plane reports it: `<grid>/relay/v1`.
   * Per-engine forms are derived from this; see `anthropicBaseUrl`.
   */
  baseUrl: string
  /** Short-lived, minted per launch. Never logged. */
  apiKey: string
  /** Absent means "whatever the engine asks for" — the relay's own default. */
  model?: string
}

export type GridOverrideParse =
  | { state: 'absent' }
  | { state: 'ok'; override: GridLaunchOverride }
  | { state: 'invalid'; reason: string }

/**
 * Control characters have no place in a URL, a token or a model id, and every one of these values
 * ends up in a process environment. Rejecting them keeps a malformed frame from producing an engine
 * whose environment is subtly not what either side thinks it is.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

function requiredString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || CONTROL_CHARS.test(trimmed)) return null
  return trimmed
}

/**
 * `payload.grid` as a validated override, or the reason it is not one.
 *
 * Absent is a first-class answer, not a failure: a build with no grid selected sends no `grid` field
 * at all, and must create agents exactly the way it always did.
 */
export function parseGridLaunchOverride(raw: unknown): GridOverrideParse {
  if (raw === undefined || raw === null) return { state: 'absent' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { state: 'invalid', reason: 'grid must be an object' }
  const source = raw as Record<string, unknown>
  const networkId = requiredString(source, 'networkId')
  const networkName = requiredString(source, 'networkName')
  const baseUrl = requiredString(source, 'baseUrl')
  const apiKey = requiredString(source, 'apiKey')
  const missing = [
    networkId ? null : 'networkId',
    networkName ? null : 'networkName',
    baseUrl ? null : 'baseUrl',
    apiKey ? null : 'apiKey',
  ].filter((name): name is string => name !== null)
  if (missing.length) return { state: 'invalid', reason: `grid is missing ${missing.join(', ')}` }
  // An engine is about to be handed this as the address it talks to, so it has to be an address:
  // anything else (a `file:` URL, a bare hostname, a path) would fail inside the engine with an
  // error naming neither the grid nor this frame.
  let parsed: URL
  try {
    parsed = new URL(baseUrl as string)
  } catch {
    return { state: 'invalid', reason: 'grid baseUrl is not a URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { state: 'invalid', reason: `grid baseUrl must be http(s), got ${parsed.protocol}` }
  }
  const hasModel = source.model !== undefined && source.model !== null
  const model = hasModel ? requiredString(source, 'model') : undefined
  if (hasModel && !model) return { state: 'invalid', reason: 'grid model must be a non-empty string' }
  return {
    state: 'ok',
    override: {
      networkId: networkId as string,
      networkName: networkName as string,
      baseUrl: baseUrl as string,
      apiKey: apiKey as string,
      ...(model ? { model } : {}),
    },
  }
}

/**
 * The relay root Claude Code wants, from the OpenAI-compatible one the control plane hands out.
 *
 * The app appends `/v1/messages` itself, so the `/v1` an OpenAI SDK needs would 404 every request
 * here — the same one-character difference that makes `grid launch claude --print-env` a separate
 * command from `grid info --env` in the grid CLI. Idempotent: a base that already lacks `/v1` comes
 * back unchanged.
 */
export function anthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
}

/**
 * How each engine is pointed at a grid through its environment alone — `null` where no such
 * mechanism is confirmed to exist.
 *
 * `null` is a refusal, not a gap to be filled in later with a plausible guess; see the module
 * comment. The one entry here is the one the grid CLI itself ships as a launch target
 * (`autonomous-grid/shared/launch/claude.py`), so these variable names are the vendor's own contract
 * rather than this repo's reading of it.
 */
export const GRID_ENGINE_ENV: Readonly<
  Record<AgentEngine, ((override: GridLaunchOverride) => Record<string, string>) | null>
> = {
  claude: (override) => ({
    ANTHROPIC_BASE_URL: anthropicBaseUrl(override.baseUrl),
    // The bearer variable, and ONLY it. Claude Code warns when ANTHROPIC_AUTH_TOKEN and
    // ANTHROPIC_API_KEY are both set, and the relay prefers the Bearer header anyway — so
    // ANTHROPIC_API_KEY would decide nothing, while colliding with the variable a user's own
    // Anthropic key lives in.
    ANTHROPIC_AUTH_TOKEN: override.apiKey,
    // `grid launch claude` deliberately sets no model variable, on the grounds that a launcher has no
    // standing to choose a user's model. That reasoning does not carry here: the desktop app ASKED,
    // and this is the answer. Left unset when the user picked no model, which leaves the app's own
    // defaults, `settings.json` and `/model` in charge exactly as before.
    ...(override.model ? { ANTHROPIC_MODEL: override.model } : {}),
  }),
  // Config-file only: `[model_providers.grid]` with `wire_api = "responses"` in ~/.codex/config.toml.
  codex: null,
  // Unverified — do not guess an environment contract for a CLI we have not checked.
  cursor: null,
  opencode: null,
  pi: null,
  hermes: null,
  commandcode: null,
  devin: null,
  muse: null,
  amp: null,
  kilo: null,
  grok: null,
  agy: null,
  copilot: null,
}

/** Engines that can be pointed at a grid today, so error text can name what to pick instead. */
export function gridCapableEngines(): AgentEngine[] {
  return (Object.keys(GRID_ENGINE_ENV) as AgentEngine[]).filter((engine) => GRID_ENGINE_ENV[engine] !== null)
}

export type GridEnvResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string; detail: string }

/** The environment `engine` must be launched with to reach `override`, or why it cannot be. */
export function buildGridEngineEnv(engine: AgentEngine, override: GridLaunchOverride): GridEnvResult {
  const build = GRID_ENGINE_ENV[engine]
  if (!build) {
    return {
      ok: false,
      error: 'GRID_ENGINE_UNSUPPORTED',
      detail: `${engine} cannot be pointed at a grid through its environment, so it would have run on `
        + `its own login instead of grid ${override.networkName}. `
        + `Engines that can: ${gridCapableEngines().join(', ')}.`,
    }
  }
  return { ok: true, env: build(override) }
}

/** One log line naming where an agent was sent — grid, model, engine. Never the key. */
export function describeGridLaunch(engine: AgentEngine, override: GridLaunchOverride): string {
  return `[grid] ${engine} -> ${override.networkName} (${override.networkId})`
    + ` · ${override.model ?? 'model chosen by the engine'}`
}
