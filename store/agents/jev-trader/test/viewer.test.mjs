// Viewer integration tests for Jev Trader. They spin up the real viewer against a temp workspace
// and drive time with the `tick` control, so nothing here waits on the trading clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const MARKET = {
  title: 'Test Desk', instrument: 'TEST', startPrice: 100, volatility: 0.012, drift: 0.0003, stepMs: 120, capital: 10000,
  style: 'Buy the trend, cut losses.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-trader-test-'))
  writeFileSync(join(ws, 'market.json'), JSON.stringify({ ...MARKET, ...overrides }))
  const { startTraderViewer } = await import(viewerPath)
  const viewer = await startTraderViewer({ workspace: ws, port: 0 })
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  const ctl = (body) => fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { ws, viewer, state, ctl }
}

/** A paused desk at day 0, so `tick` alone moves time. */
async function pausedViewer(overrides = {}) {
  const v = await freshViewer(overrides)
  await v.ctl({ cmd: 'pause' })
  await v.ctl({ cmd: 'reset' })
  return v
}

async function until(fn, ms = 4000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await wait(40) }
  return null
}

test('Jev Trader ticks the market and trades', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const state = async () => (await (await fetch(`http://127.0.0.1:${port}/state`)).json())
    const deadline = Date.now() + 3000
    let days = 0
    while (Date.now() < deadline && days < 3) {
      await wait(150)
      const s = await state()
      days = s.day
      if (s.history.length) assert.ok(typeof s.equity === 'number')
    }
    assert.ok(days >= 3, `expected at least 3 ticks; got ${days}`)
  } finally {
    await viewer.close()
  }
})

test('Jev Trader writes a progressive verdict with a summary', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) { await wait(150); if (existsSync(join(ws, '.harness/verdict.json'))) break }
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.equal(v.spec, 1)
    assert.ok(v.summary)
    assert.ok(Array.isArray(v.findings))
    assert.ok(Array.isArray(v.phases))
  } finally {
    await viewer.close()
  }
})

test('Jev Trader control commands answer 200', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const ctl = async (cmd) => {
      const res = await fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd }) })
      return res.status
    }
    assert.equal(await ctl('pause'), 200)
    assert.equal(await ctl('tick'), 200)
    assert.equal(await ctl('start'), 200)
    assert.equal(await ctl('reset'), 200)
    for (const cmd of ['shock', 'flatten', 'set', 'no-such-command']) assert.equal(await ctl(cmd), 200)
  } finally {
    await viewer.close()
  }
})

test('a non-default market.json really shows up in /state', async () => {
  const { viewer, state } = await pausedViewer({ instrument: 'ZZTOP', volatility: 0.031, fee: 0.004, capital: 5000, episodeDays: 90, trend: 0.006, title: 'Odd Desk' })
  try {
    const s = await state()
    assert.equal(s.instrument, 'ZZTOP')
    assert.equal(s.title, 'Odd Desk')
    assert.equal(s.volatility, 0.031)
    assert.equal(s.fee, 0.004)
    assert.equal(s.trend, 0.006)
    assert.equal(s.capital, 5000)
    assert.equal(s.equity, 5000)
    assert.equal(s.episodeDays, 90)
    assert.match(s.stateText, /Instrument: ZZTOP/)
    assert.match(s.stateText, /Fee per trade: 0\.40%/)
  } finally {
    await viewer.close()
  }
})

test('tick advances exactly n days and the frame carries Jev\'s probabilities', async () => {
  const { viewer, state, ctl } = await pausedViewer()
  try {
    const r = await (await ctl({ cmd: 'tick', n: 40 })).json()
    assert.equal(r.day, 40)
    const s = await state()
    assert.equal(s.day, 40)
    assert.equal(s.history.length, 40)
    assert.ok(['BUY', 'HOLD', 'SELL'].includes(s.last.action))
    const sum = s.last.probs.BUY + s.last.probs.HOLD + s.last.probs.SELL
    assert.ok(Math.abs(sum - 1) < 1e-6, `probabilities sum to ${sum}`)
    assert.ok(s.last.confidence > 0.3 && s.last.confidence < 1, 'never exactly one-hot')
    assert.ok(s.last.pCrash >= 0 && s.last.pCrash <= 1)
    assert.ok(s.candles.length > 100 && s.candles.at(-1).d === 40, 'the chart is pre-filled and ends today')
    assert.equal(s.eq.length, 41)
    assert.ok(Math.abs(s.cash + s.holdings * s.price - s.equity) < 1e-6, 'the books balance')
  } finally {
    await viewer.close()
  }
})

