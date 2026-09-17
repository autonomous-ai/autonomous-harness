// The shell: header, the live pipeline, tabs, keyboard, the source and log drawer. Each tab is its
// own module with the same small surface — mount, show, hide, update(state, paths), key(event).
import { $, h, esc, getJson, getText, ICONS, duration, bytes, store, closeMenu, menuOpen, hideTip, showTip } from './util.js'
import { WavesTab } from './waves.js'
import { SchematicTab } from './schematic.js'
import { ChipTab } from './chip.js'
import { BoardTab } from './board.js'
import { FlowTab } from './flow.js'

const params = new URLSearchParams(location.search)
const fileParam = params.get('file') ?? ''

const TABS = ['waves', 'schematic', 'chip', 'board', 'flow']
const STAGES = [
  { id: 'sim', name: 'Simulate', steps: ['sim', 'waves'] },
  { id: 'synth', name: 'Synthesize', steps: ['synth', 'schematic', 'svg'] },
  { id: 'pnr', name: 'Place & route', steps: ['pnr'] },
  { id: 'pack', name: 'Bitstream', steps: ['pack'] },
]
const TOOL = { sim: 'iverilog · vvp', waves: 'vcd2json', synth: 'yosys', schematic: 'yosys prep', svg: 'netlistsvg', pnr: 'nextpnr-ice40', pack: 'icepack' }

let state = null
let active = null
const tabs = {}

const ctx = {
  get state() { return state },
  get top() { return state?.top ?? null },
  api: (path, q = {}) => getJson(`/api/${path}?${new URLSearchParams({ top: state?.top ?? '', ...q })}`),
  apiText: (path, q = {}) => getText(`/api/${path}?${new URLSearchParams({ top: state?.top ?? '', ...q })}`),
  openSource,
  openLog,
  switchTab: (name) => select(name),
  addWave(name, instPath) {
    select('waves')
    const found = mount('waves').addByName(name, instPath)
    if (found === false && tabs.waves.meta) showToast(`${name} is not in the simulation dump`)
  },
  setBadge(tab, kind) {
    const b = document.querySelector(`[role="tab"][data-tab="${tab}"]`)
    if (b) { if (kind) b.dataset.badge = kind; else delete b.dataset.badge }
  },
  step: (id) => state?.flow?.steps?.find((s) => s.id === id),
  stepRunning: (id) => ['running'].includes(ctx.step(id)?.state),
  runStartedAt: () => (state?.flow?.running ? state.flow.run?.startedAt : null),
  store: {
    get: (k, d) => store.get(`${state?.workspace ?? ''}:${state?.top ?? ''}:${k}`, d),
    set: (k, v) => store.set(`${state?.workspace ?? ''}:${state?.top ?? ''}:${k}`, v),
  },
}

// --------------------------------------------------------------------------------------- tabs

function mount(name) {
  if (tabs[name]) return tabs[name]
  const root = document.getElementById(`panel-${name}`)
  const Tab = { waves: WavesTab, schematic: SchematicTab, chip: ChipTab, board: BoardTab, flow: FlowTab }[name]
  tabs[name] = new Tab(root, ctx)
  if (state) tabs[name].update(state, null)
  return tabs[name]
}

function select(name) {
  if (!TABS.includes(name)) return
  if (active === name) return
  if (active) {
    document.getElementById(`panel-${active}`).hidden = true
    tabs[active]?.hide?.()
  }
  active = name
  for (const b of document.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === name))
  document.getElementById(`panel-${name}`).hidden = false
  mount(name).show?.()
  store.set('tab', name)
  hideTip()
}

for (const b of document.querySelectorAll('[role="tab"]')) b.addEventListener('click', () => select(b.dataset.tab))

// ------------------------------------------------------------------------------------ header

function stageState(stage, flow) {
  const steps = stage.steps.map((id) => flow?.steps?.find((s) => s.id === id)).filter(Boolean)
  const states = steps.map((s) => s.state)
  let st = 'pending'
  if (states.includes('failed')) st = 'failed'
  else if (states.includes('running')) st = 'running'
  else if (states.includes('interrupted')) st = 'interrupted'
  else if (states.length && states.every((s) => s === 'done')) st = 'done'
  else if (states.length && states.every((s) => s === 'skipped')) st = 'skipped'
  else if (states.includes('done') && states.every((s) => s === 'done' || s === 'skipped')) st = 'done'
  else if (states.includes('done')) st = 'running' // between two steps of one stage
  const ms = steps.reduce((a, s) => a + (s.ms ?? 0), 0)
  const running = steps.find((s) => s.state === 'running')
  const failed = steps.find((s) => s.state === 'failed')
  return { st, ms, steps, running, failed }
}

