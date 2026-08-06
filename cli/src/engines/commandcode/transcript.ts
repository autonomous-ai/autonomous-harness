import { join } from 'path'
import { env } from '../../config/env.js'

/**
 * Command Code lays its transcripts out deterministically:
 *
 *   <COMMANDCODE_HOME>/projects/<cwd slug>/<sessionId>.jsonl
 *
 * where the slug is the working directory lowercased with every run of non-alphanumerics collapsed to a
 * dash ("/Users/me/Working/Tmux/Agent-6" → "users-me-working-tmux-agent-6", and "/Users/me/.harness/cli"
 * → "users-me-machine-cli").
 *
 * Deriving it matters because the CLI fires SessionStart BEFORE the file exists, and a path that is not on
 * disk fails the registry's realpath check — so the path used to arrive only with the first Stop hook, i.e.
 * AFTER the first turn. Nothing tailed the transcript for that turn, which is the only signal Command Code
 * has that a message was accepted, so the first message of every new session reported "the agent did not
 * accept this message" and produced no recap.
 */
export function commandcodeProjectSlug(cwd: string): string {
  return cwd.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** null when there is not enough to build a path, or when either part could escape the projects root. */
export function commandcodeTranscriptPath(cwd: string | null | undefined, sessionId: string): string | null {
  if (!cwd || !sessionId) return null
  // The session id becomes a FILENAME, so anything that could climb out of the directory disqualifies it.
  // Command Code uses uuids; this is here so a malformed hook payload cannot point the watcher elsewhere.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') return null
  const slug = commandcodeProjectSlug(cwd)
  if (!slug) return null
  return join(env.COMMANDCODE_HOME, 'projects', slug, `${sessionId}.jsonl`)
}
