// Viewer integration test for Jev Shopper. Spins up the real viewer against a temp workspace and
// checks the loop: prices tick, Jev forms a best-buy call and confidence, the verdict updates, and
// control commands answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const viewerPath = join(HERE, '../viewer/viewer.mjs')

const CFG = {
  title: 'Test Shop', instrument: 'SHOPPER', tickMs: 300, vol: 0.08, cash: 100,
  products: [
    { name: 'Espresso Machine', price: 240, drift: 0.02 },
    { name: 'Hiking Boots', price: 120, drift: -0.05 },
    { name: 'Desk Lamp', price: 45, drift: -0.03 },
  ],
  style: 'Pick the best buy.',
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function freshViewer(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-shopper-test-'))
  writeFileSync(join(ws, 'shopper.json'), JSON.stringify({ ...CFG, ...overrides }))
  const { startShopperViewer } = await import(viewerPath)
  const viewer = await startShopperViewer({ workspace: ws, port: 0 })
  return { ws, viewer }
}

test('Jev Shopper ticks prices and Jev forms a best-buy call', async () => {
  const { ws, viewer } = await freshViewer()
  try {
    const port = viewer.url.split(':').pop()
    const deadline = Date.now() + 3000
    let saw = false
    while (Date.now() < deadline) {
      await wait(150)
      const s = await (await fetch(`http://127.0.0.1:${port}/state`)).json()
      if (s.step >= 3 && s.history.length > 0) {
        assert.ok(s.streams.length >= 2)
        assert.ok(['Espresso Machine', 'Hiking Boots', 'Desk Lamp'].includes(s.lastPick))
        assert.ok(typeof s.lastConf === 'number')
        saw = true
        break
      }
    }
    assert.ok(saw, 'expected prices to tick and Jev to call a buy')
  } finally {
    await viewer.close()
  }
})

test('Jev Shopper writes a progressive verdict', async () => {
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

test('Jev Shopper control commands answer 200', async () => {
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
  } finally {
    await viewer.close()
  }
})

// ---------------------------------------------------------------------------------------------
// The tests below drive time with the `tick` control, so none of them waits on the shop's clock.
// ---------------------------------------------------------------------------------------------
import { connect } from 'node:net'
import { cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SHOP = {
  title: 'Dial Shop', instrument: 'SHOPPER', tickMs: 250, vol: 0.03, cash: 600, minDeal: 0.08, seed: 616,
  products: [
    { name: 'Espresso Machine', price: 240, drift: 0.0005 },
    { name: 'Hiking Boots', price: 120, drift: -0.0015 },
    { name: 'Noise Cancellers', price: 180, drift: 0 },
    { name: 'Desk Lamp', price: 45, drift: -0.0005 },
  ],
  style: 'Pick the product furthest below its own usual price.',
}

/** A paused shop at step 0, so `tick` alone moves time. */
async function pausedShop(overrides = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'jev-shopper-test-'))
  writeFileSync(join(ws, 'shopper.json'), JSON.stringify({ ...SHOP, ...overrides }))
  const { startShopperViewer } = await import(viewerPath)
  const viewer = await startShopperViewer({ workspace: ws, port: 0 })
  const state = async () => (await fetch(`${viewer.url}/state`)).json()
  const ctl = async (body) => (await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  await ctl({ cmd: 'pause' })
  await ctl({ cmd: 'reset' })
  return { ws, viewer, state, ctl }
}

async function until(fn, ms = 4000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await wait(40) }
  return null
}

test('a non-default shopper.json really shows up in /state', async () => {
  const { viewer, state } = await pausedShop({
    title: 'Odd Shop', vol: 0.11, cash: 333, tickMs: 140, minDeal: 0.12, seed: 9,
    products: [{ name: 'Moon Boots', price: 77 }, { name: 'Tin Robot', price: 31, drift: 0.001 }, { name: 'Kite', price: 19 }],
  })
  try {
    const s = await state()
    assert.equal(s.title, 'Odd Shop')
    assert.equal(s.vol, 0.11)
    assert.equal(s.budget, 333)
    assert.equal(s.cash, 333)
    assert.equal(s.tickMs, 140)
    assert.equal(s.minDeal, 0.12)
    assert.equal(s.seed, 9)
    assert.deepEqual(s.streams.map((x) => x.name), ['Moon Boots', 'Tin Robot', 'Kite'])
    assert.match(s.stateText, /Moon Boots: /)
    assert.match(s.stateText, /Budget left: \$333\.00/)
  } finally {
    await viewer.close()
  }
})

test('tick advances exactly n steps and the frame carries a probability per product', async () => {
  const { viewer, state, ctl } = await pausedShop()
  try {
    const r = await ctl({ cmd: 'tick', n: 25 })
    assert.equal(r.step, 25)
    const s = await state()
    assert.equal(s.step, 25)
    assert.equal(s.score.decisions, 25)
    assert.ok(s.streams.some((x) => x.name === s.jev.pick), 'the pick is a product on the board')
    const ps = s.streams.map((x) => x.p).filter((p) => p != null)
    assert.ok(ps.length >= 2, 'open products carry Jev\'s probability')
    const sum = Object.values(s.jev.probs).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-6, `probabilities sum to ${sum}`)
    assert.ok(s.jev.confidence > 0 && s.jev.confidence <= 1)
    assert.ok(s.jev.act >= 0 && s.jev.act <= 1)
    assert.ok(s.streams.every((x) => x.series.length >= 60 && x.fairSeries.length === x.series.length), 'every chart is pre-filled')
  } finally {
    await viewer.close()
  }
})

