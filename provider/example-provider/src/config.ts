/**
 * Configuration: the agent list, which LLM to talk to, and how to reach the `claude` binary.
 *
 * Two kinds of per-deployment state, both kept out of source: `agents.json` (which directories the
 * agents own) and `.env` (which model answers, and with whose credential).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { DEFAULT_RECAP_MODEL } from './recap.js'

export interface AgentEntry {
  id: string
  name: string
  description: string
  /** Absolute directory `claude` runs in. Also the key to this agent's transcripts on disk. */
  cwd: string
}

/**
 * Credentials for the endpoint `claude` talks to, when one is configured.
 *
 * These are the CLI's own environment variables, so pointing it at a different LLM needs no code: any
 * Anthropic-compatible gateway works. `machine-manager` does exactly this to route managed nodes
 * through CCR (`resolveManagedAnthropicEnv` in its `lib/docker.ts`).
 */
export interface AnthropicEnv {
  baseUrl: string
  authToken: string
  model: string
  /** The CLI's own small-model slot; used for the recap one-shot. */
  smallFastModel?: string
}

export interface Config {
  agents: AgentEntry[]
  /**
   * Where `agent.create` puts a new agent's directory.
   *
   * Deliberately its own setting rather than "the parent of the first agent": creating an agent is a
   * write, and a write needs a root it cannot escape. Everything created lands under here.
   */
  workspaceRoot: string
  /** Path to agents.json, so a created agent survives a restart. */
  agentsFile: string
  claudeBin: string
  /**
   * The endpoint and credential `claude` runs against, or undefined to use its own local login.
   *
   * Merged into the environment at BOTH spawn sites (`claude.ts`, `recap.ts`) rather than left in
   * this process's env, so the credential path is visible from the spawn and a test that builds a
   * Config without one genuinely gets none instead of inheriting the developer's shell.
   */
  anthropic?: AnthropicEnv
  /** Passed to `--model`. Never taken from the wire: model selection is out of scope. */
  model: string
  port: number
  /** Where sessions.json lives. */
  stateFile: string
  claudeProjectsDir: string
  /** Model for the per-turn recap one-shot — a headline is not the work, so it gets a small model. */
  recapModel: string
  /** Skip the recap one-shot and excerpt the turn instead. Keeps the example cheap to run. */
  recapDisabled: boolean
}

/**
 * The model this example runs on.
 *
 * Pinned rather than left to the CLI default, because the whole point of the profile is that a
 * PROVIDER owns its model choice — Autonomous never sends one (spec §9), so if this were unset the
 * example would silently inherit whatever the local CLI happened to be configured with, and two
 * machines would behave differently for reasons nobody could see. Override with CLAUDE_MODEL.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5'

/**
 * Credentials from the environment, or undefined when none are configured.
 *
 * ALL-OR-NOTHING, and it throws rather than shipping a half-configured provider. `machine-manager`
 * learned this the same way ("partial config ⇒ treated as unset, so we never ship a half-configured
 * node that fails auth"), and the model is part of the set for a reason specific to this case: a
 * custom gateway does not serve `claude-sonnet-5`, so a base URL carrying the default model is a
 * guaranteed failure on the first turn — which is far worse than a failure at startup, because by
 * then a user is watching.
 */
export function resolveAnthropicEnv(source: NodeJS.ProcessEnv = process.env): AnthropicEnv | undefined {
  const baseUrl = source.ANTHROPIC_BASE_URL?.trim()
  // Either name works: the CLI accepts both, and which one a gateway hands out is its own business.
  const authToken = (source.ANTHROPIC_AUTH_TOKEN || source.ANTHROPIC_API_KEY)?.trim()
  const model = source.ANTHROPIC_MODEL?.trim()
  const smallFastModel = source.ANTHROPIC_SMALL_FAST_MODEL?.trim()

  // Nothing set at all is a legitimate configuration — the CLI then uses whatever it is logged into.
  if (!baseUrl && !authToken && !model) return undefined

  const missing = [
    baseUrl ? '' : 'ANTHROPIC_BASE_URL',
    authToken ? '' : 'ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY)',
    model ? '' : 'ANTHROPIC_MODEL',
  ].filter(Boolean)
  if (missing.length) {
    throw new Error(
      `incomplete Anthropic configuration — missing ${missing.join(', ')}.\n` +
        `Set all three in .env (see .env.example), or none of them to use the local \`claude\` login.`,
    )
  }

  return { baseUrl: baseUrl!, authToken: authToken!, model: model!, ...(smallFastModel ? { smallFastModel } : {}) }
}

/**
 * The credential set as the CLI's own environment variables.
 *
 * The one place the mapping from our config shape to the CLI's variable names lives — both spawn
 * sites call this, so neither can drift from the other.
 */
