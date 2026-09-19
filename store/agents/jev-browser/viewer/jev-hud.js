// jev-hud.js — "Jev's mind", live. A self-contained panel that polls the viewer's /jev route and
// shows what Jev was just asked and the full probability distribution it answered with, plus the
// numbers people care about: decisions per second, latency, tokens and cost.
//
// Drop-in: <script src="/jev-hud.js" defer></script>. It mounts into [data-jev-hud] if present,
// else as the first panel of #rail, else as a floating card. No dependencies.
(() => {
  if (window.__jevHud) return
  window.__jevHud = true

  const css = `
  .jh{--jh-ink:#e8eaf2;--jh-dim:#8a90a6;--jh-line:#262a38;--jh-bg:#12141c;--jh-acc:#a78bfa;--jh-ok:#34d399;--jh-warn:#fbbf24;--jh-bad:#fb7185;
    font:12px/1.4 ui-monospace,'SF Mono','Cascadia Code',Menlo,monospace;color:var(--jh-ink);background:var(--jh-bg);
    border:1px solid var(--jh-line);border-radius:12px;padding:12px 14px;box-sizing:border-box}
  .jh.float{position:fixed;right:14px;bottom:14px;width:320px;max-height:70vh;overflow:auto;z-index:50;box-shadow:0 12px 40px rgba(0,0,0,.5);backdrop-filter:blur(8px);background:rgba(18,20,28,.92)}
  .jh.float .jh-head{cursor:pointer;user-select:none}
  .jh.float.mini{width:auto;max-width:320px;padding:8px 12px}
  .jh.float.mini .jh-head{margin-bottom:0}
  .jh.float.mini>*:not(.jh-head){display:none}
  .jh-mini{display:none;font-size:11px;color:var(--jh-ink);font-variant-numeric:tabular-nums;white-space:nowrap}
  .jh.float.mini .jh-mini{display:inline}
  .jh.float.mini .jh-title{flex:none}
  .jh *{box-sizing:border-box}
  .jh-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .jh-title{font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:var(--jh-dim);flex:1}
  .jh-pulse{width:8px;height:8px;border-radius:50%;background:var(--jh-acc);box-shadow:0 0 0 0 rgba(167,139,250,.7)}
  .jh-pulse.beat{animation:jhbeat .35s ease-out}
  @keyframes jhbeat{0%{box-shadow:0 0 0 0 rgba(167,139,250,.8)}100%{box-shadow:0 0 0 9px rgba(167,139,250,0)}}
  .jh-badge{font-size:10px;font-weight:700;letter-spacing:1px;padding:2px 7px;border-radius:999px;border:1px solid}
  .jh-badge.mock{color:var(--jh-warn);border-color:rgba(251,191,36,.5);background:rgba(251,191,36,.08)}
  .jh-badge.live{color:var(--jh-ok);border-color:rgba(52,211,153,.5);background:rgba(52,211,153,.08)}
  .jh-badge.err{color:var(--jh-bad);border-color:rgba(251,113,133,.5);background:rgba(251,113,133,.08)}
  .jh-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px}
  .jh-stat{background:rgba(255,255,255,.03);border:1px solid var(--jh-line);border-radius:8px;padding:6px 4px;text-align:center;min-width:0}
  .jh-stat b{display:block;font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .jh-stat span{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--jh-dim)}
  .jh-spark{width:100%;height:26px;display:block;margin:2px 0 8px}
  .jh-q{border-top:1px dashed var(--jh-line);padding-top:8px;margin-top:8px}
  .jh-qh{display:flex;align-items:baseline;gap:6px;margin-bottom:5px}
  .jh-qid{font-weight:700;color:var(--jh-acc)}
  .jh-qt{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--jh-dim);border:1px solid var(--jh-line);border-radius:4px;padding:0 4px}
  .jh-conf{margin-left:auto;color:var(--jh-dim);font-size:11px}
  .jh-conf b{color:var(--jh-ink)}
  .jh-row{display:grid;grid-template-columns:96px 1fr 38px;align-items:center;gap:6px;height:16px}
  .jh-lab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--jh-dim);font-size:11px}
  .jh-row.top .jh-lab{color:var(--jh-ink);font-weight:700}
  .jh-track{height:8px;border-radius:4px;background:rgba(255,255,255,.05);overflow:hidden}
  .jh-bar{height:100%;width:0;border-radius:4px;background:linear-gradient(90deg,#6d5bd0,#a78bfa);transition:width .18s ease-out,background .18s}
  .jh-row.top .jh-bar{background:linear-gradient(90deg,#10b981,#34d399)}
  .jh-bar.no{background:linear-gradient(90deg,#be123c,#fb7185)}
  .jh-val{text-align:right;font-variant-numeric:tabular-nums;font-size:11px;color:var(--jh-dim)}
  .jh-row.top .jh-val{color:var(--jh-ink)}
  .jh-more{color:var(--jh-dim);font-size:10px;margin-top:2px}
  .jh-scale{position:relative;height:22px;margin-top:2px}
  .jh-scale i{position:absolute;top:8px;left:0;right:0;height:6px;border-radius:3px;background:linear-gradient(90deg,#34d399,#fbbf24,#fb7185);opacity:.55}
  .jh-scale u{position:absolute;top:3px;width:4px;height:16px;border-radius:2px;background:#fff;box-shadow:0 0 8px #fff;transform:translateX(-2px);transition:left .18s ease-out}
  .jh-lvl{font-size:11px;color:var(--jh-ink)}
  .jh-foot{margin-top:10px;font-size:10px;color:var(--jh-dim);line-height:1.45}
  .jh-foot code{color:var(--jh-warn)}
  .jh-err{margin-top:8px;color:var(--jh-bad);font-size:11px;word-break:break-word}
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  const root = el('section', 'jh')
  root.innerHTML = `
    <div class="jh-head"><span class="jh-pulse"></span><span class="jh-title">Jev · live mind</span><span class="jh-mini"></span><span class="jh-badge mock">MOCK</span></div>
    <div class="jh-stats">
      <div class="jh-stat"><b data-k="rate">—</b><span>dec / s</span></div>
      <div class="jh-stat"><b data-k="lat">—</b><span>latency</span></div>
      <div class="jh-stat"><b data-k="tok">—</b><span>tok / call</span></div>
      <div class="jh-stat"><b data-k="cost">—</b><span>cost</span></div>
    </div>
    <svg class="jh-spark" viewBox="0 0 200 26" preserveAspectRatio="none"><polyline fill="none" stroke="#a78bfa" stroke-width="1.5" points=""/></svg>
    <div class="jh-qs"></div>
    <div class="jh-err" hidden></div>
    <div class="jh-foot"></div>`

  function mount() {
    const slot = document.querySelector('[data-jev-hud]')
    const rail = document.getElementById('rail')
    if (slot) slot.appendChild(root)
    else if (rail) rail.insertBefore(root, rail.firstChild)
    else {
      root.classList.add('float', 'mini'); document.body.appendChild(root)
      root.querySelector('.jh-head').title = 'Click to open or close Jev\'s live mind'
      root.querySelector('.jh-head').addEventListener('click', () => root.classList.toggle('mini'))
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount()

  const $k = (k) => root.querySelector(`[data-k="${k}"]`)
  const qsBox = root.querySelector('.jh-qs')
  const badge = root.querySelector('.jh-badge')
  const pulse = root.querySelector('.jh-pulse')
  const errBox = root.querySelector('.jh-err')
  const foot = root.querySelector('.jh-foot')
  const spark = root.querySelector('.jh-spark polyline')

  const fmtMoney = (v) => v <= 0 ? '$0' : v < 0.0001 ? '<$.0001' : v < 1 ? '$' + v.toFixed(4).replace(/^0/, '') : '$' + v.toFixed(2)
  const fmtInt = (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v))
  const fmtLat = (ms) => ms < 1 ? '<1ms' : ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's'

  const blocks = new Map() // question id -> { key, node, rows }
  const MAX_Q = 6, MAX_OPT = 6

  function renderQuestion(q) {
    const a = q.answer || {}
    let shape = q.type
    let opts = []
    if (q.type === 'choice') {
      const entries = Object.entries(a.probabilities || {})
      const many = entries.length > MAX_OPT
      opts = many ? entries.sort((x, y) => y[1] - x[1]).slice(0, MAX_OPT - 1) : entries
      shape = 'choice:' + (many ? 'top' : entries.map((e) => e[0]).join('|'))
    }
    let b = blocks.get(q.id)
    if (!b || b.key !== shape) {
      if (b) b.node.remove()
      const node = el('div', 'jh-q')
      const head = el('div', 'jh-qh')
      head.append(el('span', 'jh-qid', q.id), el('span', 'jh-qt', q.type))
      const conf = el('span', 'jh-conf'); head.append(conf)
      node.append(head)
      node.title = q.instructions || ''
      b = { key: shape, node, conf, rows: [] }
      if (q.type === 'choice') {
        const n = shape === 'choice:top' ? MAX_OPT - 1 : opts.length
        for (let i = 0; i < n; i++) {
          const row = el('div', 'jh-row'); const lab = el('span', 'jh-lab'); const track = el('div', 'jh-track'); const bar = el('div', 'jh-bar'); const val = el('span', 'jh-val')
          track.append(bar); row.append(lab, track, val); node.append(row); b.rows.push({ row, lab, bar, val })
        }
        b.more = el('div', 'jh-more'); node.append(b.more)
      } else if (q.type === 'noul') {
        const row = el('div', 'jh-row top'); const lab = el('span', 'jh-lab', 'yes'); const track = el('div', 'jh-track'); const bar = el('div', 'jh-bar'); const val = el('span', 'jh-val')
        track.append(bar); row.append(lab, track, val); node.append(row); b.rows.push({ row, lab, bar, val })
      } else {
        const scale = el('div', 'jh-scale'); const strip = el('i'); const mark = el('u'); scale.append(strip, mark)
        b.mark = mark; b.lvl = el('div', 'jh-lvl'); node.append(scale, b.lvl)
      }
      blocks.set(q.id, b)
      qsBox.append(node)
    }
    if (q.type === 'choice') {
      const total = Object.keys(a.probabilities || {}).length
      opts.forEach(([name, p], i) => {
        const r = b.rows[i]; if (!r) return
        r.lab.textContent = name; r.lab.title = name
        r.bar.style.width = Math.max(1.5, p * 100) + '%'
        r.val.textContent = p >= 0.995 ? '1.00' : p.toFixed(2).replace(/^0/, '')
        r.row.classList.toggle('top', name === a.choice)
      })
      b.more.textContent = total > opts.length ? `+ ${total - opts.length} more options` : ''
      b.conf.innerHTML = `conf <b>${Number(a.confidence ?? 0).toFixed(2)}</b>`
    } else if (q.type === 'noul') {
      const p = Number(a.noul ?? 0.5); const r = b.rows[0]
      r.bar.style.width = Math.max(1.5, p * 100) + '%'
      r.bar.classList.toggle('no', p < 0.5)
      r.lab.textContent = p >= 0.5 ? 'yes' : 'no'
      r.val.textContent = p.toFixed(2).replace(/^0/, '')
      b.conf.innerHTML = `p(yes) <b>${p.toFixed(2)}</b>`
    } else {
      const legend = a.legend || {}; const n = Math.max(2, Object.keys(legend).length)
      const s = Number(a.score ?? 0)
      b.mark.style.left = Math.max(0, Math.min(100, (s / (n - 1)) * 100)) + '%'
      const near = legend[String(Math.round(s))]
      b.lvl.textContent = `${s.toFixed(2)} / ${n - 1}` + (near ? ` · ${near}` : '')
      b.conf.innerHTML = `conf <b>${Number(a.confidence ?? 0).toFixed(2)}</b>`
    }
  }

  let lastAt = 0
  function render(s) {
    const live = s.client === 'typesafe'
    badge.textContent = s.lastError ? 'ERROR' : live ? 'LIVE' : 'MOCK'
    badge.className = 'jh-badge ' + (s.lastError ? 'err' : live ? 'live' : 'mock')
    $k('rate').textContent = s.questionsPerSec >= 10 ? Math.round(s.questionsPerSec) : s.questionsPerSec.toFixed(1)
    $k('lat').textContent = s.calls ? fmtLat(live ? s.avgLatencyMs : s.lastLatencyMs) : '—'
    $k('tok').textContent = s.calls ? fmtInt(s.inputTokens / s.calls) : '—'
    $k('cost').textContent = fmtMoney(s.costUsd)
    root.querySelector('.jh-mini').textContent = `${s.questionsPerSec >= 10 ? Math.round(s.questionsPerSec) : s.questionsPerSec.toFixed(1)}/s · ${fmtMoney(s.costUsd)} ▾`
    const lat = s.latencies || []
    if (lat.length > 1) {
      const max = Math.max(...lat, 1)
      spark.setAttribute('points', lat.map((v, i) => `${(i / (lat.length - 1)) * 200},${24 - (v / max) * 22}`).join(' '))
    }
    errBox.hidden = !s.lastError
    errBox.textContent = s.lastError || ''
    foot.innerHTML = live
      ? `${fmtInt(s.calls)} calls · ${fmtInt(s.questions)} typed answers · ${fmtInt(s.inputTokens)} input tokens at $${s.pricePerMTok}/MTok. Output is free.`
      : `${fmtInt(s.calls)} calls · ${fmtInt(s.questions)} typed answers. Running on the offline stand-in — cost is what live Jev would charge ($${s.pricePerMTok}/MTok). Set <code>TYPESAFE_API_KEY</code> for the real model.`
    if (s.last && s.last.at !== lastAt) {
      lastAt = s.last.at
      pulse.classList.remove('beat'); void pulse.offsetWidth; pulse.classList.add('beat')
      const qs = s.last.questions.slice(0, MAX_Q)
      const ids = new Set(qs.map((q) => q.id))
      for (const [id, b] of blocks) if (!ids.has(id)) { b.node.remove(); blocks.delete(id) }
      qs.forEach(renderQuestion)
      if (s.last.questions.length > MAX_Q) {
        let more = qsBox.querySelector('.jh-more.all'); if (!more) { more = el('div', 'jh-more all'); qsBox.append(more) }
        more.textContent = `+ ${s.last.questions.length - MAX_Q} more questions answered in the same call`
      }
    }
  }

  async function tick() {
    if (!document.hidden) {
      try { const r = await fetch('/jev', { cache: 'no-store' }); if (r.ok) render(await r.json()) } catch { /* viewer restarting */ }
    }
    setTimeout(tick, 200)
  }
  tick()
})()