test('a flash sale drops that product\'s price against the same seed, and Jev buys it', async () => {
  const a = await pausedShop({ vol: 0.01 }), b = await pausedShop({ vol: 0.01 })
  try {
    for (const v of [a, b]) await v.ctl({ cmd: 'tick', n: 3 })
    const r = await b.ctl({ cmd: 'flash', name: 'Noise Cancellers' })
    assert.equal(r.ok, true)
    assert.ok((await b.state()).streams.find((x) => x.name === 'Noise Cancellers').flash > 0, 'the card shows a flash sale at once')
    for (const v of [a, b]) await v.ctl({ cmd: 'tick', n: 6 })
    const pa = (await a.state()).streams.find((x) => x.name === 'Noise Cancellers')
    const sb = await b.state(), pb = sb.streams.find((x) => x.name === 'Noise Cancellers')
    assert.ok(pb.price < pa.price * 0.8, `flash ${pb.price.toFixed(2)} vs calm ${pa.price.toFixed(2)}`)
    const bought = sb.receipts.find((x) => x.name === 'Noise Cancellers')
    assert.ok(bought && bought.flash === true, 'Jev bought the flash sale')
    assert.ok(bought.saved > 0, `and saved ${bought?.saved?.toFixed(2)} against the usual price`)
    assert.equal((await b.ctl({ cmd: 'flash', name: 'No Such Thing' })).applied, false)
  } finally {
    await a.viewer.close(); await b.viewer.close()
  }
})

test('the sliders override shopper.json, clamp, and an edit to shopper.json resets them', async () => {
  const { ws, viewer, state, ctl } = await pausedShop()
  try {
    await ctl({ cmd: 'tick', n: 2 })
    await ctl({ cmd: 'set', key: 'vol', value: 0.2 })
    await ctl({ cmd: 'set', key: 'cash', value: 900 })
    await ctl({ cmd: 'set', key: 'tickMs', value: 1 })          // clamped up to 60
    assert.equal((await ctl({ cmd: 'set', key: 'seed', value: 1 })).applied, false) // not settable from the pane
    let s = await state()
    assert.equal(s.vol, 0.2)
    assert.equal(s.budget, 900)
    assert.equal(s.cash, 900 - s.spent, 'moving the budget moves what is left')
    assert.equal(s.tickMs, 60)
    assert.equal(s.seed, 616)
    assert.deepEqual(Object.keys(s.overrides).sort(), ['cash', 'tickMs', 'vol'])
    writeFileSync(join(ws, 'shopper.json'), JSON.stringify({ ...SHOP, vol: 0.05 }))
    s = await until(async () => { const t = await state(); return t.vol === 0.05 ? t : null })
    assert.ok(s, 'the edit reached the viewer')
    assert.deepEqual(s.overrides, {})
    assert.equal(s.budget, 600)
    assert.equal(s.tickMs, 250)
  } finally {
    await viewer.close()
  }
})

test('product streams can be added and removed from the pane, within 2..8', async () => {
  const { viewer, state, ctl } = await pausedShop()
  try {
    const r = await ctl({ cmd: 'add' })
    assert.ok(typeof r.added === 'string' && r.added.length > 0)
    let s = await state()
    assert.equal(s.streams.length, 5)
    assert.equal(s.streams[4].name, r.added)
    assert.ok(s.streams[4].series.length >= 60, 'a new stream arrives with a full chart')
    await ctl({ cmd: 'tick', n: 3 })
    assert.match((await state()).stateText, new RegExp(r.added))
    for (let i = 0; i < 6; i++) await ctl({ cmd: 'add' })
    assert.equal((await state()).streams.length, 8, 'never more than 8')
    assert.equal((await ctl({ cmd: 'add' })).applied, false)
    s = await state()
    for (const x of s.streams.slice(2)) await ctl({ cmd: 'remove', name: x.name })
    s = await state()
    assert.equal(s.streams.length, 2)
    assert.equal((await ctl({ cmd: 'remove', name: s.streams[0].name })).applied, false, 'never fewer than 2')
    await ctl({ cmd: 'tick', n: 3 })
    assert.equal((await state()).error, null)
  } finally {
    await viewer.close()
  }
})