export function anthropicSpawnEnv(anthropic?: AnthropicEnv): Record<string, string> {
  if (!anthropic) return {}
  return {
    ANTHROPIC_BASE_URL: anthropic.baseUrl,
    ANTHROPIC_AUTH_TOKEN: anthropic.authToken,
    ANTHROPIC_MODEL: anthropic.model,
    ...(anthropic.smallFastModel ? { ANTHROPIC_SMALL_FAST_MODEL: anthropic.smallFastModel } : {}),
  }
}

/**
 * Read `.env` into `process.env`, if there is one.
 *
 * `process.loadEnvFile` rather than a dependency: it is the platform's own parser, so this package
 * keeps its zero-runtime-dependency property and inherits correct handling of quoting and comments.
 * A variable already set in the real environment WINS over the file — which is the precedence you
 * want, since it lets one-off runs override the checked-in defaults without editing anything.
 */
export function loadEnvFile(file: string): void {
  if (!existsSync(file)) return
  process.loadEnvFile(file)
}

/** Agent ids are interpolated into paths and compared against wire input — keep them boring. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function loadAgents(file: string): AgentEntry[] {
  if (!existsSync(file)) {
    throw new Error(
      `agents file not found: ${file}\n` +
        `Copy agents.example.json to agents.json and point it at a directory you are happy for an ` +
        `agent to modify — see the warning in README.md.`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${file} must be a non-empty array of agents`)
  }

  const seen = new Set<string>()
  return raw.map((entry, i) => {
    const e = entry as Partial<AgentEntry>
    const where = `${file}[${i}]`
    if (!e.id || !ID_RE.test(e.id)) throw new Error(`${where}: id must match ${ID_RE} (got ${JSON.stringify(e.id)})`)
    if (seen.has(e.id)) throw new Error(`${where}: duplicate id "${e.id}"`)
    seen.add(e.id)
    if (!e.name?.trim()) throw new Error(`${where}: name is required — it is shown to the user`)
    if (!e.cwd || !isAbsolute(e.cwd)) throw new Error(`${where}: cwd must be an absolute path`)
    // Fail at load, not at the first turn: a bad cwd would otherwise surface as a mysterious agent
    // failure minutes later, which is exactly the failure mode this provider exists to avoid.
    if (!existsSync(e.cwd) || !statSync(e.cwd).isDirectory()) {
      throw new Error(`${where}: cwd does not exist or is not a directory: ${e.cwd}`)
    }
    // RESOLVE SYMLINKS. Claude records the fully-resolved path, and the transcript directory name is
    // derived from it — on macOS `/tmp` is a symlink to `/private/tmp`, so a configured `/tmp/x`
    // would look for `-tmp-x` while Claude wrote `-private-tmp-x`, and every history read would come
    // back empty. The conformance suite caught exactly this.
    return { id: e.id, name: e.name.trim(), description: e.description?.trim() ?? '', cwd: realpathSync(resolve(e.cwd)) }
  })
}

/**
 * Resolve the `claude` binary. `which` first, then the usual install locations — the same problem
 * `brain` solves with `resolveClaudeExecutablePath`, kept deliberately simpler here.
 */
export function resolveClaudeBin(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CLAUDE_PATH points at a file that does not exist: ${explicit}`)
    return explicit
  }
  try {
    const found = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim().split('\n')[0]
    if (found && existsSync(found)) return found
  } catch { /* fall through to the well-known locations */ }

  for (const candidate of [
    `${homedir()}/.local/bin/claude`,
    `${homedir()}/.claude/local/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('could not find the `claude` binary — install it, or set CLAUDE_PATH')
}

export function loadConfig(): Config {
  // Before anything reads process.env — every setting below may come from the file.
  loadEnvFile(process.env.ENV_FILE ?? resolve(process.cwd(), '.env'))

  const agentsFile = process.env.AGENTS_FILE ?? resolve(process.cwd(), 'agents.json')
  const workspaceRoot = realpathSync(resolve(process.env.WORKSPACE_ROOT ?? '/tmp/example-provider-scratch'))
  const anthropic = resolveAnthropicEnv()
  return {
    agents: loadAgents(agentsFile),
    workspaceRoot,
    agentsFile,
    claudeBin: resolveClaudeBin(process.env.CLAUDE_PATH),
    ...(anthropic ? { anthropic } : {}),
    // ONE source for the model, so the `--model` flag and the CLI's own ANTHROPIC_MODEL can never
    // name two different models — a disagreement that would be invisible until a turn failed.
    model: anthropic?.model || process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    port: Number(process.env.PORT ?? 4502),
    stateFile: process.env.STATE_FILE ?? resolve(process.cwd(), 'sessions.json'),
    claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ?? `${homedir()}/.claude/projects`,
    recapModel: anthropic?.smallFastModel || process.env.CLAUDE_RECAP_MODEL || DEFAULT_RECAP_MODEL,
    recapDisabled: process.env.RECAP_DISABLED === '1',
  }
}