function stageMetric(id, report, files) {
  const r = report
  if (!r) return ''
  if (id === 'sim') {
    const checks = r.simulation?.checks ?? []
    const oks = checks.filter((l) => /^ok\b/i.test(l)).length
    const fails = checks.filter((l) => /^FAIL\b/.test(l) && !/checks? failed/i.test(l)).length
    if (fails) return `${fails} failing`
    if (oks) return `${oks} checks pass`
    if (r.simulation?.passed) return 'passes'
    return r.simulation?.state === 'done' ? 'ran' : ''
  }
  if (id === 'synth') return r.synthesis?.cells ? `${r.synthesis.cells} cells` : ''
  if (id === 'pnr') {
    const lc = (r.pnr?.utilization ?? []).find((u) => u.id === 'ICESTORM_LC')
    const c = (r.pnr?.clocks ?? [])[0]
    return [lc ? `${lc.used} LCs` : '', c ? `${c.achievedMHz.toFixed(1)} MHz` : ''].filter(Boolean).join(' · ')
  }
  if (id === 'pack') return r.bitstream ? bytes(r.bitstream.bytes) : files?.bin ? bytes(files.bin.size) : ''
  return ''
}

const ICON_OK = ICONS.check
const ICON_BAD = ICONS.cross

function renderHeader() {
  const s = state
  const r = s.report
  $('#top-name').textContent = s.top ?? 'Yosys'
  const board = r?.board ? `${r.board.name} · ${r.board.device} ${r.board.package?.toUpperCase?.() ?? ''}` : 'iCEBreaker · iCE40 UP5K SG48'
  // While a step runs, the line under the title is what its tool just printed — in place of the
  // board name, so the layout does not jump as runs start and stop.
  const curStep = s.flow?.running ? s.flow.steps?.find((x) => x.state === 'running') : null
  const sub = $('#top-sub')
  if (curStep) {
    sub.classList.add('live')
    sub.innerHTML = `<b>${esc(TOOL[curStep.id] ?? curStep.id)}</b> ${esc(curStep.last || 'starting…')}`
    sub.title = curStep.last ?? ''
  } else {
    sub.classList.remove('live')
    sub.textContent = board
    sub.title = ''
  }
  document.title = s.top ? `${s.top} · Yosys` : 'Yosys'

  // status pill
  const flow = s.flow
  const st = $('#status')
  const running = flow?.running
  const errors = (r?.findings ?? []).filter((f) => f.severity === 'error').length
  let kind = 'idle', text = 'Waiting for the first run'
  if (running) {
    const cur = flow.steps.find((x) => x.state === 'running')
    kind = 'running'; text = cur ? `Running · ${cur.name}` : 'Running'
  } else if (flow?.abandoned) { kind = 'warn'; text = 'Run interrupted' }
  else if (r?.ready) { kind = 'ready'; text = 'Ready' }
  else if (errors) { kind = 'failed'; text = `${errors} error${errors === 1 ? '' : 's'}` }
  else if (r) { kind = 'warn'; text = 'Not ready' }
  st.dataset.kind = kind
  st.lastElementChild.textContent = text

  // pipeline
  const pipe = $('#pipeline')
  pipe.innerHTML = ''
  const runStart = flow?.run?.startedAt ?? 0
  for (const stage of STAGES) {
    const info = stageState(stage, flow)
    let meta = ''
    let stale = false
    if (info.st === 'running') {
      const cur = info.running ?? info.steps.find((x) => x.state === 'running')
      const started = cur?.startedAt ?? info.steps.find((x) => x.startedAt)?.startedAt
      meta = started ? `${duration(Date.now() - started)}…` : 'running…'
    } else if (info.st === 'failed') meta = 'failed'
    else if (info.st === 'interrupted') meta = 'interrupted'
    else if (info.st === 'skipped') meta = 'skipped'
    else if (info.st === 'done') meta = stageMetric(stage.id, r, s.files) || duration(info.ms)
    else if (running) {
      const prev = stageMetric(stage.id, r, s.files)
      if (prev) { meta = prev; stale = true } else meta = 'waiting'
    } else meta = r ? 'not run' : '—'
    const el = h('li.stage', {
      dataset: { state: info.st, stage: stage.id, stale: stale ? '1' : '0' },
      title: info.steps.map((x) => `${x.name}: ${x.state}${x.ms != null ? ` (${duration(x.ms)})` : ''}`).join('\n'),
      onclick: () => {
        const step = info.failed ?? info.running ?? info.steps[info.steps.length - 1]
        if (stage.id === 'sim' && info.st === 'done') select('waves')
        else if (stage.id === 'synth' && info.st === 'done') select('schematic')
        else if ((stage.id === 'pnr' || stage.id === 'pack') && info.st === 'done') select('chip')
        else if (step) { select('flow'); tabs.flow?.focusStep(step.id) }
      },
    },
    h('span.ic', { html: info.st === 'done' ? ICON_OK : info.st === 'failed' ? ICON_BAD : '' }),
    h('span.txt', h('span.nm', stage.name), h('span.meta', meta)))
    pipe.append(el)
  }


  // failure banner
  const banner = $('#banner')
  const failed = flow?.steps?.find((x) => x.state === 'failed')
  const failingChecks = (r?.simulation?.checks ?? []).filter((l) => /^FAIL\b/.test(l))
  if (failed) {
    banner.hidden = false
    banner.innerHTML = ''
    banner.append(
      h('div.msg', h('b', `${failed.name} failed`), failed.error || failed.last || `exit ${failed.exit}`),
      h('button.btn', { onclick: () => openLog(failed.id) }, h('span', { html: ICONS.log }), 'Log'),
    )
  } else if (failingChecks.length && !running) {
    banner.hidden = false
    banner.innerHTML = ''
    banner.append(
      h('div.msg', h('b', 'Testbench'), failingChecks[0]),
      h('button.btn', { onclick: () => openSource(`tb/${s.top}_tb.v`) }, h('span', { html: ICONS.code }), 'Testbench'),
    )
  } else banner.hidden = true

  // tab badges
  ctx.setBadge('flow', failed || errors ? 'error' : running ? 'busy' : null)
  ctx.setBadge('waves', ctx.stepRunning('sim') || ctx.stepRunning('waves') ? 'busy' : failingChecks.length ? 'error' : null)
  ctx.setBadge('schematic', ctx.stepRunning('schematic') || ctx.stepRunning('synth') ? 'busy' : null)
  ctx.setBadge('chip', ctx.stepRunning('pnr') ? 'busy' : null)
  void runStart
}

