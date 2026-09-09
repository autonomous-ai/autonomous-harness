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

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import {
  claudeMcpConfig,
  codexMcpArgs,
  GRID_MCP_AUTH_VAR,
  GRID_MCP_SERVER_NAME,
  HERMES_MANAGED_CONFIG_FILE,
  HERMES_MANAGED_DIR_VAR,
  hermesManagedConfig,
  mcpAuthorizationHeader,
} from './gridWebMcp.js'

/** Where Pi keeps the skills the user manages, handed back through our own settings.json. */
function userPiSkillsDir(): string {
  return join(homedir(), '.pi', 'agent', 'skills')
}

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
  /**
   * The grid's web-tools MCP endpoint, on the CONTROL PLANE — `…/v1/grid/web-mcp/`, trailing slash
   * included, because without it the mount answers 307 and not every client follows one.
   *
   * Deliberately not derived here from [baseUrl]. That is the RELAY, and grid ADR 0041 D-a takes the
   * relay out of this path on purpose: a relay is per-grid, can be asleep, and for a self-hosted grid
   * is a LAN address a harness may not reach. The control plane's address is also not ours to guess —
   * it is whichever one the user's Grid CLI is signed into, and this machine may have no Grid session
   * at all. The desktop knows; this does not.
   *
   * Absent means no web tools, which is exactly what an older desktop sends.
   */
  mcpUrl?: string
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
 * Why [value] is not an address an engine can be handed, or null when it is one.
 *
 * Anything else — a `file:` URL, a bare hostname, a path — would fail inside the engine with an
 * error naming neither the grid nor this frame. Shared by the two URL fields rather than written
 * twice, so they cannot drift into disagreeing about what an address is.
 */
