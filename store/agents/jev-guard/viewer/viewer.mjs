// Jev Guard viewer — a loopback server where Jev (TypeSafe's System One model) judges the coding
// agent's own live edits. The agent works a tiny project (project/*.js) toward the goal in
// goal.json. The viewer watches the project, runs the test suite on every change, and asks Jev to
// score the resulting diff: how close to done, how risky, how much it trusts the change. The
// verdict is Jev's running judgment of its own teammate's work.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. The workspace holds goal.json + project/.
//
// To keep it dependency-free and offline-safe, the test runner is a tiny harness: it invokes
// `node project/test.js` (the template ships a plain-node test file) and parses pass/fail from
// the exit code and "ALL TESTS PASS" marker. Swap test.js for any zero-dependency runner.

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT_GOAL = {
  goal: 'Make every test in project/test.js pass without breaking the others.',
  name: 'Jev Guard',
  description: 'Jev judges your own edits live.',
}

function listFiles(dir, acc = [], base = '') {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(full).isDirectory()) {
      if (name === '.harness' || name === 'node_modules') continue
      listFiles(full, acc, rel)
    } else {
      acc.push(rel)
    }
  }
  return acc
}

function snapshot(workspace) {
  // Cheap content hash of the whole project so we can build diffs per edit.
  const files = listFiles(join(workspace, 'project'))
  const out = {}
  for (const f of files) out[f] = readFileSync(join(workspace, 'project', f), 'utf8')
  return out
}