test('a crash shock drives the price down and a rally drives it up, against the same seed', async () => {
  const a = await pausedViewer(), b = await pausedViewer(), c = await pausedViewer()
  try {
    for (const v of [a, b, c]) await v.ctl({ cmd: 'tick', n: 30 })
    await b.ctl({ cmd: 'shock', kind: 'crash' })
    await c.ctl({ cmd: 'shock', kind: 'rally' })
    assert.deepEqual((await b.state()).shock, { kind: 'crash', left: 4 })
    for (const v of [a, b, c]) await v.ctl({ cmd: 'tick', n: 4 })
    const [sa, sb, sc] = [await a.state(), await b.state(), await c.state()]
    assert.ok(sb.price < sa.price * 0.88, `crash ${sb.price.toFixed(2)} vs calm ${sa.price.toFixed(2)}`)
    assert.ok(sc.price > sa.price * 1.12, `rally ${sc.price.toFixed(2)} vs calm ${sa.price.toFixed(2)}`)
    assert.equal(sb.shock, null, 'the shock is over after four days')
    assert.equal(sb.events.at(-1).kind, 'crash')
    assert.equal(sb.candles.filter((k) => k.s === -1).length, 4)
  } finally {
    for (const v of [a, b, c]) await v.viewer.close()
  }
})

test('Jev gets out of a crash: it holds less stock after one than the calm twin', async () => {
  const a = await pausedViewer({ volatility: 0.006, seed: 11 }), b = await pausedViewer({ volatility: 0.006, seed: 11 })
  try {
    // Walk both desks to a day where Jev is well invested.
    let day = 0
    for (; day < 200; day++) { await a.ctl({ cmd: 'tick' }); await b.ctl({ cmd: 'tick' }); if ((await a.state()).invested > 0.8) break }
    assert.ok((await b.state()).invested > 0.8, 'the twin is invested too')
    await b.ctl({ cmd: 'shock', kind: 'crash' })
    for (const v of [a, b]) await v.ctl({ cmd: 'tick', n: 6 })
    const [sa, sb] = [await a.state(), await b.state()]
    assert.ok(sb.invested < 0.2, `after the crash Jev is ${Math.round(sb.invested * 100)}% invested`)
    assert.ok(sb.invested < sa.invested - 0.4, `calm twin is ${Math.round(sa.invested * 100)}% invested`)
  } finally {
    await a.viewer.close(); await b.viewer.close()
  }
})

test('"Go to cash" sells everything, with the fee', async () => {
  const { viewer, state, ctl } = await pausedViewer({ volatility: 0.006, seed: 11 })
  try {
    for (let i = 0; i < 200; i++) { await ctl({ cmd: 'tick' }); if ((await state()).holdings > 0) break }
    const before = await state()
    assert.ok(before.holdings > 0)
    await ctl({ cmd: 'flatten' })
    const s = await state()
    assert.equal(s.holdings, 0)
    assert.equal(s.trades.at(-1).why, 'you went to cash')
    assert.ok(Math.abs(s.cash - (before.cash + before.holdings * before.price * (1 - before.fee))) < 1e-6)
  } finally {
    await viewer.close()
  }
})

test('the sliders override market.json, clamp, and an edit to market.json resets them', async () => {
  const { ws, viewer, state, ctl } = await pausedViewer()
  try {
    await ctl({ cmd: 'set', key: 'volatility', value: 0.05 })
    await ctl({ cmd: 'set', key: 'fee', value: 0.008 })
    await ctl({ cmd: 'set', key: 'stepMs', value: 5 })        // clamped up to 60
    await ctl({ cmd: 'set', key: 'capital', value: 1 })       // not settable from the pane
    let s = await state()
    assert.equal(s.volatility, 0.05)
    assert.equal(s.fee, 0.008)
    assert.equal(s.stepMs, 60)
    assert.equal(s.capital, 10000)
    assert.deepEqual(Object.keys(s.overrides).sort(), ['fee', 'stepMs', 'volatility'])
    writeFileSync(join(ws, 'market.json'), JSON.stringify({ ...MARKET, volatility: 0.02 }))
    s = await until(async () => { const t = await state(); return t.volatility === 0.02 ? t : null })
    assert.ok(s, 'the edit reached the viewer')
    assert.deepEqual(s.overrides, {})
    assert.equal(s.fee, 0.001)
    assert.equal(s.stepMs, 120)
  } finally {
    await viewer.close()
  }
})

test('a bad JSON edit keeps the desk trading and reports the error', async () => {
  const { ws, viewer, state, ctl } = await pausedViewer({ instrument: 'KEEP' })
  try {
    await ctl({ cmd: 'tick', n: 5 })
    writeFileSync(join(ws, 'market.json'), '{ "instrument": "BROKEN", ')
    let s = await until(async () => { const t = await state(); return t.cfgError ? t : null })
    assert.ok(s, 'the parse error is reported')
    assert.match(s.cfgError, /market\.json/)
    assert.equal(s.instrument, 'KEEP', 'the last good config stands')
    await ctl({ cmd: 'tick', n: 5 })
    s = await state()
    assert.equal(s.day, 10, 'the desk kept trading')
    const v = JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    assert.match(v.summary, /needs a fix/)
    writeFileSync(join(ws, 'market.json'), JSON.stringify({ ...MARKET, instrument: 'FIXED' }))
    s = await until(async () => { const t = await state(); return t.instrument === 'FIXED' ? t : null })
    assert.ok(s && s.cfgError === null, 'a good edit clears the error')
  } finally {
    await viewer.close()
  }
})

