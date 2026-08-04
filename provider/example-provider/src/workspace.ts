/**
 * `workspace-write` — creating and removing agents (HP-301).
 *
 * An agent here IS a directory. Creating one therefore means writing to disk, so the only rule that
 * really matters is the containment check: everything lands under `workspaceRoot` and nothing may
 * escape it, however the name is spelled.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { AgentEntry, Config } from './config.js'

export class WorkspaceError extends Error {}

/** Names arrive off the wire, so the id is derived rather than trusted. */
export function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  if (!slug) throw new WorkspaceError('name must contain at least one letter or digit')
  return slug
}

/** Resolve a new agent directory inside the root, or refuse. */
function containedDir(root: string, slug: string): string {
  const target = resolve(root, slug)
  const inside = relative(root, target)
  if (!inside || inside.startsWith('..') || resolve(root, inside) !== target) {
    throw new WorkspaceError('that name resolves outside the workspace root')
  }
  return target
}

export function createProject(config: Config, name: string, description = ''): AgentEntry {
  const trimmed = name.trim()
  if (!trimmed) throw new WorkspaceError('name is required')
  const id = slugify(trimmed)
  if (config.agents.some((a) => a.id === id)) throw new WorkspaceError(`an agent named "${trimmed}" already exists`)

  const cwd = containedDir(config.workspaceRoot, id)
  mkdirSync(cwd, { recursive: true })

  const entry: AgentEntry = { id, name: trimmed, description: description.trim(), cwd }
  config.agents.push(entry)
  persist(config)
  return entry
}

export function deleteProject(config: Config, id: string): void {
  const index = config.agents.findIndex((a) => a.id === id)
  if (index === -1) throw new WorkspaceError('unknown agent')
  const [removed] = config.agents.splice(index, 1)
  persist(config)
  // The DIRECTORY is left alone on purpose. Removing an agent from the list is reversible; deleting
  // whatever work it produced is not, and an example provider is the last place to be destructive.
  void removed
}

export function renameProject(config: Config, id: string, name: string): AgentEntry {
  const entry = config.agents.find((a) => a.id === id)
  if (!entry) throw new WorkspaceError('unknown agent')
  const trimmed = name.trim()
  if (!trimmed) throw new WorkspaceError('name is required')
  entry.name = trimmed
  persist(config)
  return entry
}

/** Write-then-rename: a crash mid-write must not leave a truncated agents.json. */
function persist(config: Config): void {
  const rows = config.agents.map(({ id, name, description, cwd }) => ({ id, name, description, cwd }))
  const tmp = `${config.agentsFile}.tmp`
  writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`)
  renameSync(tmp, config.agentsFile)
}

/** Used by the tests to read back what was persisted. */
export function readAgentsFile(config: Config): unknown {
  return existsSync(config.agentsFile) ? JSON.parse(readFileSync(config.agentsFile, 'utf8')) : null
}

export const __testing = { containedDir, rmSync }
