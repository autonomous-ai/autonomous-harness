// Jev Shopper viewer — a loopback server running a live price-tracking demo. A few products stream
// price ticks; Jev (TypeSafe's System One model) reads the stream and, every tick, decides which
// product is the best buy right now (and how urgent it is). The agent shapes shopper.json (the
// products, their price ranges, how fast they tick) — turn the volatility up and watch Jev's calls
// start to flip. The market is synthetic; the decision loop is the demo.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds shopper.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT = {
  title: 'Jev Shopper',
  description: 'Jev watches prices stream in and calls the best buy, live.',
  instrument: 'SHOPPER',
  tickMs: 500, vol: 0.08, cash: 100,
  products: [
    { name: 'Espresso Machine', price: 240, drift: 0.02 },
    { name: 'Hiking Boots', price: 120, drift: -0.05 },
    { name: 'Noise Cancellers', price: 180, drift: 0.01 },
    { name: 'Desk Lamp', price: 45, drift: -0.03 },
  ],
  style: 'Watch the recent price stream and pick the product whose price is most likely still falling — the best value right now. Be decisive.',
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Manufacture a plausible synthetic price stream line so Jev (and the mock reader) can see momentum.
function streamLine(product, prices, vol) {
  const recent = prices.slice(-6)
  const chgPct = (recent.length >= 2) ? ((recent[recent.length - 1] - recent[0]) / recent[0] * 100) : 0
  const last = recent[recent.length - 1]
  const spark = recent.map((p) => p.toFixed(0)).join(' ')
  return `${product.name}: ${last.toFixed(2)}  (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(1)}% over ${recent.length} ticks)  vol ${(vol * 100).toFixed(0)}%  [${spark}]`
}

function stateBlock(p, streams, cash) {
  const lines = streams.map((s) => streamLine(s.product, s.prices, p.vol)).join('\n')
  return `${p.style}
You have ${cash.toFixed(0)} to spend. Prices tick live:
${lines}
Which single product is the best buy to act on right now?`
}

