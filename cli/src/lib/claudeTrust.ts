/**
 * Claude Code asks "do you trust this folder?" the first time it opens a project. For a workspace
 * Harness itself just made — a fresh `~/harnesses/harness-N`, or a harness template it laid out —
 * the answer is the one the person already gave by clicking Create, so the daemon records it the
 * way Claude Code does: `projects[<path>].hasTrustDialogAccepted` in `~/.claude.json`.
 *
 * Only ever ADDS trust for a folder the daemon created; never touches a folder the person chose
 * themselves, never removes anything, and does nothing when Claude Code has never run here (no
 * `~/.claude.json`), when the file does not parse, or when the entry already says yes.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function preTrustClaudeProject(cwd: string, home = homedir()): 'trusted' | 'already' | 'skipped' {
  const file = join(home, '.claude.json')
  if (!existsSync(file)) return 'skipped'
  let config: Record<string, unknown>
  try {
    config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return 'skipped'
  }
  if (!config || typeof config !== 'object') return 'skipped'
  const projects = (config.projects && typeof config.projects === 'object' ? config.projects : {}) as Record<string, Record<string, unknown>>
  const existing = projects[cwd]
  if (existing?.hasTrustDialogAccepted === true) return 'already'
  projects[cwd] = { allowedTools: [], ...(existing ?? {}), hasTrustDialogAccepted: true }
  config.projects = projects
  const tmp = `${file}.harness-${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  return 'trusted'
}

/**
 * Codex keeps the same answer in `~/.codex/config.toml` as a `[projects."<path>"]` table with
 * `trust_level = "trusted"`. Same rules: only a folder the daemon made, only when Codex has a
 * config here, never rewriting what is there — the table is appended at the end.
 */
export function preTrustCodexProject(cwd: string, home = homedir()): 'trusted' | 'already' | 'skipped' {
  const file = join(home, '.codex', 'config.toml')
  if (!existsSync(file)) return 'skipped'
  const text = readFileSync(file, 'utf8')
  const header = `[projects.${JSON.stringify(cwd)}]`
  if (text.includes(header)) return 'already'
  const tmp = `${file}.harness-${process.pid}.tmp`
  writeFileSync(tmp, `${text.replace(/\s*$/, '')}\n\n${header}\ntrust_level = "trusted"\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return 'trusted'
}