export async function startGuardViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let goal = readGoal(join(workspace, 'goal.json'))
  let clients = new Set()
  let lastLine = null // the last frame sent, replayed to a pane that connects later
  let stopped = false
  let salt = 1
  let running = false
  let error = null
  let lastRun = null      // { at, passed, failed, output }
  let history = []        // [{ i, at, passed, failed, judge:{trust,risk,done,green} }]
  let runCount = 0
  let prev = snapshot(workspace)

  function readGoal(file) {
    try { return { ...DEFAULT_GOAL, ...JSON.parse(readFileSync(file, 'utf8')) } }
    catch { return DEFAULT_GOAL }
  }

  function runTests() {
    // Template tests are a plain-node script; return per-file/overall pass.
    const res = spawnSync('node', [join(workspace, 'project', 'test.js')], { cwd: join(workspace, 'project'), encoding: 'utf8', timeout: 10000 })
    const output = clean(res.stdout || '' + res.stderr || '')
    const passed = res.status === 0
    const failed = !passed
    const green = /all tests pass/i.test(output)
    return { passed, failed, green, output }
  }

  function diffSince(now) {
    // Summarize the files that changed since the last run, for Jev to judge.
    const changed = []
    for (const [f, content] of Object.entries(prev)) {
      let cur = null
      try { cur = readFileSync(join(workspace, 'project', f), 'utf8') } catch { /* deleted */ }
      if (cur !== content) changed.push(f)
    }
    for (const f of listFiles(join(workspace, 'project'))) if (!(f in prev)) changed.push(f)
    return changed.length ? changed.join(', ') : '(no file changes)'
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    lastLine = line
    for (const c of clients) c.write(line)
  }

  function tail() {
    const v = verdict(goal, lastRun, history, { error })
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
    broadcast({
      type: 'judge',
      title: goal.name,
      description: goal.description,
      goal: goal.goal,
      running,
      error,
      lastRun,
      history: history.slice(-20),
      runCount,
    })
  }

  async function judge() {
    if (stopped) return
    try {
      const t = runTests()
      const changed = diffSince()
      prev = snapshot(workspace)
      runCount++
      const res = await evaluate({
        state: `You are Jev Guard, judging a coding agent's live work.
Goal: ${goal.goal}

Just now the agent changed these files: ${changed}.

Test run #${runCount} result: ${t.passed ? 'PASSING' : 'FAILING'}${t.green ? ' (all tests green)' : ''}.
Test output (last 400 chars):
${t.output.slice(-400) || '(no output)'}

Judge the agent's progress toward the goal.`,
        questions: {
          toward: {
            type: 'score',
            instructions: 'How much closer to the goal is the code right now?',
            legend: { 0: 'no progress', 1: 'some', 2: 'done' },
          },
          trust: {
            type: 'score',
            instructions: 'How confident are you that this exact change is correct?',
            legend: { 0: 'distrust', 1: 'wary', 2: 'confident' },
          },
          risk: {
            type: 'score',
            instructions: 'How risky was this change — could it be a regression in disguise?',
            legend: { 0: 'safe', 1: 'risky', 2: 'reckless' },
          },
          green: {
            type: 'noul',
            instructions: 'Are all tests passing and is the goal met?',
          },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const a = res.answers
      const judgeRec = {
        i: runCount,
        at: new Date().toISOString(),
        passed: t.passed,
        green: t.green,
        toward: typeof a.toward?.score === 'number' ? a.toward.score : 1,
        trust: typeof a.trust?.score === 'number' ? a.trust.score : 1,
        risk: typeof a.risk?.score === 'number' ? a.risk.score : 0,
        done: a.green?.noul ?? 0,
        changed,
        client: res.client,
      }
      history.push(judgeRec)
      if (history.length > 40) history.splice(0, history.length - 40)
      lastRun = { at: judgeRec.at, passed: t.passed, failed: !t.passed, output: t.output }
      error = null
    } catch (e) {
      error = clean(e.message)
    }
    tail()
  }

  let debounce = null
  function scheduleJudge() {
    clearTimeout(debounce)
    debounce = setTimeout(judge, 300)
  }

  const watcher = watch(join(workspace, 'project'), { recursive: true }, () => {
    if (running) scheduleJudge()
  })
  const goalWatcher = watch(workspace, (_, name) => {
    if (!name) return
    if (String(name).split('/').join('/') === 'goal.json') {
      goal = readGoal(join(workspace, 'goal.json'))
      tail()
    }
  })

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'index.html'))) }
    if (req.method === 'GET' && url.pathname === '/studio.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'studio.js'))) }
    if (req.method === 'GET' && url.pathname === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
    if (req.method === 'GET' && url.pathname === '/jev-hud.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'jev-hud.js'))) }
    if (req.method === 'GET' && url.pathname === '/studio.css') { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'studio.css'))) }
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: goal.name, goal: goal.goal, running, lastRun, history: history.slice(-20), runCount })) }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      clients.add(res)
      if (lastLine) res.write(lastLine)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/control') {
      let body = ''
      for await (const c of req) { body += c; if (body.length > 1024) break }
      const cmd = JSON.parse(body || '{}').cmd
      if (cmd === 'pause') running = false
      if (cmd === 'start') { if (!running) { running = true; scheduleJudge() } }
      if (cmd === 'judge') await judge()
      if (cmd === 'reset') { history = []; runCount = 0; lastRun = null; prev = snapshot(workspace); tail() }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    res.writeHead(404); res.end('Not found')
  })

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  tail()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { stopped = true; clearTimeout(debounce); watcher.close(); goalWatcher.close(); for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((r) => server.close(r)) },
  }
}

function verdict(goal, lastRun, history, state) {
  const len = history.length
  const last = history[len - 1]
  const done = last?.done ?? 0
  return {
    spec: 1,
    ready: len > 0,
    summary: state.error
      ? 'Jev Guard needs a fix'
      : last
        ? `${goal.name} · ${done >= 0.8 ? 'goal met' : last.passed ? 'tests passing, judging…' : 'tests failing — agent is working'}` + (len ? ` (${len} runs)` : '')
        : `${goal.name} · waiting for the agent's first edit`,
    findings: (state.error ? [{ severity: 'error', kind: 'guard', message: state.error }] : []).concat(
      last && !last.passed ? [{ severity: 'warn', kind: 'guard', message: `Test run #${last.i} failing (trust ${last.trust.toFixed(1)}/2, risk ${last.risk.toFixed(1)}/2)` }] : []
    ),
    artifact: 'project/',
    phases: [
      { id: 'edit', name: 'Agent edits', state: len ? 'active' : 'pending' },
      { id: 'judge', name: 'Jev judges', state: len ? 'active' : 'pending' },
    ],
    updatedAt: new Date().toISOString(),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startGuardViewer({ workspace, port })
  console.log(`Jev Guard listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