// ---------------------------------------------------------------------------------- refresh

let refreshing = null, again = false, pendingPaths = new Set()
async function refresh(paths) {
  for (const p of paths ?? []) pendingPaths.add(p)
  if (refreshing) { again = true; return refreshing }
  refreshing = (async () => {
    do {
      again = false
      const changed = paths === null ? null : [...pendingPaths]
      pendingPaths = new Set()
      try {
        const prevTop = state?.top
        state = await getJson(`/api/state?file=${encodeURIComponent(fileParam)}`)
        if (prevTop && prevTop !== state.top) {
          // The agent moved to another top module: every tab starts over.
          for (const t of Object.values(tabs)) t.reset?.()
        }
        renderHeader()
        for (const [name, t] of Object.entries(tabs)) {
          try { t.update(state, prevTop && prevTop !== state.top ? null : changed) } catch (e) { console.error(name, e) }
        }
        if (!active) select(firstTab())
        drawerRefresh(changed)
      } catch (e) {
        console.error(e)
      }
    } while (again)
    refreshing = null
  })()
  return refreshing
}

function firstTab() {
  const saved = store.get('tab')
  if (saved && TABS.includes(saved)) return saved
  const f = state?.files ?? {}
  if (state?.flow?.steps?.some((s) => s.state === 'failed')) return 'flow'
  if (f.vcd) return 'waves'
  if (f.schematic) return 'schematic'
  if (f.pcf) return 'board'
  return 'flow'
}

const events = new EventSource('/events')
events.addEventListener('change', (e) => {
  let paths = []
  try { paths = JSON.parse(e.data).paths ?? [] } catch { /* keep empty */ }
  refresh(paths)
})
events.addEventListener('open', () => { if (state) refresh([]) })

// While a step runs, its elapsed time ticks in the pipeline.
setInterval(() => { if (state?.flow?.running) renderHeader() }, 500)

