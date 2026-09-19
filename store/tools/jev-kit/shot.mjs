#!/usr/bin/env node
// shot.mjs — look at a viewer. Drives a headless Chrome over CDP (no dependencies; Node 22+).
//
//   node shot.mjs --url http://127.0.0.1:4801/ --out /abs/path/a.png [--wait 3000] [--w 1440] [--h 900] [--cdp 9333]
//   node shot.mjs --url ... --steps /abs/steps.json
//
// steps.json is a list run in order; each item is ONE of:
//   { "wait": 1500 }                       sleep ms
//   { "eval": "document.title" }           run JS in the page, print the result (await-ed)
//   { "click": "#reset" }                  click the centre of the first element matching a selector
//   { "clickAt": [640, 360] }              click at viewport x,y
//   { "type": "hello", "into": "#q" }      focus a selector and type text (real key events)
//   { "key": "Enter" }                     press one key
//   { "shot": "/abs/path/b.png" }          save a PNG
// Console errors and uncaught exceptions from the page are printed — a clean run prints none.
import { writeFileSync } from 'node:fs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const CDP = Number(args.cdp || 9333), W = Number(args.w || 1440), H = Number(args.h || 900)
if (!args.url) { console.error('need --url'); process.exit(2) }
const steps = args.steps
  ? JSON.parse((await import('node:fs')).readFileSync(args.steps, 'utf8'))
  : [{ wait: Number(args.wait || 3000) }, { shot: args.out }]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let nextId = 1
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result) }
  else if (m.method === 'Runtime.exceptionThrown') console.log('PAGE EXCEPTION:', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) console.log(`PAGE console.${m.params.type}:`, m.params.args.map((a) => a.value ?? a.description).join(' '))
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') console.log('PAGE LOG ERROR:', m.params.entry.text, m.params.entry.url ?? '')
}
const send = (method, params = {}) => new Promise((r, j) => { const id = nextId++; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })) })
const evalJs = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
  return res.result.value
}
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: args.url })
  await sleep(600)
  for (const s of steps) {
    if (s.wait != null) await sleep(s.wait)
    else if (s.eval != null) console.log('eval ->', JSON.stringify(await evalJs(s.eval)))
    else if (s.click != null) {
      const box = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(s.click)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
      if (!box) console.log('click: no element for', s.click); else await clickAt(box[0], box[1])
    } else if (s.clickAt != null) await clickAt(s.clickAt[0], s.clickAt[1])
    else if (s.type != null) {
      if (s.into) await evalJs(`document.querySelector(${JSON.stringify(s.into)})?.focus()`)
      for (const ch of String(s.type)) await send('Input.insertText', { text: ch })
    } else if (s.key != null) {
      const code = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 }[s.key] ?? 0
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: s.key, code: s.key === ' ' ? 'Space' : s.key, windowsVirtualKeyCode: code, text: type === 'keyDown' && s.key === 'Enter' ? '\r' : undefined })
    } else if (s.shot != null) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(s.shot, Buffer.from(data, 'base64'))
      console.log('shot ->', s.shot, `(hidden=${await evalJs('document.hidden')})`)
    }
  }
} finally {
  await fetch(`http://127.0.0.1:${CDP}/json/close/${target.id}`).catch(() => {})
  ws.close()
}
