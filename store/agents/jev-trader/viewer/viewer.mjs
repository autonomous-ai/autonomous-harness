// Jev Trader viewer — a loopback server running a paper-trading simulator where Jev (TypeSafe's
// System One model) is the trader. A synthetic market ticks every `market.stepMs`; Jev reads the
// recent price tape + its portfolio and decides buy / hold / sell, with a confidence. The viewer
// applies the trade, advances the market, and streams the price tape + equity curve to the pane.
// The agent shapes market.json (instrument, volatility, starting capital, style). The strategy is
// Jev's; the results are honest paper-trading P&L.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds market.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, snapshot as jevSnapshot } from '../toolchain/jev.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)

const DEFAULT_MARKET = {
  title: 'Jev’s Desk',
  description: 'A paper account run by a System One decision model.',
  instrument: 'SYNTH',
  startPrice: 100,
  volatility: 0.012,       // per-step stdev of returns
  drift: 0.0003,           // small upward bias so flat motion still has signal
  stepMs: 900,
  capital: 10000,
  style: 'Buy the trend, cut losses, keep some cash. You are a fast, disciplined trader.',
}

// Deterministic PRNG seeded per run so the market is reproducible within a session.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function stateBlock(market, prices, holdings, cash, equity) {
  const tape = prices.slice(-10).map((p, i) => `day ${i + prices.length - 9}: ${p.toFixed(2)}`).join('\n')
  return `You are a paper-trading decision model on a synthetic market.
Instrument: ${market.instrument}. Style: ${market.style}
Starting capital: $${market.capital}. Current cash: $${cash.toFixed(2)}; holdings: ${holdings} shares; equity: $${equity.toFixed(2)}.

Recent price tape (last 10 days):
${tape}

Decide this period's action: BUY (add shares), HOLD (do nothing), or SELL (reduce shares). Respond with the action and
how confident you are. You see only this tape and your own P&L.`
}

