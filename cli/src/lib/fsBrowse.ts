import { readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, resolve, sep } from 'path'
import { env } from '../config/env.js'

export interface DirEntry { name: string; isDir: true }
export interface ListDirResult { path: string; entries: DirEntry[]; truncated: boolean }
export type ListDirError = { error: 'INVALID_PATH' | 'NOT_FOUND' | 'NOT_A_DIRECTORY' | 'FORBIDDEN' | 'PERMISSION_DENIED' }

// A giant directory (e.g. someone browsing to `/`) must not produce an unbounded reply — nothing
// upstream (backend relay, hub) caps non-terminal frame size, so this is the only bound in the path.
const MAX_ENTRIES = 2_000

/** Restrict browsing to under the user's home directory by default — the machine a user runs
 *  `harness` on is "theirs", but a fat-fingered path (or a compromised relay hop) walking arbitrary
 *  system directories is still worth guarding against. Same opt-out convention as CLAUDE_PATH etc. */
function isAllowed(path: string): boolean {
  if (env.HARNESS_FS_BROWSE_UNRESTRICTED === '1') return true
  const home = resolve(homedir())
  return path === home || path.startsWith(home + sep)
}

/** One-level directory listing (folders only) rooted at `path`, or `homedir()` when omitted. */
export function listDir(path: string): ListDirResult | ListDirError {
  const target = path || homedir()
  if (!isAbsolute(target)) return { error: 'INVALID_PATH' }
  const resolved = resolve(target)
  if (!isAllowed(resolved)) return { error: 'FORBIDDEN' }

  let st
  try {
    st = statSync(resolved)
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'PERMISSION_DENIED' : 'NOT_FOUND' }
  }
  if (!st.isDirectory()) return { error: 'NOT_A_DIRECTORY' }

  let raw
  try {
    raw = readdirSync(resolved, { withFileTypes: true })
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'PERMISSION_DENIED' : 'NOT_FOUND' }
  }

  const dirs: DirEntry[] = []
  for (const d of raw) {
    if (d.name.startsWith('.')) continue // hidden — same convention as files.ts's isHidden
    if (d.isDirectory()) dirs.push({ name: d.name, isDir: true })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  const truncated = dirs.length > MAX_ENTRIES
  return { path: resolved, entries: truncated ? dirs.slice(0, MAX_ENTRIES) : dirs, truncated }
}
