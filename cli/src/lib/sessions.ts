/**
 * Session discovery + raw tail reads over the Claude projects directory.
 *
 * Phase 1 is deliberately raw: we do not parse transcripts into rich events. We
 * only enumerate session files and read their raw lines.
 */

import { readdir, readFile, stat, open } from 'fs/promises'
import { join } from 'path'
import { env } from '../config/env.js'
import { isSessionFile, isCodexPath, sessionIdFromFile } from './paths.js'

export interface SessionMeta {
  sessionId: string
  /** Absolute path to the session's .jsonl file. */
  filePath: string
  /** The mangled project dir name (parent folder). */
  projectDir: string
  /** Real working directory, read from the JSONL `cwd` field (best effort). */
  cwd: string | null
  gitBranch: string | null
  /** File mtime in epoch ms — used to order newest → oldest. */
  updatedAt: number
  sizeBytes: number
}

const ROOT = env.CLAUDE_PROJECTS_DIR

/** Pull `cwd` / `gitBranch` from the first line of a session file (best effort). */
async function readFirstLineMeta(
  filePath: string
): Promise<{ cwd: string | null; gitBranch: string | null }> {
  try {
    // Read a small prefix; the first JSON line is well under 64 KiB.
    const fh = await open(filePath, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const chunk = buf.subarray(0, bytesRead).toString('utf-8')
      const nl = chunk.indexOf('\n')
      const firstLine = nl === -1 ? chunk : chunk.slice(0, nl)
      const obj = JSON.parse(firstLine) as Record<string, unknown>
      return {
        cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
        gitBranch: typeof obj.gitBranch === 'string' ? obj.gitBranch : null,
      }
    } finally {
      await fh.close()
    }
  } catch {
    return { cwd: null, gitBranch: null }
  }
}

/** List every Claude session across all project dirs, newest → oldest. */
export async function listSessions(): Promise<SessionMeta[]> {
  let projectDirs: string[]
  try {
    const entries = await readdir(ROOT, { withFileTypes: true })
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }

  const sessions: SessionMeta[] = []

  for (const dir of projectDirs) {
    const dirPath = join(ROOT, dir)
    let files: string[]
    try {
      files = await readdir(dirPath)
    } catch {
      continue
    }

    for (const name of files) {
      const filePath = join(dirPath, name)
      if (!isSessionFile(filePath) || isCodexPath(filePath)) continue

      let st
      try {
        st = await stat(filePath)
      } catch {
        continue
      }
      if (!st.isFile() || st.size === 0) continue

      const { cwd, gitBranch } = await readFirstLineMeta(filePath)
      sessions.push({
        sessionId: sessionIdFromFile(filePath),
        filePath,
        projectDir: dir,
        cwd,
        gitBranch,
        updatedAt: st.mtimeMs,
        sizeBytes: st.size,
      })
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

/** Resolve a sessionId to its absolute .jsonl path (searches all project dirs). */
export async function resolveSessionFile(sessionId: string): Promise<string | null> {
  // Hardening: this value can originate from a remote web/device request. A bare session id only ever
  // contains [A-Za-z0-9._-]; reject anything with a path separator or `..` so it can never build a
  // path outside a project dir (e.g. `../../../../etc/x` → reading arbitrary *.jsonl on the computer).
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) return null
  let projectDirs: string[]
  try {
    const entries = await readdir(ROOT, { withFileTypes: true })
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return null
  }
  for (const dir of projectDirs) {
    const candidate = join(ROOT, dir, `${sessionId}.jsonl`)
    try {
      const st = await stat(candidate)
      if (st.isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

/** Return the last `n` non-empty raw lines of a specific transcript file. Prefer this over
 *  `tailLines` when the caller already holds a trusted, registered `transcriptPath` — it takes no
 *  request-controlled id, so there is no path to traverse. */
export async function tailFile(filePath: string, n = 200): Promise<string[]> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    return lines.slice(-n)
  } catch {
    return []
  }
}

/** Return the last `n` raw lines of a session file, resolved from a sessionId (guarded — see
 *  `resolveSessionFile`). Only reads files under CLAUDE_PROJECTS_DIR. */
export async function tailLines(sessionId: string, n = 200): Promise<string[]> {
  const filePath = await resolveSessionFile(sessionId)
  if (!filePath) return []
  return tailFile(filePath, n)
}