export async function startTraderViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })

  let market = readMarket(join(workspace, 'market.json'))
  let rng = mulberry32(1337)
  let prices = [market.startPrice]
  let price = market.startPrice
  let cash = market.capital
  let holdings = 0
  let clients = new Set()
  let stopped = false
  let salt = 1
  let running = false
  let error = null
  let history = []      // [{day, price, action, shares, cash, equity, confidence, at}]
  let day = 0

  function readMarket(file) {
    try { return { ...DEFAULT_MARKET, ...JSON.parse(readFileSync(file, 'utf8')) } }
    catch { return DEFAULT_MARKET }
  }

  function equityAt(p) { return cash + holdings * p }
  function equity() { return equityAt(price) }

  function broadcast(obj) {
    const line = `event: state\ndata: ${JSON.stringify(obj)}\n\n`
    for (const c of clients) c.write(line)
  }

  function tail() {
    const v = verdict(market, history, equity(), { error })
    const file = join(workspace, '.harness/verdict.json')
    writeFileSync(file + '.tmp', JSON.stringify(v))
    renameSync(file + '.tmp', file)
    broadcast({
      type: 'tick',
      title: market.title,
      description: market.description,
      instrument: market.instrument,
      price,
      cash,
      holdings,
      equity: equity(),
      running,
      error,
      day,
      history: history.slice(-120),
    })
  }

  function advanceMarket() {
    const ret = (rng() - 0.5) * 2 * market.volatility + market.drift
    price = Math.max(0.01, price * (1 + ret))
    prices.push(price)
    day++
    return price
  }

  async function decide() {
    if (stopped) return
    try {
      advanceMarket()               // the market moves even before Jev acts this period
      const res = await evaluate({
        state: stateBlock(market, prices, holdings, cash, equity()),
        questions: {
          action: {
            type: 'choice',
            instructions: 'Choose this period\'s action: BUY, HOLD, or SELL.',
            options: ['BUY', 'HOLD', 'SELL'],
          },
          confident: {
            type: 'noul',
            instructions: 'Are you confident in this action, or guessing?',
          },
          conviction: {
            type: 'score',
            instructions: 'How strongly do you believe in this position?',
            legend: { 0: 'weak', 1: 'moderate', 2: 'strong' },
          },
        },
        salt: salt++,
        model: process.env.JEV_MODEL || 'jev-latest',
      })
      const action = String(res.answers.action?.choice || 'HOLD').toUpperCase()
      const confidence = typeof res.answers.confident?.noul === 'number' ? res.answers.confident.noul : 0.5
      const conviction = typeof res.answers.conviction?.score === 'number' ? res.answers.conviction.score : 1
      // Execute a plausible trade size (~10% of equity per BUY/SELL, scaled by conviction).
      const target = Math.floor((equity() * 0.1 * (conviction + 0.5)) / price)
      let execShares = 0
      if (action === 'BUY' && target > 0 && cash >= target * price) {
        cash -= target * price; holdings += target; execShares = target
      } else if (action === 'SELL' && holdings > 0) {
        const sell = Math.min(holdings, Math.max(1, target || Math.floor(holdings * 0.5)))
        cash += sell * price; holdings -= sell; execShares = sell
      }
      history.push({ day, price, action, shares: execShares, cash, holdings, equity: equity(), confidence, conviction, at: new Date().toISOString(), client: res.client })
      if (history.length > 400) history.splice(0, history.length - 400)
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    }
    tail()
  }

  let timer = null
  function schedule() { clearTimeout(timer); timer = setTimeout(run, market.stepMs) }
  async function run() { if (stopped) return; await decide(); schedule() }
  function start() { if (!running) { running = true; schedule() } }
  function pause() { running = false; clearTimeout(timer) }
  function reset() {
    rng = mulberry32(1337); price = market.startPrice; prices = [price]; cash = market.capital; holdings = 0; day = 0; history = []; salt += 10; error = null
    tail()
    if (running) schedule()
  }

  const watcher = watch(workspace, { recursive: true }, (_, name) => {
    if (!name) return
    if (String(name).split('/').join('/') === 'market.json') {
      market = readMarket(join(workspace, 'market.json'))
      tail()
      if (running) schedule()
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
    if (req.method === 'GET' && url.pathname === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: market.title, instrument: market.instrument, price, cash, holdings, equity: equity(), running, day, history: history.slice(-120) })) }
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
  tail()
  start()

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() { stopped = true; clearTimeout(timer); watcher.close(); for (const c of clients) c.end(); server.closeAllConnections(); await new Promise((r) => server.close(r)) },
  }
}

function verdict(market, history, equity, state) {
  const start = market.capital
  const ret = start ? ((equity - start) / start) * 100 : 0
  const last = history[history.length - 1]
  return {
    spec: 1,
    ready: history.length > 0,
    summary: state.error
      ? 'Jev Trader needs a fix'
      : last
        ? `${market.title || market.instrument} · $${equity.toFixed(0)} (${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%) · ${last.action} · day ${last.day}`
        : `${market.title || market.instrument} · waiting for the first tick`,
    findings: (state.error ? [{ severity: 'error', kind: 'trader', message: state.error }] : []).concat(
      ret < -20 ? [{ severity: 'warn', kind: 'trader', message: `Portfolio down ${ret.toFixed(1)}% — Jev may be overtrading a driftless market` }] : []
    ),
    artifact: 'market.json',
    phases: [
      { id: 'warm', name: 'Warm-up', state: history.length < 10 ? 'active' : 'done' },
      { id: 'trade', name: 'Trading', state: history.length >= 10 ? 'active' : 'pending' },
    ],
    updatedAt: new Date().toISOString(),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.env.HARNESS_WORKSPACE
  const port = Number(process.env.HARNESS_VIEWER_PORT)
  if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HARNESS_WORKSPACE and HARNESS_VIEWER_PORT are required')
  const viewer = await startTraderViewer({ workspace, port })
  console.log(`Jev Trader listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
