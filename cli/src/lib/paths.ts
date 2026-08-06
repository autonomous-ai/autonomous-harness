/**
 * Path helpers for locating Claude Code session JSONL files.
 *
 * Layout on disk (written by the local `claude` CLI):
 *   {CLAUDE_PROJECTS_DIR}/<mangled-workdir>/<sessionId>.jsonl
 *
 * The `<mangled-workdir>` is the absolute project dir with every non-alphanumeric
 * character replaced by `-`. It is lossy (not reversible), so we derive the real
 * working directory from the `cwd` field carried on the JSONL lines instead.
 *
 * This module is intentionally self-contained — machine-adapter does not import from
 * anything outside this package.
 */

import { basename } from 'path'

/** True for a session JSONL we want to surface (excludes subagent mirrors). */
export function isSessionFile(filePath: string): boolean {
  const name = basename(filePath)
  return name.endsWith('.jsonl') && !name.startsWith('agent-')
}

/** True for a path inside a `.codex/` engine subdir (skipped for now). */
export function isCodexPath(filePath: string): boolean {
  return filePath.includes('/.codex/') || filePath.includes('\\.codex\\')
}

/** The sessionId is the JSONL filename without its extension. */
export function sessionIdFromFile(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/, '')
}
