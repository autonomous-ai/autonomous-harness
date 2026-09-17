// `$REMOTION` for the agent: Remotion's own CLI, unchanged, with one thing added for `render` and
// `still` — the progress lands in <workspace>/.harness/render.json as it happens, so the pane can show
// "Rendering Main · 45%" while the agent waits. Every other subcommand is passed straight through.
//
// The CLI's own lines still reach the terminal, minus the flood: "Bundling n%", "Rendered n/N" and
// "Encoded n/N" are printed at every tenth of the way (and at the end) instead of once per frame.
// The exit code is Remotion's.
import { spawn } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = process.env.REMOTION_CLI || join(here, '..', 'node_modules', '.bin', 'remotion')
const args = process.argv.slice(2)
const sub = args.find((a) => !a.startsWith('-'))
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()

if (isMain && sub !== 'render' && sub !== 'still') {
  const child = spawn(cli, args, { stdio: 'inherit' })
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
  child.on('error', (error) => { console.error(`remotion could not start: ${error.message}`); process.exit(1) })
} else if (isMain) {
  track()
}

// Pure, so the tests can feed it lines: one CLI line in, the state patch it implies out (or null).
export function parseLine(raw) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
  let m
  if ((m = line.match(/^Bundling (\d+)%/))) return { stage: 'bundling', progress: Number(m[1]) / 100 * 0.1 }
  if (/^Getting composition/.test(line)) return { stage: 'preparing' }
  if ((m = line.match(/^Composition\s+(\S+)/))) return { composition: m[1] }
  if ((m = line.match(/^Output\s+(.+)$/))) return { output: m[1].trim() }
  if ((m = line.match(/^Codec\s+(\S+)/))) return { codec: m[1] }
  if ((m = line.match(/^Rendered (\d+)\/(\d+)(?:, time remaining: (\S+))?/))) {
    const done = Number(m[1]), total = Number(m[2])
    return { stage: 'rendering', frame: done, frames: total, remaining: m[3] ?? null, progress: 0.1 + 0.8 * (total ? done / total : 0) }
  }
  if ((m = line.match(/^Encoded (\d+)\/(\d+)/))) {
    const done = Number(m[1]), total = Number(m[2])
    return { stage: 'encoding', frame: done, frames: total, progress: 0.9 + 0.1 * (total ? done / total : 0) }
  }
  if ((m = line.match(/^\+\s+(\S+)/))) return { output: m[1], stage: 'finishing', progress: 1 }
  return null
}

// Whether a line is worth printing: progress lines only at every tenth, everything else always.
export function shouldPrint(raw, last) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim()
  const m = line.match(/^(Bundling|Rendered|Encoded) (\d+)(%|\/(\d+))/)
  if (!m) return true
  const fraction = m[3] === '%' ? Number(m[2]) / 100 : (Number(m[4]) ? Number(m[2]) / Number(m[4]) : 0)
  const step = Math.floor(fraction * 10)
  if (last[m[1]] === step && fraction < 1) return false
  last[m[1]] = step
  return true
}

function track() {
  const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd())
  const file = join(workspace, '.harness', 'render.json')
  const positional = args.filter((a) => !a.startsWith('-'))
  // render [entry] <composition> [output]: the CLI names both back in its own lines; this is the
  // guess until it does.
  const guess = positional.slice(1)
  const state = {
    spec: 1, command: sub, state: 'running', stage: 'starting', progress: 0,
    composition: guess.length >= 2 && /\.(tsx?|jsx?|mjs)$/.test(guess[0]) ? guess[1] : guess[0] ?? null,
    output: null, frame: null, frames: null, remaining: null, error: null,
    pid: process.pid, startedAt: new Date().toISOString(), updatedAt: null, finishedAt: null,
  }
  let pending = null
  const write = (now = false) => {
    const flush = () => {
      pending = null
      state.updatedAt = new Date().toISOString()
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file + '.tmp', JSON.stringify(state, null, 2) + '\n')
        renameSync(file + '.tmp', file)
      } catch {}
    }
    if (now) { if (pending) clearTimeout(pending); flush(); return }
    if (!pending) pending = setTimeout(flush, 150)
  }
  write(true)

  const child = spawn(cli, args, { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } })
  const last = {}
  const tail = []
  const pipe = (stream, out) => {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk.toString()
      let i
      while ((i = buffer.search(/\r?\n|\r/)) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + (buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1))
        handle(line, out)
      }
    })
    stream.on('end', () => { if (buffer) handle(buffer, out) })
  }
  const handle = (line, out) => {
    const patch = parseLine(line)
    if (patch) {
      if (patch.output) patch.output = relative(workspace, resolve(process.cwd(), patch.output)) || patch.output
      Object.assign(state, patch)
      write()
    }
    if (line.trim()) { tail.push(line.replace(/\x1b\[[0-9;]*m/g, '')); if (tail.length > 20) tail.shift() }
    if (shouldPrint(line, last)) out.write(line + '\n')
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  const finish = (code) => {
    state.state = code === 0 ? 'done' : 'failed'
    state.stage = code === 0 ? 'done' : 'failed'
    if (code === 0) state.progress = 1
    else state.error = tail.filter((l) => /error|Error|failed|✖/.test(l)).slice(-3).join('\n') || tail.slice(-3).join('\n') || `remotion exited ${code}`
    state.finishedAt = new Date().toISOString()
    write(true)
    process.exit(code ?? 1)
  }
  child.on('exit', (code, signal) => setTimeout(() => finish(signal ? 1 : code), 50))
  child.on('error', (error) => { tail.push(error.message); finish(1) })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig) })
}
