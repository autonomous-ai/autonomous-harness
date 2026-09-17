// The Marp viewer: one loopback HTTP server per agent pane.
//
//   GET /                      the page (viewer/index.html): slide, grid, presenter and present views
//   GET /viewer/<file>         the page's script and style
//   GET /deck.json?file=       {html: [...], css, slides, verdict} for the deck at that path
//   GET /events                server-sent events: one "change" {path} per save, ": ping" every 20 s
//   GET /<anything else>       a file from the workspace (the deck's images), never outside it
//
// On every change under the workspace (minus .harness/ and dist/) the deck is re-rendered, judged,
// and the verdict rewritten — so the pane header moves while the agent writes, without the agent
// running anything. The page is read per request, so a viewer upgrade needs no restart.
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { extname, join, normalize, relative, resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintDeck, readDeck, writeVerdict } from './lib/deck.mjs'

const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const host = '127.0.0.1'
const clients = new Set()

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.md': 'text/markdown', '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.html': 'text/html',
}

function safeDeckFile(raw) {
  const wanted = (raw || 'deck.md').replace(/^\/+/, '')
  const full = resolve(workspace, wanted)
  if (!full.startsWith(workspace + sep) || !/\.(md|markdown)$/i.test(full)) return 'deck.md'
  return relative(workspace, full)
}

/** The deck the verdict is about. Any other Markdown file renders on request, but is not judged. */
const DECK = 'deck.md'

function deckJson(deckFile) {
  const file = join(workspace, deckFile)
  if (!existsSync(file)) {
    return { html: [], css: '', slides: [], deck: deckFile, missing: true, verdict: null }
  }
  const lint = lintDeck(readDeck(workspace, deckFile), { dir: dirname(file) })
  // Only THE deck writes the verdict: a page asked to show README.md must not turn the pane
  // header into a judgement of the README (seen 2026-09-15, when CLAUDE.md was the newest .md).
  const verdict = deckFile === DECK ? writeVerdict(workspace, deckFile, lint) : null
  return { html: lint.html, css: lint.css, slides: lint.slides, deck: deckFile, missing: false, verdict }
}

const toolchainDir = dirname(fileURLToPath(import.meta.url))
const PAGE = join(toolchainDir, 'viewer')
const PAGE_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}:${port}`)
  if (url.pathname === '/' || url.pathname.startsWith('/viewer/')) {
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice('/viewer/'.length)
    const full = normalize(join(PAGE, name))
    if (!full.startsWith(PAGE + sep) || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': PAGE_TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(full))
    return
  }
  if (url.pathname === '/marp-browser.js') {
    // marp-core's own browser script: the WebKit foreignObject polyfill and auto-scaling, watching
    // the DOM so slides inserted later are covered too.
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
    res.end(readFileSync(join(toolchainDir, 'node_modules', '@marp-team', 'marp-core', 'lib', 'browser.js')))
    return
  }
  if (url.pathname === '/deck.json') {
    let body
    try {
      body = deckJson(safeDeckFile(url.searchParams.get('file')))
    } catch (error) {
      body = { error: error instanceof Error ? error.message : String(error) }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': hello\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  // A workspace file, by the path the deck wrote. Never a path that leaves the workspace.
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const full = normalize(resolve(workspace, rel))
  if (!full.startsWith(workspace + sep) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404); res.end('not found'); return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(readFileSync(full))
})

// One "change" per burst of saves, naming the last path, so the page can tell a deck or an image
// edit (redraw) from anything else.
let timer = null
let lastPath = ''
function changed(path) {
  const rel = relative(workspace, join(workspace, path ?? '')).split(sep).join('/')
  if (rel.startsWith('.harness') || rel.startsWith('dist') || rel.startsWith('.git') || rel.startsWith('node_modules') || rel.startsWith('.claude')) return
  lastPath = rel
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const data = JSON.stringify({ path: lastPath })
    for (const client of clients) client.write(`event: change\ndata: ${data}\n\n`)
  }, 150)
}
try {
  watch(workspace, { recursive: true }, (_event, filename) => changed(filename?.toString()))
} catch (error) {
  console.error(`[marp] cannot watch ${workspace}: ${error instanceof Error ? error.message : error}`)
}
setInterval(() => { for (const client of clients) client.write(': ping\n\n') }, 20_000).unref()

server.listen(port, host, () => {
  console.log(`[marp:viewer] listening on http://${host}:${port}/ (workspace: ${workspace})`)
})
