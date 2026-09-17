// What the flow has left in the workspace, read fresh on every request: which top module, which
// run, each step's state and timing, the pin constraints, the ports.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const STEPS = [
  { id: 'sim', name: 'Simulate', stage: 'sim' },
  { id: 'waves', name: 'Waveforms', stage: 'sim' },
  { id: 'synth', name: 'Synthesize', stage: 'synth' },
  { id: 'schematic', name: 'Schematic netlist', stage: 'synth' },
  { id: 'svg', name: 'Schematic drawing', stage: 'synth' },
  { id: 'pnr', name: 'Place & route', stage: 'pnr' },
  { id: 'pack', name: 'Bitstream', stage: 'pack' },
]

export function readText(path, max = Infinity) {
  try {
    const size = statSync(path).size
    if (size <= max) return readFileSync(path, 'utf8')
    // A huge log: its end is what matters.
    const buf = readFileSync(path)
    return buf.subarray(buf.length - max).toString('utf8')
  } catch {
    return null
  }
}

export function readJson(path) {
  const text = readText(path)
  if (text == null) return null
  try { return JSON.parse(text) } catch { return null }
}

export function fileInfo(ws, rel) {
  try {
    const st = statSync(join(ws, rel))
    return st.isFile() ? { path: rel, mtime: Math.round(st.mtimeMs), size: st.size } : null
  } catch {
    return null
  }
}

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** The top module: what flow.sh last ran, else the report the pane was opened on, else tb/<top>_tb.v. */
export function findTop(ws, fileParam) {
  const fromFile = (fileParam ?? '').match(/(?:^|\/)([^/]+?)(?:\.report\.json|_pnr\.json|_routed\.json|_schematic\.json|\.json|\.svg|\.bin|\.asc)$/)
  const dotTop = readText(join(ws, 'out', '.top'))?.trim()
  if (dotTop) return dotTop
  if (fromFile && fromFile[1] !== 'waves' && fromFile[1] !== 'sim') return fromFile[1]
  try {
    const reports = readdirSync(join(ws, 'out')).filter((f) => f.endsWith('.report.json'))
      .map((f) => [f, statSync(join(ws, 'out', f)).mtimeMs]).sort((a, b) => b[1] - a[1])
    if (reports.length) return reports[0][0].replace(/\.report\.json$/, '')
  } catch { /* no out/ yet */ }
  try {
    const tb = readdirSync(join(ws, 'tb')).find((f) => f.endsWith('_tb.v'))
    if (tb) return tb.replace(/_tb\.v$/, '')
  } catch { /* no tb/ */ }
  return null
}

function lastLine(text) {
  if (!text) return ''
  const lines = text.split('\n')
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k].replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (l) return l.slice(0, 300)
  }
  return ''
}

/** The first line of a log that reads as the error, for a failed step's banner. */
export function errorLine(text) {
  if (!text) return ''
  const lines = text.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean)
  const hit = lines.find((l) => /(^|\s)(ERROR|error|Error)\b|: error:|syntax error|FAIL\b|No such file|not found|unconstrained/i.test(l) && !/^\s*ok\b/.test(l))
  return (hit ?? lines[lines.length - 1] ?? '').slice(0, 400)
}

/** The run and every step, live: running now, done, failed with its error line, or skipped. */
export function flowState(ws) {
  const logs = join(ws, 'out', 'logs')
  const run = readJson(join(logs, 'run.json'))
  const finished = Boolean(run?.finishedAt)
  const abandoned = Boolean(run && !finished && run.pid && !alive(run.pid))
  const steps = STEPS.map((s) => {
    const exitText = readText(join(logs, `${s.id}.exit`))
    const startText = readText(join(logs, `${s.id}.start`))
    const timeText = readText(join(logs, `${s.id}.time`))
    const logPath = join(logs, `${s.id}.log`)
    const hasLog = existsSync(logPath)
    const step = { ...s, state: 'pending' }
    if (exitText != null && exitText.trim() !== '') {
      const code = Number(exitText.trim())
      step.state = code === 0 ? 'done' : 'failed'
      step.exit = code
    } else if (hasLog || startText) {
      step.state = abandoned ? 'interrupted' : 'running'
    } else if (finished || abandoned) {
      step.state = 'skipped'
    }
    if (startText && /^\d+/.test(startText.trim())) step.startedAt = Number(startText.trim())
    const times = (timeText ?? '').trim().split(/\s+/).map(Number)
    if (times.length === 2 && times.every(Number.isFinite)) step.ms = times[1] - times[0]
    if (hasLog) {
      step.log = relative(ws, logPath)
      if (step.state === 'running' || step.state === 'failed' || step.state === 'interrupted') {
        const text = readText(logPath, 256 * 1024)
        step.last = lastLine(text)
        if (step.state === 'failed') step.error = errorLine(text)
      }
    }
    return step
  })
  return { run, finished, abandoned, running: Boolean(run && !finished && !abandoned), steps }
}

/**
 * A PCF: `set_io [-nowarn] [-pullup yes] … <port> <pin>` and nextpnr's `set_frequency <net> <MHz>`.
 * Commented lines are kept too (as `commented: true`) — they are the board's unused pins.
 */
export function parsePcf(text) {
  const ios = []
  const frequencies = {}
  const lines = (text ?? '').split('\n')
  lines.forEach((raw, index) => {
    const commented = /^\s*#/.test(raw)
    const line = raw.replace(/^\s*#+\s*/, '').replace(/#.*$/, '').trim()
    if (!line) return
    const words = line.split(/\s+/)
    if (words[0] === 'set_io') {
      const args = []
      const flags = {}
      for (let k = 1; k < words.length; k++) {
        const w = words[k]
        if (w.startsWith('-')) {
          if (w === '-nowarn') flags.nowarn = true
          else if (k + 1 < words.length && !words[k + 1].startsWith('-')) flags[w.slice(1)] = words[++k]
          else flags[w.slice(1)] = true
        } else args.push(w)
      }
      if (args.length >= 2) ios.push({ port: args[0], pin: args[1], line: index + 1, commented, ...flags })
    } else if (words[0] === 'set_frequency' && words.length >= 3 && !commented) {
      frequencies[words[1]] = Number(words[2])
    }
  })
  return { ios, frequencies }
}

/** Ports of the top module, from the synthesised netlist (or the schematic one before that). */
export function topPorts(ws, top) {
  for (const rel of [`out/${top}.json`, `out/${top}_schematic.json`]) {
    const nl = readJson(join(ws, rel))
    const mods = nl?.modules
    if (!mods) continue
    const name = mods[top] ? top : Object.keys(mods).find((m) => Number(mods[m]?.attributes?.top) === 1)
    const mod = mods[name]
    if (!mod) continue
    const ports = {}
    for (const [p, v] of Object.entries(mod.ports ?? {})) ports[p] = { direction: v.direction, width: (v.bits ?? []).length }
    return { from: rel, ports }
  }
  return null
}

/** RTL and testbench sources, for the source viewer and the header. */
export function sources(ws) {
  const out = []
  for (const dir of ['rtl', 'tb', 'constraints']) {
    try {
      for (const f of readdirSync(join(ws, dir)).sort()) {
        if (/\.(s?v|vh|svh|pcf)$/.test(f)) out.push(fileInfo(ws, `${dir}/${f}`))
      }
    } catch { /* missing dir */ }
  }
  return out.filter(Boolean)
}

