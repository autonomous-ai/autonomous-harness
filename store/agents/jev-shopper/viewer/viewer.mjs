// Jev Shopper viewer — a loopback server running a made-up shop. A few products stream prices. On
// every tick Jev (TypeSafe's System One model) reads the board and answers two typed questions in
// one call: which product is the best buy right now (a choice with a probability per product), and
// whether the signal is strong enough to spend (a yes/no). When Jev says spend and its pick is far
// enough under its usual price, an order goes in. It lands one tick later, at the price it finds.
//
// Rounds never stop: when the budget is spent (or time is up) the result shows for about three
// seconds, then a new round starts with a new seed. The honest dial is `vol`, the price noise: it
// makes one-tick wobbles look like deals. See sim.mjs.
//
// The chat agent edits shopper.json. The pane lets a person start a flash sale, move the budget,
// the noise and the speed, and add or remove product streams (runtime overrides: an edit to
// shopper.json clears them).
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds shopper.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'
import { DEFAULT, POOL, MAX_PRODUCTS, MAX_ROUND_TICKS, SERIES_N, sanitize, makeStream, advance, flashSale, observe, shownDisc, trueDisc } from './sim.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = 'shopper.json'
const FILES = new Set(['index.html', 'base.css', 'studio.css', 'studio.js', 'jev-hud.js'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const REST_MS = 3000
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const blankScore = () => ({ decisions: 0, calls: 0, right: 0, buys: 0, paid: 0, avgSum: 0, saved: 0, bounced: 0 })

export async function startShopperViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const markerFile = join(workspace, MARKER)

  // Every binding is declared before anything below can run.
  let fileCfg = { ...DEFAULT }, cfgError = null, overrides = {}
  let streams = [], round = 0, roundTick = 0, roundStart = 0, step = 0
  let cash = DEFAULT.cash, spent = 0
  let phase = 'shopping', result = null, rest = 0
  let session = blankScore(), roundScore = blankScore(), rounds = []
  let picks = [], receipts = [], buyId = 0, bounce = null
  let last = { pick: '—', confidence: 0, probs: {}, act: 0, watchOnly: false, trueBest: null, ordered: null }
  let stateText = ''
  let error = null
  let running = false, stopped = false, busy = false
  let timer = null, watchTimer = null, salt = 1, lastVerdictAt = 0
  const clients = new Set()

  const cfg = () => sanitize({ ...fileCfg, ...overrides })

  function loadCfg() {
    try { fileCfg = { ...DEFAULT, ...JSON.parse(readFileSync(markerFile, 'utf8')) }; cfgError = null }
    catch (e) { cfgError = existsSync(markerFile) ? clean(`${MARKER}: ${e.message}`) : null } // keep the last good config
  }

  function newRound() {
    const c = cfg()
    const seed = c.seed + round * 7919
    streams = c.products.map((p) => makeStream(p, seed, c.vol))
    cash = c.cash; spent = 0; roundTick = 0; roundStart = step
    phase = 'shopping'; result = null; rest = 0
    roundScore = blankScore()
    last = { pick: '—', confidence: 0, probs: {}, act: 0, watchOnly: false, trueBest: null, ordered: null }
    stateText = observe(c, streams, cash).text
  }

  function resetAll() {
    overrides = {}; round = 0; step = 0; salt = 1; buyId = 0
    session = blankScore(); rounds = []; picks = []; receipts = []; bounce = null; error = null
    newRound()
  }

  /** Products changed (an override or an edit): keep the streams that still exist, build the new ones. */
  function syncStreams() {
    const c = cfg()
    const seed = c.seed + round * 7919
    streams = c.products.map((p) => streams.find((s) => s.name === p.name && s.base === p.price) ?? makeStream(p, seed, c.vol))
  }

  function endRound(reason) {
    const r = roundScore
    result = { round: round + 1, reason, ticks: roundTick, buys: r.buys, paid: r.paid, avgSum: r.avgSum, saved: r.saved, savedPct: r.avgSum ? r.saved / r.avgSum : 0 }
    rounds.push(result); if (rounds.length > 40) rounds.shift()
    phase = 'result'; rest = 0
    for (const s of streams) s.pending = null
  }

  function land(s) {
    const o = s.pending; s.pending = null
    if (s.price > cash) { session.bounced++; roundScore.bounced++; bounce = { id: session.bounced, name: s.name, step }; return } // the price jumped past the budget
    cash -= s.price; spent += s.price
    const buy = { id: ++buyId, round: round + 1, step, name: s.name, price: s.price, avg: o.avg, saved: o.avg - s.price, seen: o.seen, flash: !!(s.sale?.flash) }
    s.buys.push(buy); s.locked = true; s.lockedAt = roundTick
    receipts.push(buy); if (receipts.length > 40) receipts.shift()
    for (const sc of [session, roundScore]) { sc.buys++; sc.paid += buy.price; sc.avgSum += buy.avg; sc.saved += buy.saved }
  }

  /** One tick: prices move, last tick's order lands, Jev reads the board and answers. */
  async function decide() {
    if (busy || stopped) return false
    busy = true
    try {
      const c = cfg()
      step++; roundTick++
      for (const s of streams) advance(s, c.vol) // prices never stop, not even on the result screen
      if (phase === 'result') { // show the result for about three seconds, then shop again with a new seed
        rest++
        if (rest * c.tickMs >= REST_MS) { round++; newRound() }
        return true
      }
      for (const s of streams) if (s.pending) land(s)
      for (const s of streams) if (s.locked && roundTick - s.lockedAt >= 6 && s.price >= s.avg * 0.98) s.locked = false

      // The round is over when the budget cannot buy anything more, or when time is up. A budget
      // too small to buy anything at all keeps Jev watching until time is up.
      const cheapest = Math.min(...streams.map((s) => s.avg))
      if (roundScore.buys > 0 && cash < cheapest * 0.8) { endRound('budget'); return true }
      if (roundTick >= MAX_ROUND_TICKS) { endRound('time'); return true }

      const o = observe(c, streams, cash)
      stateText = o.text
      const res = await evaluate({
        state: o.text,
        questions: {
          buy: { type: 'choice', instructions: 'Which product is the best buy to act on right now?', options: o.options },
          act: { type: 'noul', instructions: 'Is this a strong enough signal to spend now?' },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const a = res.answers.buy ?? {}
      const pick = o.options.includes(a.choice) ? a.choice : o.options[0]
      const act = typeof res.answers.act?.noul === 'number' ? res.answers.act.noul : 0.5
      last = { pick, confidence: Number(a.confidence ?? 0), probs: a.probabilities ?? {}, act, watchOnly: o.watchOnly, trueBest: null, ordered: null }
      session.decisions++; roundScore.decisions++

      // Score the call against the hidden fair prices, but only when a real deal is on.
      if (o.open.length >= 2) {
        const best = o.open.reduce((m, s) => (trueDisc(s) < trueDisc(m) ? s : m))
        if (trueDisc(best) <= -0.05) {
          last.trueBest = best.name
          const mine = o.open.find((s) => s.name === pick)
          const right = mine && trueDisc(mine) <= trueDisc(best) + 0.015
          for (const sc of [session, roundScore]) { sc.calls++; if (right) sc.right++ }
        }
      }

      // The standing order: Jev says spend, and its pick is far enough under its usual price.
      const s = o.open.find((x) => x.name === pick)
      if (s && !o.watchOnly && act >= 0.5 && shownDisc(s) <= -c.minDeal) {
        s.pending = { step, seen: s.price, avg: s.avg }
        last.ordered = { name: s.name, seen: s.price }
      }
      picks.push({ step, buy: pick, conf: last.confidence, act })
      if (picks.length > 300) picks.splice(0, picks.length - 300)
      error = null
      return true
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
      return true
    } finally {
      busy = false
    }
  }

  function frame() {
    const c = cfg()
    const pct = (sc) => (sc.avgSum ? sc.saved / sc.avgSum : 0)
    return {
      type: 'tick', title: c.title, description: c.description, instrument: c.instrument,
      step, round: round + 1, roundTick, roundStart, maxRoundTicks: MAX_ROUND_TICKS,
      tickMs: c.tickMs, vol: c.vol, budget: c.cash, minDeal: c.minDeal, seed: c.seed, products: c.products,
      cash, spent, phase, result,
      streams: streams.map((s) => ({
        name: s.name, base: s.base, price: s.price, avg: s.avg, fair: s.fair, disc: shownDisc(s), trueDisc: trueDisc(s),
        series: s.prices.slice(-SERIES_N), fairSeries: s.fairs.slice(-SERIES_N),
        status: s.pending ? 'pending' : s.locked ? 'locked' : s.price > cash ? 'over' : 'open',
        p: last.probs[s.name] ?? null, flash: s.flashLeft, flashId: s.flashId,
        buys: s.buys.map((b) => ({ id: b.id, step: b.step, price: b.price, saved: b.saved })),
      })),
      jev: last,
      score: { ...session, savedPct: pct(session), accuracy: session.calls ? session.right / session.calls : null },
      roundScore: { ...roundScore, savedPct: pct(roundScore) },
      receipts: receipts.slice(-14), rounds: rounds.slice(-8), bounce,
      // kept for older readers of /state
      lastPick: last.pick, lastConf: last.confidence, lastAct: last.act, committed: receipts.slice(-14), history: picks.slice(-120),
      stateText, running, error, cfgError, overrides,
    }
  }

  function verdict() {
    const c = cfg()
    const problem = cfgError || error
    const sc = session
    const pct = sc.avgSum ? (sc.saved / sc.avgSum) * 100 : 0
    const acc = sc.calls ? Math.round((sc.right / sc.calls) * 100) : null
    const v = {
      spec: 1,
      ready: sc.decisions > 0,
      summary: problem
        ? `Jev Shopper needs a fix: ${problem}`
        : `${c.title} · round ${round + 1} · ${sc.decisions} calls · ${sc.buys} buys · saved ${sc.saved >= 0 ? '' : '-'}$${Math.abs(sc.saved).toFixed(0)} (${pct.toFixed(1)}%) against the usual price${acc === null ? '' : ` · ${acc}% of deal calls right`}`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'shopper', message: problem }] : []),
        ...(sc.buys >= 6 && pct < 3 ? [{ severity: 'warning', kind: 'shopper', message: `At price noise ${c.vol.toFixed(2)} Jev's buys save only ${pct.toFixed(1)}% against the usual price: wobbles are passing for deals.` }] : []),
        ...receipts.slice(-3).map((b) => ({ severity: 'info', kind: 'buy', message: `Round ${b.round}: bought ${b.name} at ${b.price.toFixed(2)} (usual ${b.avg.toFixed(2)})` })),
        { severity: 'info', kind: 'run', message: `${streams.length} made-up products, price noise ${c.vol.toFixed(2)}, ${c.tickMs} ms per tick, budget ${c.cash.toFixed(0)}, deal bar ${(c.minDeal * 100).toFixed(0)}%` },
      ],
      artifact: MARKER,
      phases: [
        { id: 'watch', name: 'Watching prices', state: sc.decisions < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Calling the best buy', state: sc.decisions >= 5 ? 'active' : 'pending' },
        { id: 'buy', name: 'Buying on paper', state: sc.buys > 0 ? 'active' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
  }

  function push(force = false) {
    const now = Date.now()
    if (force || now - lastVerdictAt > 1000) { lastVerdictAt = now; try { verdict() } catch (e) { error = clean(e.message) } }
    if (!clients.size) return
    const line = `event: state\ndata: ${JSON.stringify(frame())}\n\n`
    for (const c of clients) c.write(line)
  }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().tickMs) }
  async function run() {
    const t0 = Date.now()
    await decide(); push()
    if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().tickMs - (Date.now() - t0)))
  }

  async function control(cmd, body) {
    const c = cfg()
    let reply = {}
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') { resetAll(); if (running) schedule() }
    else if (cmd === 'tick') {
      const n = Math.round(clampN(body.n, 1, 20000, 1))
      for (let done = 0; done < n && !stopped;) { if (await decide()) done++; else await sleep(1) }
    } else if (cmd === 'set') {
      const allowed = { vol: [0, 0.5], tickMs: [60, 5000], cash: [20, 5000], minDeal: [0.01, 0.4] }
      const range = allowed[body.key]
      if (range) {
        overrides = { ...overrides, [body.key]: clampN(body.value, range[0], range[1], c[body.key]) }
        if (body.key === 'cash') cash = Math.max(0, cfg().cash - spent) // the budget moved: so does what is left
        if (body.key === 'tickMs' && running) schedule()
      } else reply = { applied: false, why: 'unknown key' }
    } else if (cmd === 'flash') {
      const s = streams.find((x) => x.name === body.name)
      if (s && phase === 'shopping') flashSale(s)
      else reply = { applied: false, why: s ? 'round is over' : 'no such product' }
    } else if (cmd === 'add') {
      const have = new Set(c.products.map((p) => p.name.toLowerCase()))
      const next = POOL.find((p) => !have.has(p.name.toLowerCase()))
      if (next && c.products.length < MAX_PRODUCTS) { overrides = { ...overrides, products: [...c.products, { ...next, drift: 0 }] }; syncStreams(); reply = { added: next.name } }
      else reply = { applied: false, why: `the board holds at most ${MAX_PRODUCTS} products` }
    } else if (cmd === 'remove') {
      if (c.products.length > 2 && c.products.some((p) => p.name === body.name)) { overrides = { ...overrides, products: c.products.filter((p) => p.name !== body.name) }; syncStreams() }
      else reply = { applied: false, why: 'the board needs at least 2 products' }
    } else reply = { applied: false, why: 'unknown command' }
    if (phase === 'shopping') stateText = observe(cfg(), streams, cash).text
    push(true)
    return { step, ...reply }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    // Loopback only: a page on another origin (DNS rebinding) must not reach this server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    try {
      if (req.method === 'GET') {
        const name = path === '/' ? 'index.html' : path.slice(1)
        if (FILES.has(name)) { res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' }); return res.end(readFileSync(join(HERE, name))) }
        if (path === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(frame())) }
        if (path === '/jev') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(jevSnapshot())) }
        if (path === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
          res.write(`event: state\ndata: ${JSON.stringify(frame())}\n\n`)
          clients.add(res)
          req.on('close', () => clients.delete(res))
          return
        }
      }
      if (req.method === 'POST' && path === '/control') {
        let body = ''
        for await (const chunk of req) { body += chunk; if (body.length > 65536) { res.writeHead(413); return res.end('Too large') } }
        let j
        try { j = JSON.parse(body || '{}') } catch { res.writeHead(400); return res.end('Bad JSON') }
        if (!j || typeof j !== 'object') { res.writeHead(400); return res.end('Bad JSON') }
        const reply = await control(String(j.cmd ?? ''), j)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, ...reply }))
      }
      res.writeHead(404); res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: clean(e?.message ?? e) }))
    }
  })

  loadCfg()
  resetAll()

  // Watch the folder, not the file: editors that save by rename would drop a file watch.
  let watcher = null
  try {
    watcher = watch(workspace, (_, name) => {
      if (name && String(name) !== MARKER) return
      clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        if (stopped) return
        const before = JSON.stringify(fileCfg)
        loadCfg()
        if (!cfgError && JSON.stringify(fileCfg) !== before) { resetAll(); if (running) schedule() } // a good edit clears the overrides and starts fresh
        push(true)
      }, 40)
    })
  } catch { /* the defaults stand */ }

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  push(true)
  running = true
  schedule()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      stopped = true; running = false; clearTimeout(timer); clearTimeout(watchTimer); watcher?.close()
      for (const c of clients) c.end()
      server.closeAllConnections(); await new Promise((r) => server.close(r))
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startShopperViewer({ workspace, port })
  console.log(`Jev Shopper listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
