// Jev Trader viewer — a loopback server where Jev (TypeSafe's System One model) runs a PAPER
// trading desk on a SYNTHETIC market. One candle per day. Every day the tape and the account are
// written out as text and Jev answers five typed questions in one call: buy, hold or sell, how
// strongly, is it sure, what the trend is, and is this a crash. The desk turns the answers into a
// paper trade. A "year" of made-up days ends, the books close for about three seconds, then a new
// year starts with a new seed. Nothing here is real money and nothing here is financial advice.
//
// The chat agent edits market.json. The pane lets a person inject a crash or a rally, send the desk
// to cash, and move the noise, the fee and the speed.
//
// Harness env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE. Workspace holds market.json (watched live).

import { createServer } from 'node:http'
import { watch, readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, jev, snapshot as jevSnapshot } from '../toolchain/jev.mjs'
import { DEFAULT, sanitize, createEpisode, stepMarket, observe, applyDecision, flatten, injectShock, equity, invested } from './sim.mjs'
import { traderMock } from './mock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const clean = (v) => String(v ?? '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000)
const clampN = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
const FILES = new Set(['index.html', 'base.css', 'studio.css', 'studio.js', 'jev-hud.js'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const SETTABLE = { volatility: [0, 0.2], fee: [0, 0.05], stepMs: [60, 20000] }

export async function startTraderViewer({ workspace, port = 0 } = {}) {
  workspace = resolve(workspace)
  mkdirSync(join(workspace, '.harness'), { recursive: true })
  const marketFile = join(workspace, 'market.json')

  // Every binding is declared before anything can call into the closures below.
  let fileCfg = { ...DEFAULT }
  let cfgError = null
  let overrides = {}
  let world = null
  let episode = 0
  let stopped = false, running = false, busy = false
  let timer = null, watchTimer = null, salt = 1, lastVerdictAt = 0
  let error = null
  let stateText = ''
  let history = [] // one row per decision, newest last
  let last = { action: 'HOLD', probs: { BUY: 0.2, HOLD: 0.6, SELL: 0.2 }, confidence: 0, conviction: 1, convictionProbs: {}, pConfident: 0.5, regime: 'sideways', regimeProbs: {}, pCrash: 0, shares: 0, side: null, why: '' }
  const clients = new Set()
  const session = { episodes: 0, beats: 0, sumEdge: 0, sumRet: 0, sumBh: 0, days: 0, trades: 0, fees: 0, rightDays: 0, regimeDays: 0, results: [] }

  function loadCfg() {
    try { fileCfg = { ...DEFAULT, ...JSON.parse(readFileSync(marketFile, 'utf8')) }; cfgError = null }
    catch (e) { cfgError = existsSync(marketFile) ? clean(`market.json: ${e.message}`) : null } // keep the last good config
  }
  const cfg = () => sanitize({ ...fileCfg, ...overrides })

  function newEpisode() {
    world = createEpisode(cfg(), episode)
    stateText = observe(world, cfg())
    history = []
  }

  function frame() {
    const c = cfg()
    const e = equity(world)
    return {
      type: 'tick', title: c.title, description: c.description, instrument: c.instrument,
      episode: world.episode, day: world.day, episodeDays: c.episodeDays, stepMs: c.stepMs,
      price: world.price, cash: world.cash, holdings: world.holdings, equity: e, capital: world.capital,
      invested: invested(world), drawdown: world.drawdown, maxDD: world.maxDD, fees: world.fees, nTrades: world.nTrades,
      ret: (e - world.capital) / world.capital, bhRet: world.price / world.startPrice - 1,
      right: world.regimeDays ? world.rightDays / world.regimeDays : null,
      candles: world.candles, eq: world.eq, bh: world.bh,
      trades: world.trades.filter((t) => t.d >= world.candles[0].d), events: world.events.filter((v) => v.d >= world.candles[0].d),
      shock: world.shock ? { kind: world.shock.kind, left: world.shock.left } : null,
      last, status: world.status, result: world.result,
      session: { ...session, results: session.results.slice(-8) },
      volatility: c.volatility, fee: c.fee, trend: c.trend, drift: c.drift, overrides,
      running, error, cfgError, stateText,
      history: history.slice(-120),
    }
  }

  function verdict() {
    const c = cfg()
    const problem = cfgError || error
    const e = equity(world)
    const ret = ((e - world.capital) / world.capital) * 100, bh = (world.price / world.startPrice - 1) * 100
    const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
    const right = session.regimeDays + world.regimeDays ? Math.round(((session.rightDays + world.rightDays) / (session.regimeDays + world.regimeDays)) * 100) : 0
    const v = {
      spec: 1,
      ready: world.day > 0 || session.episodes > 0,
      summary: problem
        ? `Jev Trader needs a fix: ${problem}`
        : world.day === 0 && !session.episodes
          ? `${c.title} · waiting for the first day`
          : `${c.title} · paper year ${world.episode + 1}, day ${world.day} · Jev ${pct(ret)} vs buy-and-hold ${pct(bh)} · right side of the trend ${right}% of days · ${last.action}`,
      findings: [
        ...(problem ? [{ severity: 'error', kind: 'market', message: problem }] : []),
        ...(session.episodes >= 2 && session.sumEdge < 0 ? [{ severity: 'warning', kind: 'trader', message: `Over ${session.episodes} paper years Jev trails buy-and-hold by ${(-session.sumEdge / session.episodes * 100).toFixed(1)} points a year. At volatility ${c.volatility} the trend is hard to read off the tape.` }] : []),
        ...(world.fees > world.capital * 0.03 ? [{ severity: 'warning', kind: 'trader', message: `Fees have eaten ${(world.fees / world.capital * 100).toFixed(1)}% of the capital this year (${world.nTrades} trades at ${(c.fee * 100).toFixed(2)}%). The desk is churning.` }] : []),
        { severity: 'info', kind: 'run', message: `Synthetic market, paper money. volatility ${c.volatility}, trend ${c.trend}, fee ${(c.fee * 100).toFixed(2)}%, ${c.stepMs} ms per day. Not financial advice.` },
      ],
      artifact: 'market.json',
      phases: [
        { id: 'open', name: 'Market open', state: 'done' },
        { id: 'trade', name: 'Trading', state: world.day > 0 || session.episodes > 0 ? 'active' : 'pending' },
        { id: 'close', name: 'Years closed', state: session.episodes > 0 ? 'done' : 'pending' },
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
    const line = `event: state\ndata: ${JSON.stringify(frame())}\n\n`
    for (const c of clients) c.write(line)
  }

  function settle() {
    const r = world.result
    session.episodes++; if (r.edge > 0) session.beats++
    session.sumEdge += r.edge; session.sumRet += r.ret; session.sumBh += r.bh
    session.days += world.day; session.trades += world.nTrades; session.fees += world.fees
    session.rightDays += world.rightDays; session.regimeDays += world.regimeDays
    session.results.push({ episode: world.episode, ret: r.ret, bh: r.bh, edge: r.edge, right: r.right })
    if (session.results.length > 40) session.results.shift()
  }

  async function decide() {
    if (busy || stopped) return
    busy = true
    try {
      const c = cfg()
      if (world.status === 'done') {
        // The books are closed. Show the result for about three seconds, then open a new year.
        world.rest++
        if (world.rest * c.stepMs >= 3000) { episode++; newEpisode() }
        return
      }
      stepMarket(world, c) // the market moves, then Jev reads the new close
      stateText = observe(world, c)
      const res = await evaluate({
        state: stateText,
        questions: {
          action: jev.choice({ BUY: 'the price is trending up: add shares', HOLD: 'no clear edge today: do nothing', SELL: 'the price is trending down: cut shares' }, 'What does the desk do today?'),
          conviction: jev.score(['weak', 'moderate', 'strong'], 'How strong is the signal on the tape?'),
          confident: jev.noul('Is this a clear call rather than a guess?'),
          regime: jev.choice({ uptrend: 'prices have been rising for weeks', downtrend: 'prices have been falling for weeks', sideways: 'no lasting direction' }, 'What is the market doing?'),
          crash: jev.noul('Is a sharp sell-off under way right now?'),
        },
        salt: salt++, model: process.env.JEV_MODEL || 'jev-latest', mock: traderMock,
      })
      const a = res.answers.action ?? {}
      const action = ['BUY', 'HOLD', 'SELL'].includes(String(a.choice).toUpperCase()) ? String(a.choice).toUpperCase() : 'HOLD'
      const conviction = clampN(res.answers.conviction?.score, 0, 2, 1)
      const pCrash = clampN(res.answers.crash?.noul, 0, 1, 0)
      const trade = applyDecision(world, c, { action, conviction, crash: pCrash })
      last = {
        action, probs: { BUY: 0, HOLD: 0, SELL: 0, ...(a.probabilities ?? {}) }, confidence: clampN(a.confidence, 0, 1, 0),
        conviction, convictionProbs: res.answers.conviction?.probabilities ?? {}, pConfident: clampN(res.answers.confident?.noul, 0, 1, 0.5),
        regime: String(res.answers.regime?.choice ?? 'sideways'), regimeProbs: res.answers.regime?.probabilities ?? {}, pCrash,
        shares: trade?.sh ?? 0, side: trade?.side ?? null, why: trade?.why ?? '', client: res.client,
      }
      history.push({ day: world.day, price: world.price, action, shares: trade?.sh ?? 0, side: trade?.side ?? null, cash: world.cash, holdings: world.holdings, equity: equity(world), confidence: last.confidence, conviction, client: res.client })
      if (history.length > 400) history.splice(0, history.length - 400)
      if (world.status === 'done') settle()
      error = null
    } catch (e) {
      error = clean(e?.message ?? e?.name ?? String(e))
    } finally {
      busy = false
    }
  }

  function schedule() { clearTimeout(timer); if (running && !stopped) timer = setTimeout(run, cfg().stepMs) }
  async function run() { const t0 = Date.now(); await decide(); push(); if (running && !stopped) timer = setTimeout(run, Math.max(0, cfg().stepMs - (Date.now() - t0))) }

  async function control(cmd, body) {
    if (cmd === 'pause') { running = false; clearTimeout(timer) }
    else if (cmd === 'start') { if (!running) { running = true; schedule() } }
    else if (cmd === 'reset') {
      Object.assign(session, { episodes: 0, beats: 0, sumEdge: 0, sumRet: 0, sumBh: 0, days: 0, trades: 0, fees: 0, rightDays: 0, regimeDays: 0, results: [] })
      overrides = {}; episode = 0; salt = 1; error = null; newEpisode()
    }
    else if (cmd === 'tick') { const n = Math.round(clampN(body.n, 1, 20000, 1)); for (let i = 0; i < n; i++) await decide() }
    else if (cmd === 'shock') injectShock(world, body.kind === 'rally' ? 'rally' : 'crash')
    else if (cmd === 'flatten') flatten(world, cfg())
    else if (cmd === 'set') {
      const range = SETTABLE[body.key]
      if (range) overrides = { ...overrides, [body.key]: clampN(body.value, range[0], range[1], cfg()[body.key]) }
    }
    push(true)
    return { day: world.day, episode: world.episode }
  }

  loadCfg()
  newEpisode()

  // An edit to market.json wins over the sliders. The year restarts only when its shape changed.
  let watcher = null
  try {
    watcher = watch(workspace, (_, name) => {
      if (name && String(name) !== 'market.json') return
      clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        const before = cfg()
        loadCfg()
        if (!cfgError) {
          overrides = {}
          const after = cfg()
          if (['startPrice', 'capital', 'seed', 'episodeDays'].some((k) => before[k] !== after[k])) { episode = 0; newEpisode() }
        }
        push(true)
        schedule()
      }, 40)
    })
  } catch { /* the defaults stand */ }

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    // Loopback only: a page on another origin (DNS rebinding) must not reach this server.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) { res.writeHead(403); return res.end('Loopback only') }
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
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
        const reply = await control(String(j?.cmd ?? ''), j && typeof j === 'object' ? j : {})
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, ...reply }))
      }
      res.writeHead(404); res.end('Not found')
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: clean(e?.message ?? e) }))
    }
  })

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
  const viewer = await startTraderViewer({ workspace, port })
  console.log(`Jev Trader listening on ${viewer.url}`)
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => viewer.close().then(() => process.exit(0)))
}
