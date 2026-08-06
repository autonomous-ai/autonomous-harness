/**
 * Project file listing + reading for the remote agent's SourceTree ("Files" panel).
 * Root = the tmux session's working dir. Mirrors the hosted runtime’s tree/ignore/hidden-path rules
 * (ProjectService.readDirRecursive / readFile) and ADDS the file-view guard: only files ≤ 5 MB and
 * only text files (binary → rejected). Self-contained — no dependencies outside this package.
 */

import { readdirSync, statSync, readFileSync } from 'fs'
import { join, resolve, sep, basename } from 'path'

export interface FileNode {
  name: string
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MiB

// Exact-name ignores (kept in sync with the hosted runtime’s readDirRecursive). Any dot-prefixed entry
// (`.git`, `.next`, `.vite`, `.claude`, `.env`, `.node_modules`, …) is excluded separately below,
// so only the non-dot names need listing here.
const EXCLUDE = new Set(['node_modules', 'dist', 'logs', 'CLAUDE.md'])

/** Hidden entry: any name starting with a dot (e.g. `.git`, `.env`, `.node_modules`). */
const isHidden = (name: string): boolean => name.startsWith('.')

// Soft caps so a giant arbitrary user dir can't hang / flood the walk (the hosted runtime has none, but the
// remote root is an arbitrary machine dir).
const MAX_NODES = 20_000
const MAX_DEPTH = 12

/** Recursive eager file tree under `root`, excluding EXCLUDE names, dirs-before-files sorted. */
export function listFileTree(root: string): FileNode[] {
  let count = 0
  let truncated = false

  const walk = (dir: string, depth: number): FileNode[] => {
    if (depth > MAX_DEPTH || count >= MAX_NODES) { truncated = true; return [] }
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    const nodes: FileNode[] = []
    for (const entry of entries) {
      if (isHidden(entry.name) || EXCLUDE.has(entry.name)) continue
      if (count >= MAX_NODES) { truncated = true; break }
      count++
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        nodes.push({ name: entry.name, type: 'dir', children: walk(full, depth + 1) })
      } else if (entry.isFile()) {
        let size = 0
        try { size = statSync(full).size } catch { /* ignore */ }
        nodes.push({ name: entry.name, type: 'file', size })
      }
    }
    return nodes.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
  }

  const tree = walk(root, 0)
  if (truncated) console.warn(`[files] tree truncated at ${count} nodes for ${root}`)
  return tree
}

/** First 8 KB has a NUL byte → treat as binary (git/grep heuristic; extension-agnostic). */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * Read one project file. Throws a bare error CODE on any rule violation:
 *   NOT_FOUND | FILE_TOO_LARGE | NOT_TEXT
 */
export function readProjectFile(root: string, relPath: string): string {
  // Hidden/internal blocks (mirror the hosted runtime). Any dot-prefixed path segment (`.env`, `.git/…`,
  // `.claude/…`, and `..`) is hidden from the tree, so it must not be readable directly either.
  if (
    basename(relPath) === 'CLAUDE.md' ||
    relPath.startsWith('logs/') ||
    relPath.split(/[/\\]/).some((seg) => seg.startsWith('.'))
  ) {
    throw new Error('NOT_FOUND')
  }
  // Path-traversal safety: the resolved path must stay under root.
  const rootResolved = resolve(root)
  const full = resolve(rootResolved, relPath)
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) throw new Error('NOT_FOUND')

  let st
  try { st = statSync(full) } catch { throw new Error('NOT_FOUND') }
  if (!st.isFile()) throw new Error('NOT_FOUND')
  if (st.size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')

  let buf: Buffer
  try { buf = readFileSync(full) } catch { throw new Error('NOT_FOUND') }
  if (isBinary(buf)) throw new Error('NOT_TEXT')
  return buf.toString('utf-8')
}
