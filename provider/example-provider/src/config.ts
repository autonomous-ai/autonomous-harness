/**
 * Configuration: the agent list, and how to reach the `claude` binary.
 *
 * The agent list is the ONLY per-deployment state. Each entry becomes an `agent.list` entry
 * and carries the working directory `claude` is spawned in.
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
  /** Passed to `--model`. Never taken from the wire: model selection is out of scope (spec §9). */
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
  const agentsFile = process.env.AGENTS_FILE ?? resolve(process.cwd(), 'agents.json')
  const workspaceRoot = realpathSync(resolve(process.env.WORKSPACE_ROOT ?? '/tmp/example-provider-scratch'))
  return {
    agents: loadAgents(agentsFile),
    workspaceRoot,
    agentsFile,
    claudeBin: resolveClaudeBin(process.env.CLAUDE_PATH),
    model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    port: Number(process.env.PORT ?? 4502),
    stateFile: process.env.STATE_FILE ?? resolve(process.cwd(), 'sessions.json'),
    claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ?? `${homedir()}/.claude/projects`,
    recapModel: process.env.CLAUDE_RECAP_MODEL || DEFAULT_RECAP_MODEL,
    recapDisabled: process.env.RECAP_DISABLED === '1',
  }
}