function showToast(text) {
  showTip(window.innerWidth / 2 - 120, 120, esc(text))
  setTimeout(hideTip, 2200)
}

// ----------------------------------------------------------------------------------- drawer

let drawerKind = null, drawerArg = null
function openDrawer(title, sub, body) {
  $('#drawer-title').textContent = title
  $('#drawer-sub').textContent = sub ?? ''
  const b = $('#drawer-body')
  b.innerHTML = ''
  b.append(body)
  $('#drawer').hidden = false
}
function closeDrawer() { $('#drawer').hidden = true; drawerKind = null }
$('#drawer-close').addEventListener('click', closeDrawer)

const VKW = new Set(('module endmodule input output inout wire reg logic integer parameter localparam assign always always_ff always_comb ' +
  'begin end if else case casez casex endcase default for while repeat forever initial posedge negedge or and not function endfunction ' +
  'task endtask generate endgenerate genvar signed unsigned timescale default_nettype').split(' '))

/** Verilog (or PCF) lines to highlighted HTML, one string per line; block comments span lines. */
export function highlightLines(lines, pcf = false) {
  let inBlock = false
  return lines.map((line) => {
    let out = ''
    let i = 0
    const n = line.length
    while (i < n) {
      const rest = line.slice(i)
      let m
      if (inBlock) {
        const e = rest.indexOf('*/')
        const part = e < 0 ? rest : rest.slice(0, e + 2)
        out += `<span class="cm">${esc(part)}</span>`
        i += part.length
        if (e >= 0) inBlock = false
        continue
      }
      if (rest.startsWith('//') || (pcf && rest[0] === '#')) { out += `<span class="cm">${esc(rest)}</span>`; break }
      if (!pcf && rest.startsWith('/*')) { inBlock = true; out += '<span class="cm">/*</span>'; i += 2; continue }
      if (rest[0] === '"' && (m = /^"(?:[^"\\]|\\.)*"?/.exec(rest))) { out += `<span class="st">${esc(m[0])}</span>`; i += m[0].length; continue }
      if ((m = /^`\w+/.exec(rest))) { out += `<span class="dr">${esc(m[0])}</span>`; i += m[0].length; continue }
      if ((m = /^\$\w+/.exec(rest))) { out += `<span class="sy">${esc(m[0])}</span>`; i += m[0].length; continue }
      if ((m = /^(\d[\d_]*)?'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_?]+|^#?\d[\d_]*(\.\d+)?/.exec(rest))) {
        out += `<span class="nu">${esc(m[0])}</span>`; i += m[0].length; continue
      }
      if ((m = /^[A-Za-z_]\w*/.exec(rest))) {
        out += !pcf && VKW.has(m[0]) ? `<span class="kw">${m[0]}</span>` : pcf && /^set_\w+$/.test(m[0]) ? `<span class="kw">${m[0]}</span>` : esc(m[0])
        i += m[0].length
        continue
      }
      out += esc(line[i])
      i++
    }
    return out
  })
}

async function openSource(path, line) {
  if (!path) return
  const clean = path.replace(/^\/+/, '')
  drawerKind = 'source'; drawerArg = { path: clean, line }
  let text
  try { text = await getText(`/ws/${clean.split('/').map(encodeURIComponent).join('/')}`) } catch (e) {
    openDrawer(clean, 'not found', h('div.empty', h('div.box', h('h3', 'Not in the workspace'), h('p', esc(e.message)))))
    return
  }
  const lines = text.replace(/\n$/, '').split('\n')
  const body = h('div.code')
  const html = highlightLines(lines, clean.endsWith('.pcf'))
  html.forEach((l, k) => body.append(h(`div${line && k + 1 === line ? '.hl' : ''}`, { html: l || ' ' })))
  openDrawer(clean, line ? `line ${line} · ${lines.length} lines` : `${lines.length} lines`, body)
  if (line) requestAnimationFrame(() => {
    const el = body.children[line - 1]
    if (el) $('#drawer-body').scrollTop = Math.max(0, el.offsetTop - $('#drawer-body').clientHeight / 3)
  })
}

async function openLog(step) {
  drawerKind = 'log'; drawerArg = { step }
  let text = ''
  try { text = await ctx.apiText('log', { step }) } catch { text = '' }
  const s = ctx.step(step)
  const body = h('div.code')
  const lines = text.replace(/\n$/, '').split('\n')
  let firstErr = -1
  lines.forEach((l, k) => {
    const cls = /\b(ERROR|[Ee]rror|FAIL)\b/.test(l) ? 'e' : /\b(Warning|warning:)\b/.test(l) ? 'w' : ''
    if (cls === 'e' && firstErr < 0) firstErr = k
    const row = h(`div${cls === 'e' ? '.hl' : ''}`, { html: esc(l) || ' ' })
    if (cls === 'w') row.style.color = 'var(--warn)'
    if (cls === 'e') row.style.color = 'var(--bad)'
    body.append(row)
  })
  openDrawer(`out/logs/${step}.log`, `${s?.name ?? step} · ${TOOL[step] ?? ''} · ${s?.state ?? ''}${s?.ms != null ? ` · ${duration(s.ms)}` : ''}`, text ? body : h('div.empty', h('div.box', h('h3', 'Empty log'), h('p', 'This step has not printed anything.'))))
  requestAnimationFrame(() => {
    const db = $('#drawer-body')
    if (firstErr >= 0) db.scrollTop = Math.max(0, body.children[firstErr].offsetTop - db.clientHeight / 3)
    else db.scrollTop = db.scrollHeight
  })
}

function drawerRefresh(changed) {
  if ($('#drawer').hidden || !drawerKind) return
  if (drawerKind === 'log' && (changed ?? []).some((p) => p.startsWith(`out/logs/${drawerArg.step}.`))) openLog(drawerArg.step)
  if (drawerKind === 'source' && (changed ?? []).includes(drawerArg.path)) openSource(drawerArg.path, drawerArg.line)
}

// ------------------------------------------------------------------------------------- keys

const HELP = [
  ['Everywhere', [['Waves · Schematic · Chip · Board · Flow', ['1', '–', '5']], ['Shortcuts', ['?']], ['Close drawer / menu', ['Esc']]]],
  ['Waves', [['Zoom in / out', ['+', '−']], ['Zoom to fit', ['F']], ['Zoom around pointer', ['scroll']], ['Pan', ['shift', 'scroll']],
    ['Pan left / right', ['⇧', '← →']], ['Previous / next edge of selected', ['← →']], ['Select signal', ['↑ ↓']],
    ['Cursor', ['click']], ['Marker', ['shift', 'click']], ['Marker at cursor', ['M']], ['Zoom cursor → marker', ['Z']],
    ['Cycle radix', ['R']], ['Remove signal', ['⌫']], ['Signal browser', ['S']], ['Find signal', ['/']], ['Zoom to a range', ['drag ruler']]]],
  ['Schematic', [['Fit', ['F']], ['Find net or cell', ['/']], ['Up one level', ['U']], ['Open instance', ['double-click']], ['Clear highlight', ['Esc']]]],
  ['Chip', [['Routes on / off', ['R']], ['Critical path on / off', ['P']], ['Colour by module / cell kind', ['C']]]],
]

function renderHelp() {
  const g = $('#help-grid')
  g.innerHTML = ''
  for (const [title, rows] of HELP) {
    g.append(h('h5', title))
    for (const [what, keys] of rows) g.append(h('div', h('span', what), h('span', keys.map((k) => (k === '–' ? h('span', '–') : h('kbd', k))))))
  }
}
function toggleHelp(on = $('#help').hidden) { if (on) renderHelp(); $('#help').hidden = !on }
$('#help-btn').addEventListener('click', () => toggleHelp())
$('#help-close').addEventListener('click', () => toggleHelp(false))
$('#help').addEventListener('click', (e) => { if (e.target === $('#help')) toggleHelp(false) })

document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
  if (e.key === 'Escape') {
    if (menuOpen()) { closeMenu(); return }
    if (!$('#help').hidden) { toggleHelp(false); return }
    if (!$('#drawer').hidden) { closeDrawer(); return }
    if (typing) { e.target.blur(); }
    tabs[active]?.key?.(e)
    return
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === '?') { toggleHelp(); e.preventDefault(); return }
  const n = Number(e.key)
  if (n >= 1 && n <= TABS.length && !e.shiftKey) { select(TABS[n - 1]); e.preventDefault(); return }
  tabs[active]?.key?.(e)
})

window.addEventListener('resize', () => tabs[active]?.resize?.())
window.addEventListener('themechange', () => { for (const t of Object.values(tabs)) t.theme?.() })

refresh(null)
