// Jev Arena viewer — a loopback server that runs a small living grid world where Jev (TypeSafe's
// System One model) is the brain. Each decision the world is written out as text and Jev answers four
// typed questions in one call: which way to move, what it is heading for, whether it is sure, and
// whether it is boxed in. The full probability spread goes to the pane with every frame, so the
// person watches Jev think on the board itself.
//
// The honest dial is `sight`: the hero only knows the walls it has seen. With a short sight the
// step counts in the text point through walls it has not met yet, so it walks into dead ends.
//
// The chat agent edits arena.json (the world, the pace, the sight). The pane lets a person build and
// break walls, drop coins, drag the goal and move the dials. It never idles: a finished run shows a
// short banner, then a fresh layout from the seed.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds arena.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev, snapshot as jevSnapshot } from '../toolchain/jev.mjs'
import { DEFAULT, ACTIONS, SEE_ALL, sanitize, createWorld, observe, act, finish, walledIn, look, toggleWall, toggleCoin, moveGoal } from './sim.mjs'
import { arenaMock } from './mock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILES = new Set(['index.html', 'studio.css', 'studio.js', 'jev-hud.js'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const REST_MS = 3000
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

export { sanitize }

export async function startArenaViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const file = join(workspace, 'arena.json')

  // Every binding is declared before anything can call into the closures below.
  let raw = { ...DEFAULT }
  let cfgError = null
  let overrides = {}
  let world = null
  let seen = null // what observe() last returned, for the pane
  let last = null // the last decision, with its full probability spread
  let stopped = false, running = false, busy = false
  let timer = null, watchTimer = null, salt = 1, episode = 0, lastVerdictAt = 0
  let error = null
  const clients = new Set()
  const totals = { decisions: 0, episodes: 0, goals: 0, coins: 0, bumps: 0, wonMoves: 0, wonPar: 0, results: [] }

  function load() {
    try { raw = { ...DEFAULT, ...JSON.parse(readFileSync(file, 'utf8')) }; cfgError = null } catch (e) {
      cfgError = existsSync(file) ? clean(`arena.json: ${e.message}`) : null
    }
  }
  const cfg = () => sanitize({ ...raw, ...overrides })

  function newEpisode(from = null, forceFresh = false) {
    world = createWorld(cfg(), episode, from, forceFresh)
    last = null
    seen = observe(world, cfg())
  }

  function rows(bytes, on) {
    const out = []
    for (let y = 0; y < world.h; y++) { let r = ''; for (let x = 0; x < world.w; x++) r += on(bytes[y * world.w + x]); out.push(r) }
    return out
  }

  function frame() {
    const c = cfg()
    return {
      type: 'frame', title: c.title, description: c.description, rules: c.rules,
      w: world.w, h: world.h, walls: rows(world.wall, (v) => (v ? '#' : '.')), seen: rows(world.memory, (v) => (v ? '1' : '0')),
      coins: world.coins.map((p) => [p.x, p.y]), goal: [world.goal.x, world.goal.y], hero: [world.hero.x, world.hero.y],
      trail: world.trail, plan: seen?.plan ?? [], heading: seen?.heading ?? 'none',
      episode: world.episode, status: world.status, result: world.result,
      moves: world.moves, par: world.par, maxMoves: world.maxMoves, coinsCollected: world.coinsCollected, coinsTotal: world.coinsTotal,
      last, totals: { ...totals, results: totals.results.slice(-8) },
      speed: c.speed, sight: c.sight, remix: c.remix, seed: c.seed,
      density: Number((world.wall.reduce((a, b) => a + b, 0) / (world.w * world.h)).toFixed(3)),
      stateText: seen?.text ?? '', running, error, cfgError, overrides,
    }
  }

  /** /state keeps the shape older tools read (world, state, decisionLog) and adds the full frame. */
  function fullState() {
    const c = cfg()
    return {
      world: { title: c.title, description: c.description, rules: c.rules, size: Math.max(c.w, c.h), width: c.w, height: c.h, speed: c.speed, sight: c.sight, remix: c.remix, seed: c.seed, hero: world.start, goal: world.goal, coins: world.coins, walls: [...world.wall].flatMap((v, i) => (v ? [{ x: i % world.w, y: Math.floor(i / world.w) }] : [])) },
      state: { moves: world.moves, reachedGoal: world.status === 'won', coinsCollected: world.coinsCollected, status: world.status, running, error: error || cfgError },
      decisionLog: last ? [last] : [],
      frame: frame(),
    }
  }

  function verdict() {
    const c = cfg()
    const problem = cfgError || error
    const reached = totals.goals > 0 || world.status === 'won'
    const eff = totals.wonMoves ? Math.round((totals.wonPar / totals.wonMoves) * 100) : null
    const v = {
      spec: 1,
      ready: !problem && totals.decisions > 0,
      summary: problem
        ? `Arena needs a fix: ${problem}`
        : `${c.title} · Jev has made ${totals.decisions} decisions · reached goal ${reached ? 'yes' : 'not yet'} · ${totals.goals} goals, ${totals.coins} coins${eff == null ? '' : `, ${eff}% of the shortest way`}`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'arena', message: problem }] : []),
        ...totals.results.filter((r) => r.status !== 'won').slice(-4).map((r) => ({ severity: 'warning', kind: 'run', message: r.status === 'stuck' ? `run ${r.episode + 1}: walled in, no way to the goal` : `run ${r.episode + 1}: out of moves after ${r.moves}` })),
        { severity: 'info', kind: 'run', message: `sight ${c.sight >= SEE_ALL ? 'whole board' : c.sight + ' cells'}, ${c.speed} ms per decision, ${totals.bumps} bumps into walls` },
      ],
      artifact: 'arena.json',
      phases: [
        { id: 'world', name: 'World', state: 'done' },
        { id: 'play', name: 'Play', state: reached ? 'done' : totals.decisions > 0 ? 'active' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
    const out = join(workspace, '.harness/verdict.json')
    writeFileSync(out + '.tmp', JSON.stringify(v))
    renameSync(out + '.tmp', out)
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 1000) { lastVerdictAt = now; try { verdict() } catch (e) { error = clean(e.message) } }
    if (!clients.size) return
    const line = `event: state\ndata: ${JSON.stringify(frame())}\n\n`
    for (const c of clients) c.write(line)
  }

  function settle() {
    totals.episodes++
    if (world.status === 'won') { totals.goals++; totals.wonMoves += world.moves; totals.wonPar += Math.min(world.par, world.moves) }
    totals.results.push({ episode: world.episode, ...world.result })
    if (totals.results.length > 40) totals.results.shift()
  }

  /** One decision. While a finished run is on show it only counts down to the next run. */
  async function decide() {
    if (busy || stopped) return
    busy = true
    try {
      const c = cfg()
      if (world.status !== 'play') {
        world.rest++
        if (world.rest * c.speed >= REST_MS) { episode++; newEpisode(c.remix ? world.hero : null); push(true) }
        return
      }
      const o = observe(world, c)
      const res = await evaluate({
        state: o.text,
        questions: {
          move: jev.choice({
            up: 'step one cell up (y gets smaller)', down: 'step one cell down (y gets bigger)',
            left: 'step one cell left (x gets smaller)', right: 'step one cell right (x gets bigger)',
            wait: 'stay on this cell',
          }, 'Which move leaves the fewest steps? Go for the nearest coin while one can be reached, then the goal. Never pick a wall.'),
          heading: jev.choice({ coin: 'a coin can still be reached, so get it first', goal: 'no coin is left to get, so head for the goal' }, 'What are you heading for right now?'),
          sure: jev.noul('Is one move clearly better than every other move?'),
          boxed_in: jev.noul('Are you boxed in, with walls on most sides or no way to the goal?'),
        },
        salt: salt++, model: process.env.JEV_MODEL || 'jev-latest', mock: arenaMock,
      })
      const a = res.answers.move ?? {}
      const move = ACTIONS.includes(a.choice) ? a.choice : 'wait'
      const ev = act(world, move)
      totals.decisions++
      if (ev?.coin) totals.coins++
      if (ev?.bumped) totals.bumps++
      last = {
        at: totals.decisions, move, probabilities: a.probabilities ?? {}, confidence: Number(a.confidence ?? 0),
        heading: res.answers.heading?.choice ?? o.heading, sure: Number(res.answers.sure?.noul ?? 0), boxedIn: Number(res.answers.boxed_in?.noul ?? 0),
        from: [ev.from.x, ev.from.y], to: [ev.to.x, ev.to.y], bumped: ev.bumped, coin: ev.coin ? [ev.coin.x, ev.coin.y] : null,
        steps: o.heading === 'coin' ? o.coinSteps : o.goalSteps, client: res.client, model: res.model,
      }
      if (world.status === 'play') { seen = observe(world, c); if (walledIn(seen)) finish(world, 'stuck') } else seen = { ...observe(world, c), plan: [] }
      if (world.status !== 'play') settle()
      error = null
    } catch (e) {
      error = clean(e?.message ?? String(e))
    } finally {
      busy = false
    }
  }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().speed) }
  async function run() {
    const t0 = Date.now(), before = world.status
    await decide()
    push(before !== world.status)
    if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().speed - (Date.now() - t0)))
  }

  function edited(ok) { if (ok) { look(world, cfg().sight); seen = observe(world, cfg()); if (walledIn(seen)) { finish(world, 'stuck'); settle() } } return ok }

  async function control(cmd, body) {
    const x = Math.round(Number(body.x)), y = Math.round(Number(body.y))
    let ok = true
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') {
      Object.assign(totals, { decisions: 0, episodes: 0, goals: 0, coins: 0, bumps: 0, wonMoves: 0, wonPar: 0, results: [] })
      overrides = {}; episode = 0; salt = 1; newEpisode()
    }
    else if (cmd === 'tick' || cmd === 'step') { const n = Math.round(num(body.n, 1, 20000, 1)); for (let i = 0; i < n; i++) await decide() }
    else if (cmd === 'wall') ok = edited(toggleWall(world, x, y))
    else if (cmd === 'coin') ok = edited(toggleCoin(world, x, y))
    else if (cmd === 'goal') ok = edited(moveGoal(world, x, y))
    else if (cmd === 'remix') { episode++; newEpisode(world.hero, true) }
    else if (cmd === 'set') {
      const allowed = { speed: [60, 2000], sight: [1, SEE_ALL], density: [0, 0.4] }
      const r = allowed[body.key]
      if (!r) ok = false
      else {
        overrides = { ...overrides, [body.key]: num(body.value, r[0], r[1], r[0]) }
        if (body.key === 'density') { episode++; newEpisode(world.hero) } else { seen = observe(world, cfg()); if (running) schedule() }
      }
    } else ok = false
    push(true)
    return { ok, moves: world.moves, episode: world.episode, status: world.status }
  }

  load()
  newEpisode()

  // Watch the folder, not the file: an editor that saves by rename would drop a file watch.
  const watcher = watch(workspace, (_, name) => {
    if (name && String(name) !== 'arena.json') return
    clearTimeout(watchTimer)
    watchTimer = setTimeout(() => {
      if (stopped) return
      const before = JSON.stringify(raw)
      load()
      if (JSON.stringify(raw) !== before) { overrides = {}; episode = 0; newEpisode() }
      push(true)
    }, 40)
  })

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    // Loopback only: a page on another origin (DNS rebinding) must not reach this server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET') {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        if (FILES.has(name)) { res.writeHead(200, { 'content-type': TYPES[extname(name)] }); return res.end(readFileSync(join(HERE, name))) }
        if (url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(fullState())) }
        if (url.pathname === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
        if (url.pathname === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
          res.write(`event: state\ndata: ${JSON.stringify(frame())}\n\n`)
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
      }
      if (req.method === 'POST' && url.pathname === '/control') {
        let body = ''
        for await (const c of req) { body += c; if (body.length > 65536) { res.writeHead(413); return res.end('Too large') } }
        let j
        try { j = JSON.parse(body || '{}') } catch { res.writeHead(400); return res.end('Bad JSON') }
        const reply = await control(String(j?.cmd ?? ''), j && typeof j === 'object' ? j : {})
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(reply))
      }
      res.writeHead(404); res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: clean(e?.message ?? e) }))
    }
  })

  await new Promise((ok, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ok) })

  push(true)
  running = true
  schedule()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      stopped = true; running = false
      clearTimeout(timer); clearTimeout(watchTimer)
      watcher.close()
      for (const c of clients) c.end()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startArenaViewer({ workspace, port })
  console.log(`Jev Arena listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