test('a malformed control body is a 400, not a crash', async () => {
  const { viewer, state } = await pausedViewer()
  try {
    const res = await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    assert.equal(res.status, 400)
    assert.equal((await state()).day, 0)
  } finally {
    await viewer.close()
  }
})

test('a non-loopback Host header gets 403', async () => {
  const { viewer } = await freshViewer()
  try {
    const port = Number(viewer.url.split(':').pop())
    const reply = await new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET /state HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n'))
      let buf = ''
      sock.on('data', (d) => (buf += d))
      sock.on('end', () => resolve(buf))
      sock.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 403/)
  } finally {
    await viewer.close()
  }
})

test('the desk never idles: a year closes, the result shows, the next year opens with a new seed', async () => {
  const { viewer, state, ctl } = await pausedViewer({ episodeDays: 60, stepMs: 200 })
  try {
    const first = (await state()).candles.at(-1).c
    await ctl({ cmd: 'tick', n: 60 })
    let s = await state()
    assert.equal(s.status, 'done')
    assert.equal(s.session.episodes, 1)
    assert.ok(typeof s.result.ret === 'number' && typeof s.result.bh === 'number')
    await ctl({ cmd: 'tick', n: 14 })
    assert.equal((await state()).status, 'done', 'the result stays up for about three seconds')
    await ctl({ cmd: 'tick', n: 2 })
    s = await state()
    assert.equal(s.status, 'running')
    assert.equal(s.episode, 1)
    assert.equal(s.day, 1)
    assert.equal(s.equity > 0, true)
    assert.notEqual(s.candles.find((k) => k.d === 0).c, first, 'a new seed draws a new market')
  } finally {
    await viewer.close()
  }
})

test('the difficulty dial is honest: little noise beats a lot of noise, by a clear margin', async () => {
  const run = async (volatility) => {
    const { viewer, state, ctl } = await pausedViewer({ volatility, stepMs: 200 })
    try {
      await ctl({ cmd: 'tick', n: 10 * (250 + 15) }) // ten paper years, each followed by its three-second rest
      const s = (await state()).session
      return { years: s.episodes, beats: s.beats, right: s.rightDays / s.regimeDays, edge: s.sumEdge / s.episodes }
    } finally {
      await viewer.close()
    }
  }
  const easy = await run(0.004), hard = await run(0.05)
  assert.equal(easy.years, 10); assert.equal(hard.years, 10)
  assert.ok(easy.right > 0.8, `easy: on the right side of the hidden trend ${(easy.right * 100).toFixed(0)}% of days`)
  assert.ok(hard.right < 0.62, `hard: ${(hard.right * 100).toFixed(0)}%`)
  assert.ok(easy.right - hard.right > 0.22, `margin ${(easy.right - hard.right).toFixed(2)}`)
  assert.ok(easy.beats >= 8, `easy: beat buy-and-hold in ${easy.beats} of 10 years`)
  assert.ok(easy.edge > 0.08, `easy: ${(easy.edge * 100).toFixed(1)} points a year over buy-and-hold`)
})

test('fees are real: the same desk keeps less when every trade costs more', async () => {
  const run = async (fee) => {
    const { viewer, state, ctl } = await pausedViewer({ fee, stepMs: 200 })
    try {
      await ctl({ cmd: 'tick', n: 6 * (250 + 15) })
      const s = (await state()).session
      return { fees: s.fees / s.episodes, ret: s.sumRet / s.episodes }
    } finally {
      await viewer.close()
    }
  }
  const free = await run(0), dear = await run(0.01)
  assert.equal(free.fees, 0)
  assert.ok(dear.fees > 200, `a 1% fee cost ${dear.fees.toFixed(0)} a year`)
  assert.ok(dear.ret < free.ret - 0.02, `return ${(dear.ret * 100).toFixed(1)}% with the fee, ${(free.ret * 100).toFixed(1)}% without`)
})

test('check.mjs accepts the template and rejects an out-of-range value', () => {
  const check = join(HERE, '../toolchain/check.mjs')
  const good = mkdtempSync(join(tmpdir(), 'jev-trader-check-'))
  cpSync(join(HERE, '../template'), good, { recursive: true })
  assert.equal(spawnSync(process.execPath, [check], { env: { ...process.env, HARNESS_WORKSPACE: good } }).status, 0)
  const bad = mkdtempSync(join(tmpdir(), 'jev-trader-check-'))
  writeFileSync(join(bad, 'market.json'), JSON.stringify({ ...MARKET, volatility: 3 }))
  const r = spawnSync(process.execPath, [check], { env: { ...process.env, HARNESS_WORKSPACE: bad }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /volatility/)
})
