/**
 * Pointing an agent at an Autonomous Grid instead of the engine's own login.
 *
 * The desktop app lets a user pick a grid (and optionally a model), mints a short-lived relay key for
 * it, and sends the result as `payload.grid` on `agent_create` / `agent_retarget`. Nothing about that
 * reaches an engine by itself: this CLI is what spawns the engine, so this module turns that payload
 * into the launch — environment, and where the vendor demands it, argv.
 *
 * ## Every entry here is the vendor's own documented contract
 *
 * The relay speaks two dialects — Anthropic Messages at `<grid>/relay`, and OpenAI
 * chat/completions + responses at `<grid>/relay/v1` — so an engine can be pointed at it only if the
 * engine itself offers a way to change its endpoint. Those ways differ, and none of them is
 * guessable: `ANTHROPIC_BASE_URL` for Claude Code, `-c model_providers.*` argv for Codex,
 * `GROK_MODELS_BASE_URL` for Grok, `COPILOT_PROVIDER_BASE_URL` for Copilot. Each entry below cites
 * where it was read from.
 *
 * An engine with no entry is REFUSED, and the refusal names why for that engine specifically. Three
 * shapes of "no" appear, and they are worth telling apart because only one of them could ever change
 * on our side:
 *
 *   * **Wrong protocol.** The engine CAN be re-pointed, but at its own vendor's API rather than an
 *     OpenAI- or Anthropic-shaped one. Cursor Agent reads `CURSOR_API_ENDPOINT` (default
 *     `https://api2.cursor.sh`, read out of the shipped bundle) and Antigravity reads
 *     `GOOGLE_GEMINI_BASE_URL` — handing either the relay would send it a dialect the relay does not
 *     serve (grid ADR 0012 lists Gemini as a future data edit, not a served endpoint). A knob
 *     existing is not the same as a knob that helps, and pointing one of these at a grid would fail
 *     inside the app with an error naming neither.
 *   * **Config-file only** (pi, kilo): the provider block has to be written into the user's own
 *     dotfile. Editing another tool's configuration on someone's behalf is a side effect that
 *     outlives the agent, so this module does not do it.
 *   * **Nothing documented** (muse, commandcode, amp, devin): no vendor documentation describes an
 *     endpoint override. These are the entries that could gain a contract tomorrow — with a cited
 *     source, not a plausible-looking variable name.
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
   * Per-engine forms are derived from this; see [relayBaseUrl] and [anthropicBaseUrl].
   */
  baseUrl: string
  /** Short-lived, minted per launch. Never logged, and never placed in argv. */
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
 * ends up in a process environment or an argv. Rejecting them keeps a malformed frame from producing
 * an engine whose launch is subtly not what either side thinks it is.
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

/** The OpenAI-compatible relay root — what every engine here wants except Claude Code. */
export function relayBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/**
 * The relay root Claude Code wants.
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

/** How one engine is launched against a grid. */
export interface GridEngineLaunch {
  /** Layered over the engine's inherited environment. This is where the key goes, always. */
  env: Record<string, string>
  /** Appended to the engine's argv. Never carries the key — `ps` is world-readable. */
  args: string[]
}

interface GridEngineContract {
  build: (override: GridLaunchOverride) => GridEngineLaunch
  /** The engine cannot start against a grid without being told which model to ask for. */
  requiresModel?: boolean
}

/** The variable Codex is told to read the key from — its own `env_key` indirection. */
const CODEX_KEY_VAR = 'GRID_API_KEY'

/**
 * Every engine that can be pointed at a grid, and how.
 *
 * `undefined` is a refusal with a reason attached in [GRID_ENGINE_REFUSALS]; see the module comment
 * for why a missing entry is never filled in with a plausible-looking guess.
 */