test('a bad JSON edit keeps the shop running and reports the error', async () => {
  const { ws, viewer, state, ctl } = await pausedShop({ title: 'Keep Me' })
  try {
    await ctl({ cmd: 'tick', n: 4 })
    writeFileSync(join(ws, 'shopper.json'), '{ "title": "Broken", ')
    let s = await until(async () => { const t = await state(); return t.cfgError ? t : null })
    assert.ok(s, 'the parse error is reported')
    assert.match(s.cfgError, /shopper\.json/)
    assert.equal(s.title, 'Keep Me', 'the last good config stands')
    await ctl({ cmd: 'tick', n: 4 })
    s = await state()
    assert.equal(s.step, 8, 'the shop kept ticking')
    assert.match(JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8')).summary, /needs a fix/)
    writeFileSync(join(ws, 'shopper.json'), JSON.stringify({ ...SHOP, title: 'Fixed' }))
    s = await until(async () => { const t = await state(); return t.title === 'Fixed' ? t : null })
    assert.ok(s && s.cfgError === null, 'a good edit clears the error')
  } finally {
    await viewer.close()
  }
})

test('a malformed control body is a 400, not a crash', async () => {
  const { viewer, state } = await pausedShop()
  try {
    const res = await fetch(`${viewer.url}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    assert.equal(res.status, 400)
    assert.equal((await state()).step, 0)
  } finally {
    await viewer.close()
  }
})

test('a non-loopback Host header gets 403', async () => {
  const { viewer } = await pausedShop()
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

test('the shop never idles: a round ends, the result shows, the next round opens with a new seed', async () => {
  const { viewer, state, ctl } = await pausedShop()
  try {
    let s = null
    for (let i = 0; i < 260; i++) { await ctl({ cmd: 'tick' }); s = await state(); if (s.phase === 'result') break }
    assert.equal(s.phase, 'result')
    assert.ok(['budget', 'time'].includes(s.result.reason))
    assert.equal(s.result.round, 1)
    const round1 = s.streams.map((x) => x.fairSeries.at(-1))
    await ctl({ cmd: 'tick', n: 10 })
    assert.equal((await state()).phase, 'result', 'the result stays up for about three seconds')
    await ctl({ cmd: 'tick', n: 3 })
    s = await state()
    assert.equal(s.phase, 'shopping')
    assert.equal(s.round, 2)
    assert.equal(s.cash, 600, 'a fresh budget')
    assert.ok(s.roundTick <= 3, 'the new round has only just begun')
    assert.notDeepEqual(s.streams.map((x) => x.fairSeries.at(-1)), round1, 'a new seed draws new prices')
  } finally {
    await viewer.close()
  }
})

test('the difficulty dial is honest: little price noise beats a lot, by a clear margin', async () => {
  const run = async (vol) => {
    const { viewer, state, ctl } = await pausedShop({ vol })
    try {
      await ctl({ cmd: 'tick', n: 1500 })
      const sc = (await state()).score
      return { accuracy: sc.accuracy, savedPct: sc.savedPct, buys: sc.buys, calls: sc.calls }
    } finally {
      await viewer.close()
    }
  }
  const easy = await run(0.01), hard = await run(0.15)
  assert.ok(easy.calls >= 40 && hard.calls >= 40, 'both runs faced plenty of real deals')
  assert.ok(easy.accuracy > 0.9, `easy: ${(easy.accuracy * 100).toFixed(0)}% of deal calls right`)
  assert.ok(hard.accuracy < 0.7, `hard: ${(hard.accuracy * 100).toFixed(0)}%`)
  assert.ok(easy.accuracy - hard.accuracy > 0.25, `margin ${(easy.accuracy - hard.accuracy).toFixed(2)}`)
  assert.ok(easy.savedPct > 0.12, `easy: buys saved ${(easy.savedPct * 100).toFixed(1)}% against the usual price`)
  assert.ok(hard.savedPct < 0.07, `hard: ${(hard.savedPct * 100).toFixed(1)}%`)
})

test('check.mjs accepts the template and rejects an out-of-range value', () => {
  const check = join(HERE, '../toolchain/check.mjs')
  const good = mkdtempSync(join(tmpdir(), 'jev-shopper-check-'))
  cpSync(join(HERE, '../template'), good, { recursive: true })
  assert.equal(spawnSync(process.execPath, [check], { env: { ...process.env, HARNESS_WORKSPACE: good } }).status, 0)
  const bad = mkdtempSync(join(tmpdir(), 'jev-shopper-check-'))
  writeFileSync(join(bad, 'shopper.json'), JSON.stringify({ ...SHOP, vol: 3 }))
  const r = spawnSync(process.execPath, [check], { env: { ...process.env, HARNESS_WORKSPACE: bad }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /vol/)
})