export async function startShopperViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let error = null
  let clients = new Set()
  let stopped = false
  let salt = 1
  let step = 0
  let running = false
  let cash = (DEFAULT.cash ?? 100)
  let picks = []        // per-decision {step, buy, conf, act}
  let lastPick = '—'
  let lastConf = 0.5
  let lastAct = 0.5
  let committed = []    // {name, cash, price} after an "act now"
  let notified = false  // a buy was committed this window

  // read the config file, merging over defaults; also handles a changed product list
  let p = readCfg(join(workspace, 'shopper.json'))
  let rng = mulberry32(616)
  let streams = (p.products || []).map((prod) => ({ product: prod, prices: [prod.price], drift: prod.drift ?? 0 }))

  function readCfg(file) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return { ...DEFAULT, ...raw }
    } catch (e) {
      error = clean(e.message)
      return p || DEFAULT
    }
  }

  function resetState() {
    streams = (p.products || []).map((prod) => ({ product: prod, prices: [prod.price], drift: prod.drift ?? 0 }))
    cash = p.cash ?? 100
    picks = []; committed = []; notified = false; step = 0
    lastPick = '—'; lastConf = 0.5; lastAct = 0.5
  }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function verdict() {
    const best = picks.reduce((a, b) => (b.conf > a.conf ? b : a), { conf: 0 })
    return {
      spec: 1,
      ready: picks.length > 0,
      summary: error
        ? 'Jev Shopper needs a fix'
        : notified && committed.length
          ? `${p.title} · bought ${committed[committed.length - 1].name} for ${committed[committed.length - 1].price.toFixed(0)} · ${picks.length} ticks watched`
          : `${p.title} · watching ${streams.length} products · ${picks.length} ticks · best pick ${best.buy || '—'} at ${(best.conf * 100).toFixed(0)}%`,
      findings: (error ? [{ severity: 'error', kind: 'shopper', message: error }] : []).concat(
        notified ? [{ severity: 'info', kind: 'shopper', message: `Jev decided to buy ${committed[committed.length - 1].name} at ${committed[committed.length - 1].price.toFixed(0)}` }] : []
      ),
      artifact: 'shopper.json',
      phases: [
        { id: 'learn', name: 'Watching', state: picks.length < 5 ? 'active' : 'done' },
        { id: 'call', name: 'Calling buys', state: picks.length >= 5 && !notified ? 'active' : notified ? 'done' : 'pending' },
        { id: 'commit', name: 'Committed', state: notified ? 'active' : 'pending' },
      ],
      updatedAt: new Date().toISOString(),
    }
  }

  function tail() {
    const v = verdict()
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
    broadcast({
      type: 'tick', title: p.title, description: p.description, instrument: p.instrument,
      streams: streams.map((s) => ({ name: s.product.name, price: s.prices[s.prices.length - 1], series: s.prices.slice(-40) })),
      cash, step, running, error, lastPick, lastConf, lastAct, committed,
      history: picks.slice(-120),
    })
  }

  function reset() { resetState(); tail(); if (running) schedule() }
  function pause() { running = false; clearTimeout(timer) }
  function start() { if (!running) { running = true; schedule() } }
  let timer = null
  function schedule() { clearTimeout(timer); timer = setTimeout(run, p.tickMs) }
  async function run() { if (stopped) return; await decide(); schedule() }

  function tickPrices() {
    for (const s of streams) {
      const last = s.prices[s.prices.length - 1]
      const drift = s.drift ?? 0
      const shock = (rng() - 0.5) * 2 * (p.vol ?? 0.08)
      const next = Math.max(1, last * (1 + drift + shock))
      s.prices.push(next)
      if (s.prices.length > 40) s.prices.shift()
    }
    step++
  }

  async function decide() {
    if (stopped) return
    try {
      tickPrices()
      const res = await evaluate({
        state: stateBlock(p, streams, cash),
        questions: {
          buy: { type: 'choice', instructions: 'Which product is the best buy to act on right now?', options: streams.map((s) => s.product.name) },
          act: { type: 'noul', instructions: 'Is this a strong enough signal to spend now?' },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      lastPick = String(res.answers.buy?.choice || '—')
      lastConf = typeof res.answers.buy?.confidence === 'number' ? res.answers.buy.confidence : 0.5
      lastAct = typeof res.answers.act?.noul === 'number' ? res.answers.act.noul : 0.5
      picks.push({ step, buy: lastPick, conf: lastConf, act: lastAct })
      if (picks.length > 300) picks.splice(0, picks.length - 300)
      if (lastAct >= 0.8 && cash > 0 && lastPick !== '—' && !notified) {
        const sold = streams.find((s) => s.product.name === lastPick)
        if (sold) {
          const price = sold.prices[sold.prices.length - 1]
          committed.push({ name: lastPick, cash: cash, price })
          cash = 0
          notified = true
        }
      }
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
    tail()
  }

  const watcher = watch(join(workspace, 'shopper.json'), () => {
    p = readCfg(join(workspace, 'shopper.json'))
    tail()
    if (running) schedule()
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
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: p.title, instrument: p.instrument, streams: streams.map((s) => ({ name: s.product.name, price: s.prices[s.prices.length - 1], series: s.prices.slice(-40) })), cash, step, running, error, lastPick, lastConf, lastAct, committed, history: picks.slice(-120) })) }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'POST' && url.pathname === '/control') {
      let body = ''
      for await (const c of req) { body += c; if (body.length > 1024) break }
      const cmd = JSON.parse(body || '{}').cmd
      if (cmd === 'pause') pause()
      if (cmd === 'start') start()
      if (cmd === 'reset') reset()
      if (cmd === 'tick') await decide()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    }
    res.writeHead(404); res.end('Not found')
  })

  await new Promise((resolveP, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveP) })
  resetState()
  tail()
  start()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { stopped = true; clearTimeout(timer); watcher.close(); for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((r) => server.close(r)) },
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
