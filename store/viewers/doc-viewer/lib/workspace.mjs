// What the pane needs to know about the workspace, as plain functions (the server calls them on every
// change; the tests call them on a temp dir): which PDFs there are, which one to show, whether the
// source is newer than the PDF (a compile is on its way), and whether the last compile failed —
// with the offending source lines, so the pane can show the error where it happened.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, normalize, sep } from 'node:path'

// The same trees Harness's own artifact scan skips (cli/src/dsh/artifacts.ts), plus dot-dirs.
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '__cadgen__', '.circuit', '.harness',
  '.claude', '.agents', '.codex', 'dist', 'build', '.cache', 'inputs', 'blocks',
])
// What a document is made from. Anything else (logs, the PDF itself, exports) never means "stale".
export const SOURCE_EXTENSIONS = new Set([
  '.typ', '.tex', '.ltx', '.bib', '.cls', '.sty', '.md', '.markdown', '.rst', '.adoc',
  '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml', '.xml', '.svg', '.png', '.jpg', '.jpeg', '.gif',
  '.webp', '.ttf', '.otf', '.woff', '.woff2', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods',
  '.html', '.htm', '.css',
])
// Files Harness itself writes into every workspace; touching them is not an edit to the document.
const HARNESS_FILES = new Set(['AGENTS.md', 'CLAUDE.md'])
const MAX_DEPTH = 6
const MAX_FILES = 20_000

/** `rel` resolved inside `root`, or null when it would leave it. */
export function safeJoin(root, rel) {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

function extOf(name) {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/** One bounded walk: every PDF, and the newest source file (outside `skipDir`, the PDF's own folder). */
export function scan(workspace, { skipDir = null } = {}) {
  const pdfs = []
  let source = null
  let seen = 0
  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH || seen > MAX_FILES) return
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (seen++ > MAX_FILES) return
      if (name.startsWith('.')) continue
      const path = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      let st
      try { st = statSync(path) } catch { continue }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(name)) walk(path, relPath, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      const ext = extOf(name)
      if (ext === '.pdf') {
        pdfs.push({ path: relPath, size: st.size, mtimeMs: st.mtimeMs })
        continue
      }
      if (!SOURCE_EXTENSIONS.has(ext) || (!rel && HARNESS_FILES.has(name))) continue
      if (skipDir && (rel === skipDir || rel.startsWith(skipDir + '/'))) continue
      if (!source || st.mtimeMs > source.mtimeMs) source = { path: relPath, mtimeMs: st.mtimeMs }
    }
  }
  walk(workspace, '', 0)
  pdfs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { pdfs, source }
}

/** `.harness/verdict.json`, parsed, with its mtime; null when absent or unreadable. */
export function readVerdict(workspace) {
  const path = join(workspace, '.harness', 'verdict.json')
  try {
    const st = statSync(path)
    const json = JSON.parse(readFileSync(path, 'utf8'))
    if (!json || typeof json !== 'object') return null
    return { ...json, findings: Array.isArray(json.findings) ? json.findings : [], mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** The source lines around a `file:line:col` ref, for the error card. Null when it is not one. */
export function snippet(workspace, ref, context = 2) {
  const m = typeof ref === 'string' ? /^(.+?):(\d+):(\d+)$/.exec(ref) : null
  if (!m) return null
  const full = safeJoin(workspace, m[1])
  if (!full) return null
  let text
  try {
    if (statSync(full).size > 2_000_000) return null
    text = readFileSync(full, 'utf8')
  } catch {
    return null
  }
  const all = text.split('\n')
  const line = Number(m[2]), col = Number(m[3])
  if (line < 1 || line > all.length) return null
  const from = Math.max(1, line - context), to = Math.min(all.length, line + 1)
  const lines = []
  for (let n = from; n <= to; n++) lines.push({ n, text: all[n - 1].slice(0, 400) })
  return { file: m[1], line, col, lines }
}

/**
 * The whole answer for one pane showing `requested` (workspace-relative, may be empty). The build
 * state is read from mtimes alone, so it works for any harness that compiles to PDF:
 *   building — a source file is newer than both the PDF and the verdict: a compile is coming
 *   failed   — the verdict is not ready, has errors, and is newer than the PDF and every source
 *   idle     — otherwise
 */
export function docState(workspace, requested = '', now = Date.now()) {
  const want = typeof requested === 'string' ? requested.replace(/^\/+/, '') : ''
  const dirOf = (rel) => (rel && dirname(rel) !== '.' ? dirname(rel) : null)
  let file = want && safeJoin(workspace, want) ? want : ''
  let found = scan(workspace, { skipDir: dirOf(file) })
  if (!file && found.pdfs[0]) {
    file = found.pdfs[0].path
    if (dirOf(file)) found = scan(workspace, { skipDir: dirOf(file) })
  }
  const { pdfs, source } = found
  let pdf = null
  if (file) {
    try {
      const st = statSync(safeJoin(workspace, file))
      if (st.isFile()) pdf = { path: file, size: st.size, mtimeMs: st.mtimeMs }
    } catch { /* not written yet */ }
  }
  const verdict = readVerdict(workspace)
  const pdfT = pdf?.mtimeMs ?? 0, srcT = source?.mtimeMs ?? 0, verT = verdict?.mtimeMs ?? 0
  const aboutThis = verdict && (!verdict.artifact || !file || verdict.artifact === file)
  const errors = aboutThis ? verdict.findings.filter((f) => f && f.severity === 'error') : []
  let build = 'idle'
  if (source && srcT > pdfT && srcT > verT) build = 'building'
  else if (aboutThis && verdict.ready === false && errors.length && verT >= pdfT) build = 'failed'
  const findings = aboutThis
    ? verdict.findings.slice(0, 50).map((f) => ({
        severity: f.severity, kind: f.kind ?? null, message: String(f.message ?? ''), ref: f.ref ?? null,
        hints: Array.isArray(f.hints) ? f.hints.map(String).slice(0, 5) : [],
        snippet: f.severity === 'error' ? snippet(workspace, f.ref) : null,
      }))
    : []
  return {
    workspace: basename(workspace),
    requested: want,
    file: file || null,
    pdf,
    pdfs: pdfs.slice(0, 40),
    source,
    build,
    since: build === 'building' ? srcT : build === 'failed' ? verT : null,
    verdict: verdict
      ? { ready: verdict.ready === true, summary: typeof verdict.summary === 'string' ? verdict.summary : '', artifact: verdict.artifact ?? null, updatedAt: verdict.updatedAt ?? null, mtimeMs: verT, findings }
      : null,
    now,
  }
}

/** The part of the state that, when it changes, the pane must hear about (not the clock). */
export function stateKey(state) {
  const { now, ...rest } = state
  return JSON.stringify(rest)
}