function urlProblem(field: string, value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return `grid ${field} is not a URL`
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `grid ${field} must be http(s), got ${parsed.protocol}`
  }
  return null
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
  const badBaseUrl = urlProblem('baseUrl', baseUrl as string)
  if (badBaseUrl) return { state: 'invalid', reason: badBaseUrl }
  const hasModel = source.model !== undefined && source.model !== null
  const model = hasModel ? requiredString(source, 'model') : undefined
  if (hasModel && !model) return { state: 'invalid', reason: 'grid model must be a non-empty string' }
  const hasMcpUrl = source.mcpUrl !== undefined && source.mcpUrl !== null
  const mcpUrl = hasMcpUrl ? requiredString(source, 'mcpUrl') : undefined
  if (hasMcpUrl && !mcpUrl) return { state: 'invalid', reason: 'grid mcpUrl must be a non-empty string' }
  const badMcpUrl = mcpUrl ? urlProblem('mcpUrl', mcpUrl) : null
  if (badMcpUrl) return { state: 'invalid', reason: badMcpUrl }
  return {
    state: 'ok',
    override: {
      networkId: networkId as string,
      networkName: networkName as string,
      baseUrl: baseUrl as string,
      apiKey: apiKey as string,
      ...(model ? { model } : {}),
      ...(mcpUrl ? { mcpUrl } : {}),
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

/**
 * The relay's routing strategy, used when the user picked no particular model.
 *
 * Not a model: send a request naming it and the grid chooses one. It is `owned_by: grid-router` in
 * the relay's `/models`, and the relay answers it like any other id — which is what lets a provider
 * block that must name SOMETHING name this.
 */
export const GRID_ROUTER_MODEL = 'Auto'

/** The file OpenCode's `OPENCODE_CONFIG` is pointed at. */
const OPENCODE_CONFIG_FILE = 'opencode.json'

/**
 * A grid's name as an OpenCode provider id.
 *
 * The id is what a person types as `<id>/<model>`, so it has to survive being typed: lowercase, no
 * spaces, no dots. Grid names carry all three — `autonomous.ai`, `private autonomous`, `macOS` — so
 * this is a real transformation rather than a formality.
 *
 *     autonomous.ai       -> autonomous-ai
 *     private autonomous  -> private-autonomous
 *     macOS               -> macos
 *
 * A name that leaves nothing behind (punctuation only) falls back to `grid`, because an empty
 * provider key would make the config unparseable rather than merely odd.
 */
export function gridProviderId(networkName: string): string {
  const slug = networkName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'grid'
}

/**
 * The provider block OpenCode reads, as JSON.
 *
 * Four things here are load-bearing, each of which breaks the engine differently when got wrong:
 *
 *  1. **No top-level `model` key.** OpenCode's schema `$ref`s a CLOSED enum of known public models
 *     with no wildcard branch, so naming a private grid's model there makes OpenCode refuse the
 *     whole config at startup — a failure that arrives as a dead pane, long after the launch looked
 *     fine. The model is selected on argv instead, which is not schema-validated.
 *  2. **`baseURL` is the relay root verbatim.** It already ends in `/relay/v1`; the SDK appends
 *     `/chat/completions` itself, so any "normalising" here 404s every request.
 *  3. **`apiKey` is `{env:…}`, not the key.** Nothing written to disk by this module may contain a
 *     credential. This diverges from the advice a person following OpenCode's own docs gets — there
 *     the literal is recommended, because an unset variable silently becomes an empty string and a
 *     human-launched OpenCode has no guarantee the variable is set. Here it IS guaranteed: the
 *     daemon puts it in the pane's environment with `tmux new-session -e` before the engine starts.
 *  4. **No `limit` block.** OpenCode requires `context` and `output` TOGETHER and rejects the config
 *     if only one is present. The relay reports a context window per model but this module is not
 *     the thing that read it, and inventing one would be worse than the defaults OpenCode already
 *     uses.
 */
function opencodeGridConfig(
  provider: string,
  override: GridLaunchOverride,
  model: string,
): string {
  // EXACTLY ONE model, and that is deliberate: it is what the agent was created with.
  //
  // Offering the router alongside it would let someone switch inside OpenCode, which reads as a
  // kindness until you ask what the agent is running on. The probe that answers that
  // (`readOpencodeGridAssignment`) reads this file, so a file naming two models can only say which
  // one is live by parsing the engine's argv — and an argv is a live process's business, which it
  // may rewrite. One model here makes the answer a fact about a file that cannot change under us.
  //
  // Choosing a different model is what every other engine here does too: per agent, at creation.
  const models: Record<string, { name: string }> = { [model]: { name: model } }
  return `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [provider]: {
        npm: '@ai-sdk/openai-compatible',
        // The grid's name as written — this is what a person reads in the model picker, so it keeps
        // its dots and its capitals while the id beside it does not.
        name: override.networkName,
        options: {
          baseURL: relayBaseUrl(override.baseUrl),
          apiKey: `{env:${GRID_KEY_VAR}}`,
        },
        models,
      },
    },
    // The grid's web tools, referencing the key exactly the way `apiKey` above does — opencode's own
    // `{env:…}`, so this file still contains no credential.
    ...(override.mcpUrl
      ? {
        mcp: {
          [GRID_MCP_SERVER_NAME]: {
            type: 'remote',
            url: override.mcpUrl,
            enabled: true,
            headers: { Authorization: `Bearer {env:${GRID_KEY_VAR}}` },
          },
        },
      }
      : {}),
  }, null, 2)}\n`
}

/** One file to write into the per-agent config directory a launch is given. */
export interface GridConfigFile {
  /** File name inside the directory. Never a path — this writes one flat directory. */
  name: string
  content: string
}

/** How one engine is launched against a grid. */
export interface GridEngineLaunch {
  /** Layered over the engine's inherited environment. This is where the key goes, always. */
  env: Record<string, string>
  /** Appended to the engine's argv. Never carries the key — `ps` is world-readable. */
  args: string[]
  /**
   * For an engine that reads its provider out of a config directory rather than an environment
   * variable: files the daemon writes into a directory IT owns, and the variable that points the
   * engine at that directory.
   *
   * This is not "editing the user's dotfiles" — the point of the indirection is that it never
   * touches them. The engine gets a private configuration for this agent, the user's own stays
   * exactly as they left it, and deleting the directory undoes everything. No file written here may
   * contain the key; Pi's provider block references an environment variable instead.
   */
  configDir?: {
    envVar: string
    files: GridConfigFile[]
    /**
     * Point [envVar] at ONE of the written files rather than at the directory holding them.
     *
     * Pi wants the directory (`PI_CODING_AGENT_DIR`); OpenCode's `OPENCODE_CONFIG` wants a config
     * file. Same mechanism — a private directory this daemon owns — differing only in what the
     * engine is handed, so it is a field rather than a second writer.
     */
    pointAt?: string
  }
}

interface GridEngineContract {
  build: (override: GridLaunchOverride) => GridEngineLaunch
  /** The engine cannot start against a grid without being told which model to ask for. */
  requiresModel?: boolean
}

/**
 * The variable an engine is told to read the key from, where the engine supports that indirection.
 *
 * Codex names it in `env_key`; Pi's `models.json` writes it as a `$VAR` reference. Both exist so the
 * credential can stay in the environment while the configuration that points at it is not secret.
 */
const GRID_KEY_VAR = 'GRID_API_KEY'

/** The provider id our generated config declares. Pi selects it as `--model <id>/<model>`. */
const GRID_PROVIDER_ID = 'grid'

/**
 * Every variable any contract in this file uses to point an engine somewhere.
 *
 * A grid launch has to CLEAR the ones it does not itself set, because setting the right variable is
 * not enough to decide where an engine goes: an engine picks a provider from whatever credentials it
 * can see, and a stray one wins on its own terms. Measured, twice, on one machine:
 *
 *  * OpenCode, handed `OPENAI_BASE_URL` for a grid, found an inherited `ANTHROPIC_API_KEY` and chose
 *    Claude Sonnet at api.anthropic.com — reporting `invalid x-api-key`, a sentence that names
 *    neither the grid nor the variable that redirected it.
 *  * Claude Code, on the same machine, had its `ANTHROPIC_BASE_URL` deleted by a line in `.zshrc` and
 *    fell back to the same key, with the same unreadable result.
 *
 * The inherited value arrives from further away than a user can reasonably audit. On that machine it
 * came from `.zshrc`, and then — after that was fixed — from a VS Code setting
 * (`claudeCode.environmentVariables`) that seeded the terminal the desktop app was launched from,
 * whose environment the app passed to the daemon, which passed it to the tmux server, which gave it
 * to every pane. Four layers, none visible from the failure.
 *
 * So the launch is the place to settle it: it is the only point that knows the user asked for a grid.
 * Unset here is scoped to the engine's own process and touches nothing on disk — a plain terminal on
 * the same machine keeps every variable it had.
 *
 * The list is deliberately OUR OWN vars rather than a survey of every provider an engine supports.
 * Enumerating those is unbounded and would go stale silently; these are the ones this file uses, so
 * this file can be right about them.
 */
export const GRID_CONFLICTING_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'XAI_API_KEY',
  'GROK_MODELS_BASE_URL',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_MODEL',
  'HERMES_INFERENCE_MODEL',
  GRID_KEY_VAR,
  GRID_MCP_AUTH_VAR,
  HERMES_MANAGED_DIR_VAR,
]

/**
 * The variables this launch must clear: everything in [GRID_CONFLICTING_ENV_VARS] the launch does not
 * itself set.
 *
 * Set-then-unset would be a bug, so the two sets are computed from one another rather than listed
 * twice — a contract that gains a variable stops clearing it in the same edit.
 */
export function gridConflictingEnvToClear(launch: GridEngineLaunch): string[] {
  const provided = new Set(Object.keys(launch.env))
  if (launch.configDir) provided.add(launch.configDir.envVar)
  return GRID_CONFLICTING_ENV_VARS.filter((name) => !provided.has(name))
}


/**
 * Pi's provider block, as the Grid app shipped and unit-tested it
 * (`autonomous-grid-app`, `pi_grid_config.dart` at 36d00c95, before Pi was dropped from that app for
 * reasons about ITS chat UI — a fourth agent nobody reached for, and a 180 MB private Node
 * toolchain — none of which apply here, where the user installs Pi themselves).
 *
 * `api: openai-completions` makes Pi post to `<base>/chat/completions`, which is what the relay
 * serves. The context/cost numbers are Pi's own bookkeeping for its display; the grid decides what
 * the model really takes.
 */
function piModelsJson(baseUrl: string, model: string): string {
  return JSON.stringify({
    providers: {
      [GRID_PROVIDER_ID]: {
        name: 'Autonomous Grid',
        baseUrl,
        api: 'openai-completions',
        // An env reference, not the key — nothing secret is written to disk.
        apiKey: `$${GRID_KEY_VAR}`,
        models: [{
          id: model,
          name: model,
          reasoning: false,
          input: ['text'],
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)
}

/**
 * Pi's settings for the directory we own, which exists to hand back the one thing the redirection
 * takes away: the skills the user keeps in their real `~/.pi/agent/skills`.
 *
 * Deliberately NOT `defaultProjectTrust: always`. The Grid app set it because it drove Pi headless,
 * one process per turn, with nobody there to answer a prompt. Here the user is sitting in front of
 * an interactive pane, and silently pre-trusting every folder they open an agent in would be this
 * daemon deciding something it was not asked to decide.
 */
function piSettingsJson(userSkillsDir: string): string {
  return JSON.stringify({ skills: [userSkillsDir] }, null, 2)
}

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
        // Only when there are web tools to reach: the variable exists to be referenced by the config
        // below, and setting it otherwise would leave a key in the pane that nothing reads.
        ...(override.mcpUrl ? { [GRID_KEY_VAR]: override.apiKey } : {}),
      },
      args: override.mcpUrl ? ['--mcp-config', claudeMcpConfig(override.mcpUrl, GRID_KEY_VAR)] : [],
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
      env: {
        [GRID_KEY_VAR]: override.apiKey,
        ...(override.mcpUrl ? { [GRID_MCP_AUTH_VAR]: mcpAuthorizationHeader(override.apiKey) } : {}),
      },
      args: [
        '-c', 'model_provider="grid"',
        '-c', 'model_providers.grid.name="Autonomous Grid"',
        '-c', `model_providers.grid.base_url="${relayBaseUrl(override.baseUrl)}"`,
        '-c', `model_providers.grid.env_key="${GRID_KEY_VAR}"`,
        // Mandatory: Codex speaks the Responses dialect and rejects `wire_api = "chat"`.
        '-c', 'model_providers.grid.wire_api="responses"',
        // The relay streams HTTP SSE, not WebSocket.
        '-c', 'model_providers.grid.supports_websockets=false',
        ...(override.mcpUrl ? codexMcpArgs(override.mcpUrl) : []),
        ...(override.model ? ['-m', override.model] : []),
      ],
    }),
  },

  // opencode's simplest documented custom provider: the OpenAI-compatible pair
  // (https://opencode.ai/docs/providers). The model is left to the app — its `--model` wants a
  // `provider/model` pair whose provider id is not documented for the env-var route, and inventing
  // one would send it looking for a model that does not exist.
  // OpenCode is the one engine here that an endpoint variable alone cannot steer, and the reason is
  // worth stating because `OPENAI_BASE_URL` looks like it should be enough — the grid CLI's own
  // `grid info --env` exports exactly that pair, and it is enough for hermes.
  //
  // OpenCode's `openai` provider carries a COMPILED-IN model catalogue (49 entries: gpt-4o,
  // gpt-5.6-terra-pro, …). It sends requests to `OPENAI_BASE_URL` but never asks that endpoint what
  // it serves, so pointing it at a grid gives an engine that will only ever name models the grid has
  // never heard of. Measured: it selected `gpt-5.6-terra-pro` and the relay answered
  //
  //   503 · No providers available for this model. This grid serves: DeepSeek-V4-Flash-0731, …
  //
  // and `-m openai/DeepSeek-V4-Flash-0731` — naming a real grid model under its built-in provider —
  // made OpenCode's own server throw instead.
  //
  // So it takes the shape codex and pi take: DECLARE a provider. `OPENCODE_CONFIG` names a config
  // file, this daemon writes one into a directory it owns, and the grid arrives as a provider whose
  // models are the grid's own ids. The user's `~/.config/opencode/opencode.json` is never opened.
  opencode: {
    build: (override) => {
      const provider = gridProviderId(override.networkName)
      // No model chosen means the grid routes — `Auto` is the router's own id, and the relay serves
      // it (verified: 200). It is a real id to OpenCode either way, which is what matters: the
      // provider block has to name something, and leaving the model out entirely puts OpenCode back
      // on its own catalogue and the 503 above.
      const model = override.model ?? GRID_ROUTER_MODEL
      return {
        // The key travels in the environment and is REFERENCED from the file, never written into it
        // — the rule every config-file engine here follows.
        env: { [GRID_KEY_VAR]: override.apiKey },
        // Deliberately NOT `OPENAI_BASE_URL`/`OPENAI_API_KEY`. Setting them would re-arm the built-in
        // `openai` provider beside ours, and its catalogue is what chose the model the grid refused.
        args: ['-m', `${provider}/${model}`],
        configDir: {
          envVar: 'OPENCODE_CONFIG',
          pointAt: OPENCODE_CONFIG_FILE,
          files: [{
            name: OPENCODE_CONFIG_FILE,
            content: opencodeGridConfig(provider, override, model),
          }],
        },
      }
    },
  },

  // Nous Research's documented trio for a custom OpenAI-compatible endpoint
  // (hermes-agent/website/docs/reference/environment-variables.md) — plus the model on the command
  // line, which is the only place hermes reads it from in the mode this daemon actually launches.
  //
  // `HERMES_INFERENCE_MODEL` is read by `hermes -z` and by the gateway behind `hermes --tui`. The
  // pane opened here is neither: it is the INTERACTIVE CLI, whose model resolution is `-m` then
  // config.yaml and no env tier at all (`cli.py:_init_model_and_provider`, "Priority: CLI args >
  // env vars > config file" — the env half is about the provider). And a grid move relaunches as
  // `hermes --resume <id>`, which restores the model stored on the session row unless argv carried
  // an explicit `-m`; that flag is the documented opt-out ("resume must not clobber an explicit -m
  // with the session's stored model", `cli.py` / `cli_model_switch_mixin.py`).
  //
  // Measured on 2026-09-08 before this line existed: the pane's environment said
  // `HERMES_INFERENCE_MODEL=GLM-4.7-Flash` — which is what the desktop's model pill read back and
  // printed — while hermes itself ran DeepSeek-V4-Flash-0731, the default in the user's own
  // ~/.hermes/config.yaml and the model persisted on the resumed session's row.
  //
  // The variable stays beside the flag: `-z`/`--tui` read it, and it is how `gridAssignment.ts`
  // answers "which model is this agent on" for hermes without parsing a live process's argv.
  //
  // ⚠️ The ENDPOINT has no such flag. Hermes's custom-provider resolver deliberately ignores
  // `OPENAI_BASE_URL` ("config.yaml is the single source of truth for endpoint URLs",
  // `runtime_provider_backends.py`) and the CLI exposes no `--base-url`, so moving a hermes agent
  // between grids moves its model but leaves its requests on whatever relay config.yaml names. The
  // only lever left is `HERMES_HOME`, which would take state.db and the user's skills with it and
  // break the resume this move depends on.
  hermes: {
    build: (override) => ({
      env: {
        OPENAI_BASE_URL: relayBaseUrl(override.baseUrl),
        OPENAI_API_KEY: override.apiKey,
        ...(override.model ? { HERMES_INFERENCE_MODEL: override.model } : {}),
        // Referenced by the overlay below, so it exists only when there is an overlay to read it.
        ...(override.mcpUrl ? { [GRID_KEY_VAR]: override.apiKey } : {}),
      },
      args: override.model ? ['-m', override.model] : [],
      // Hermes reads its MCP servers from one config file and takes no flag for them, so the web
      // tools arrive as a managed-scope overlay merged over the user's own — see `gridWebMcp.ts`,
      // including why this is `HERMES_MANAGED_DIR` and not `HERMES_HOME`.
      ...(override.mcpUrl
        ? {
          configDir: {
            envVar: HERMES_MANAGED_DIR_VAR,
            files: [{
              name: HERMES_MANAGED_CONFIG_FILE,
              content: hermesManagedConfig(override.mcpUrl, GRID_KEY_VAR),
            }],
          },
        }
        : {}),
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

  // Pi reads its providers out of a config DIRECTORY, and `PI_CODING_AGENT_DIR` moves that
  // directory. So it gets a private one per agent: the provider block lands there, the user's
  // ~/.pi/agent/models.json is never opened, and their skills are handed back through settings.json.
  //
  // The provider block has to name the model it serves, and Pi selects it as `grid/<model>` — so
  // something must always be named. No model chosen means the grid routes: `Auto` is the router's
  // own id and the relay answers it like any other, exactly as OpenCode's block above relies on.
  //
  // This used to be `requiresModel: true`, which refused the launch outright. That made Pi the one
  // grid-capable engine a person could not start from the New agent dialog at all, since the dialog
  // always creates on Auto and no longer offers a model field — a dead end, not a prompt to go and
  // pick something.
  pi: {
    build: (override) => {
      const model = override.model ?? GRID_ROUTER_MODEL
      return {
        env: { [GRID_KEY_VAR]: override.apiKey },
        args: ['--model', `${GRID_PROVIDER_ID}/${model}`],
        configDir: {
          envVar: 'PI_CODING_AGENT_DIR',
          files: [
            { name: 'models.json', content: piModelsJson(relayBaseUrl(override.baseUrl), model) },
            { name: 'settings.json', content: piSettingsJson(userPiSkillsDir()) },
          ],
        },
      }
    },
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
  // NOTE: pi is NOT here — it is supported through a private config directory. Kilo is, because its
  // CLI has no OpenAI-compatible provider to configure at all, in any directory.
  cursor: 'Cursor Agent can only be re-pointed at another Cursor API (CURSOR_API_ENDPOINT), '
    + 'not at an OpenAI-compatible relay',
  agy: 'Antigravity speaks the Gemini API, which this relay does not serve',
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

/** A placeholder override, used only to ask a contract which variables it sets. Never launched. */
const PROBE_OVERRIDE: GridLaunchOverride = {
  networkId: 'probe',
  networkName: 'probe',
  baseUrl: 'https://example.invalid/probe/relay/v1',
  apiKey: 'probe',
  model: 'probe',
  // Present so the probe reports the variables a launch WITH web tools sets. Retarget clears what
  // this answers, and a probe that left them out would move an agent to another grid while its old
  // grid's MCP credential stayed in the pane — the exact staleness the doc comment below warns of.
  mcpUrl: 'https://example.invalid/v1/grid/web-mcp/',
}

/**
 * Which environment variables pointing [engine] at a grid sets.
 *
 * Asked of the contract by building one, rather than kept as a second list beside it. A hand-written
 * list would be correct exactly until an engine's contract gained a variable, and the symptom of it
 * being stale is the worst kind: an agent moved back to its own login that quietly keeps talking to
 * the grid, reporting success the whole way.
 *
 * Empty for an engine that has no contract — there is nothing to clear because nothing was set.
 */
export function gridEnvVarNames(engine: AgentEngine): string[] {
  const built = buildGridEngineLaunch(engine, PROBE_OVERRIDE)
  if (!built.ok) return []
  const names = Object.keys(built.launch.env)
  if (built.launch.configDir) names.push(built.launch.configDir.envVar)
  return names
}