const GRID_ENGINE_CONTRACTS: Partial<Record<AgentEngine, GridEngineContract>> = {
  // The grid CLI's own launch target (`autonomous-grid/shared/launch/claude.py`), so these are the
  // vendor's names as that team verified them rather than this repo's reading of them.
  claude: {
    build: (override) => ({
      env: {
        ANTHROPIC_BASE_URL: anthropicBaseUrl(override.baseUrl),
        // The bearer variable, and ONLY it. Claude Code warns when ANTHROPIC_AUTH_TOKEN and
        // ANTHROPIC_API_KEY are both set, and the relay prefers the Bearer header anyway — so
        // ANTHROPIC_API_KEY would decide nothing, while colliding with the variable a user's own
        // Anthropic key lives in.
        ANTHROPIC_AUTH_TOKEN: override.apiKey,
        // `grid launch claude` deliberately sets no model variable, on the grounds that a launcher
        // has no standing to choose a user's model. That reasoning does not carry here: the desktop
        // app ASKED, and this is the answer. Left unset when the user picked no model.
        ...(override.model ? { ANTHROPIC_MODEL: override.model } : {}),
      },
      args: [],
    }),
  },

  // Codex configures its provider entirely on the command line — `-c key=value` overrides anything
  // `~/.codex/config.toml` would have said, which is how `ori codex` points it at OpenRouter without
  // touching a dotfile (see `gatewayRuntime.ts`). Key names verified against the grid repo's
  // `docs/codex-quickstart.md` and `-c` against codex-cli 0.144.6 on this machine.
  //
  // The key travels in the environment under `env_key`, never in argv.
  codex: {
    build: (override) => ({
      env: { [CODEX_KEY_VAR]: override.apiKey },
      args: [
        '-c', 'model_provider="grid"',
        '-c', 'model_providers.grid.name="Autonomous Grid"',
        '-c', `model_providers.grid.base_url="${relayBaseUrl(override.baseUrl)}"`,
        '-c', `model_providers.grid.env_key="${CODEX_KEY_VAR}"`,
        // Mandatory: Codex speaks the Responses dialect and rejects `wire_api = "chat"`.
        '-c', 'model_providers.grid.wire_api="responses"',
        // The relay streams HTTP SSE, not WebSocket.
        '-c', 'model_providers.grid.supports_websockets=false',
        ...(override.model ? ['-m', override.model] : []),
      ],
    }),
  },

  // opencode's simplest documented custom provider: the OpenAI-compatible pair
  // (https://opencode.ai/docs/providers). The model is left to the app — its `--model` wants a
  // `provider/model` pair whose provider id is not documented for the env-var route, and inventing
  // one would send it looking for a model that does not exist.
  opencode: {
    build: (override) => ({
      env: {
        OPENAI_BASE_URL: relayBaseUrl(override.baseUrl),
        OPENAI_API_KEY: override.apiKey,
      },
      args: [],
    }),
  },

  // Nous Research's documented trio for a custom OpenAI-compatible endpoint
  // (hermes-agent/website/docs/reference/environment-variables.md).
  hermes: {
    build: (override) => ({
      env: {
        OPENAI_BASE_URL: relayBaseUrl(override.baseUrl),
        OPENAI_API_KEY: override.apiKey,
        ...(override.model ? { HERMES_INFERENCE_MODEL: override.model } : {}),
      },
      args: [],
    }),
  },

  // xAI's own Grok CLI (the one this repo discovers under `~/.grok`, whose transcripts carry the
  // `_x.ai/session/update` method). Its docs: "Grok fetches the model list from {base_url}/models",
  // and "when you set models_base_url, Grok uses API key auth instead of session auth" — which is
  // exactly the swap being asked for here. The model has no documented variable, so it goes in argv.
  grok: {
    build: (override) => ({
      env: {
        GROK_MODELS_BASE_URL: relayBaseUrl(override.baseUrl),
        XAI_API_KEY: override.apiKey,
      },
      args: override.model ? ['-m', override.model] : [],
    }),
  },

  // GitHub's documented BYOK path for Copilot CLI (docs.github.com … /use-byok-models). Copilot
  // will not start against a custom provider without being told the model, so that is enforced
  // here rather than left to fail inside the app.
  copilot: {
    requiresModel: true,
    build: (override) => ({
      env: {
        COPILOT_PROVIDER_BASE_URL: relayBaseUrl(override.baseUrl),
        COPILOT_PROVIDER_API_KEY: override.apiKey,
        ...(override.model ? { COPILOT_MODEL: override.model } : {}),
      },
      args: [],
    }),
  },
}

/**
 * Why an engine cannot be pointed at a grid, in words the person who picked it can act on.
 *
 * Every engine without a contract has an entry: "unsupported" on its own tells a user nothing about
 * whether to wait for a release, change a setting, or pick another engine.
 */
const GRID_ENGINE_REFUSALS: Partial<Record<AgentEngine, string>> = {
  cursor: 'Cursor Agent can only be re-pointed at another Cursor API (CURSOR_API_ENDPOINT), '
    + 'not at an OpenAI-compatible relay',
  agy: 'Antigravity speaks the Gemini API, which this relay does not serve',
  pi: 'Pi needs a provider block written into ~/.pi/agent/models.json, which this will not edit for you',
  kilo: 'the Kilo CLI has no OpenAI-compatible provider option yet (its own issues #5840, #6315)',
  amp: 'Amp documents no way to change where it sends inference',
  devin: 'Devin runs on its own hosted service and documents no endpoint override',
  muse: 'Muse Code documents no way to change its endpoint',
  commandcode: 'Command Code documents no way to change its endpoint',
}

/** Engines that can be pointed at a grid today, for error text that names what to pick instead. */
export function gridCapableEngines(): AgentEngine[] {
  return Object.keys(GRID_ENGINE_CONTRACTS) as AgentEngine[]
}

export type GridLaunchResult =
  | { ok: true; launch: GridEngineLaunch }
  | { ok: false; error: string; detail: string }

/** How `engine` must be launched to reach `override`, or why it cannot be. */
export function buildGridEngineLaunch(engine: AgentEngine, override: GridLaunchOverride): GridLaunchResult {
  const contract = GRID_ENGINE_CONTRACTS[engine]
  if (!contract) {
    const reason = GRID_ENGINE_REFUSALS[engine] ?? 'it has no known way to change its endpoint'
    return {
      ok: false,
      error: 'GRID_ENGINE_UNSUPPORTED',
      detail: `${engine} cannot run on grid ${override.networkName}: ${reason}. `
        + `It would have run on its own login instead. Engines that can: ${gridCapableEngines().join(', ')}.`,
    }
  }
  if (contract.requiresModel && !override.model) {
    return {
      ok: false,
      error: 'GRID_MODEL_REQUIRED',
      detail: `${engine} will not start against a grid without a model. `
        + `Pick one for ${override.networkName} and try again.`,
    }
  }
  return { ok: true, launch: contract.build(override) }
}

/** One log line naming where an agent was sent — grid, model, engine. Never the key. */
export function describeGridLaunch(engine: AgentEngine, override: GridLaunchOverride): string {
  return `[grid] ${engine} -> ${override.networkName} (${override.networkId})`
    + ` · ${override.model ?? 'model chosen by the engine'}`
}
