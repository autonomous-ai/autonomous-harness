// The Yosys pane: a dashboard of one run of the flow.
//
// It reads the report `flow.sh` writes — out/<top>.report.json — and draws four things from it:
// the gate-level schematic netlistsvg rendered (pan and zoom), the simulation's waveforms on a
// canvas built here from out/waves.json, what the design costs on the chip (logic cells, pins,
// Fmax against the clock the PCF asks for), and where the bitstream is.
//
// No dependencies, in the server or in the page: the waveform viewer is ~200 lines of canvas below,
// and the schematic is an SVG the toolchain already rendered. Files come from the workspace and
// nowhere else. /events pushes `change` on every write, and the page refetches.
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.HARNESS_VIEWER_PORT)
const workspace = resolve(process.env.HARNESS_WORKSPACE)
const clients = new Set()
const TYPES = {
  '.json': 'application/json', '.svg': 'image/svg+xml', '.log': 'text/plain; charset=utf-8',
  '.v': 'text/plain; charset=utf-8', '.pcf': 'text/plain; charset=utf-8', '.vcd': 'text/plain; charset=utf-8',
  '.asc': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream',
  '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
}

function safe(root, rel) {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root + sep) ? full : null
}

// The artifact the harness names is out/<top>.report.json. Be forgiving about what arrives in
// ?file=: a report, anything beside one (out/blink.svg -> out/blink.report.json), or nothing at all.
function findReport(rel) {
  const candidates = []
  if (rel) {
    const full = safe(workspace, rel)
    if (full && full.endsWith('.report.json') && existsSync(full)) return full
    if (full) {
      const stem = basename(full).replace(/(\.report)?\.[^.]+$/, '')
      candidates.push(join(dirname(full), stem + '.report.json'))
    }
  }
  candidates.push(...newestReports())
  return candidates.find((p) => p && existsSync(p)) ?? null
}

function newestReports() {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name.endsWith('.report.json')) found.push(full)
    }
  }
  walk(workspace, 0)
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

const page = `<!doctype html><meta charset="utf-8"><title>Yosys</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #141416; --panel: #1c1c1e; --panel2: #212124; --line: #303034;
    --ink: #e8e8ed; --dim: #98989f; --faint: #6a6a72;
    --ok: #30d158; --bad: #ff453a; --warn: #ff9f0a; --info: #0a84ff; --bus: #5ac8fa;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink);
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  body { display: flex; flex-direction: column; overflow: hidden; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }

  header { flex: 0 0 auto; padding: 10px 16px 0; background: var(--panel); border-bottom: 1px solid var(--line); }
  .top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .top h1 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
  .pill { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 2px 7px; border-radius: 999px; border: 1px solid; }
  .pill.ready { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 12%, transparent); }
  .pill.notready { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 12%, transparent); }
  .summary { color: var(--dim); font-size: 12px; margin-left: auto; text-align: right; }
  .phases { display: flex; gap: 4px; flex-wrap: wrap; padding: 9px 0 10px; }
  .phase { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--faint);
    padding: 3px 9px; border-radius: 999px; background: var(--panel2); border: 1px solid transparent; }
  .phase .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .phase.done { color: var(--ok); }
  .phase.active { color: var(--info); border-color: color-mix(in srgb, var(--info) 40%, transparent); }
  .phase.failed { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }

  main { flex: 1 1 auto; display: flex; min-height: 0; }
  .stage { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .tabs { display: flex; gap: 2px; padding: 8px 12px 0; flex: 0 0 auto; align-items: center; }
  .tabs button { appearance: none; background: transparent; border: 0; color: var(--dim); cursor: pointer;
    font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 7px; }
  .tabs button:hover { color: var(--ink); background: var(--panel2); }
  .tabs button[aria-selected="true"] { color: var(--ink); background: var(--panel); }
  .tabs .spacer { flex: 1 1 auto; }
  .tabs .hint { color: var(--faint); font-size: 11px; }
  .panelbody { flex: 1 1 auto; min-height: 0; position: relative; margin: 8px 12px 12px; }

  /* netlistsvg draws black on white; give it a white sheet rather than fight its stylesheet. */
  #schematic { position: absolute; inset: 0; overflow: hidden; border-radius: 10px;
    background: #fbfbfa; cursor: grab; touch-action: none; }
  #schematic.dragging { cursor: grabbing; }
  #schematic .sheet { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  #schematic svg { display: block; }

  /* The axis stays put; the lanes scroll under it when a design has more signals than fit. */
  #waves { position: absolute; inset: 0; border-radius: 10px; background: var(--panel); overflow: hidden; }
  #waveaxis { position: absolute; top: 0; left: 0; right: 0; height: 26px; display: block; z-index: 2; }
  #wavescroll { position: absolute; top: 26px; left: 0; right: 0; bottom: 0; overflow-y: auto; overflow-x: hidden; }
  #wavescroll::-webkit-scrollbar { width: 9px; }
  #wavescroll::-webkit-scrollbar-thumb { background: #3a3a40; border-radius: 5px; }
  #wavecanvas { display: block; width: 100%; touch-action: none; cursor: crosshair; }

  .empty { position: absolute; inset: 0; display: grid; place-items: center; text-align: center;
    color: var(--faint); font-size: 12px; padding: 24px; background: var(--panel); border-radius: 10px; }
  .empty b { display: block; color: var(--dim); font-size: 13px; font-weight: 600; margin-bottom: 5px; }

  aside { flex: 0 0 300px; overflow-y: auto; padding: 12px 14px 24px; border-left: 1px solid var(--line);
    background: var(--panel); }
  aside h2 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint);
    margin: 18px 0 7px; font-weight: 700; }
  aside h2:first-child { margin-top: 2px; }
  .card { background: var(--panel2); border-radius: 9px; padding: 9px 11px; }
  .card + .card { margin-top: 6px; }
  .kv { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; padding: 2px 0; }
  .kv .k { color: var(--dim); }
  .kv .v { color: var(--ink); text-align: right; }

  .bar { height: 5px; border-radius: 3px; background: #2f2f34; overflow: hidden; margin-top: 4px; }
  .bar > i { display: block; height: 100%; border-radius: 3px; background: var(--info); }
  .bar.hot > i { background: var(--warn); }
  .bar.full > i { background: var(--bad); }

  .fmax { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; }
  .fmax.bad { color: var(--bad); }
  .fmax small { font-size: 11px; font-weight: 400; color: var(--dim); margin-left: 4px; letter-spacing: 0; }

  .steps { display: flex; flex-direction: column; gap: 1px; }
  .step { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 3px 0; color: var(--dim); }
  .step .dot { width: 7px; height: 7px; border-radius: 50%; background: #3a3a40; flex: 0 0 auto; }
  .step.done .dot { background: var(--ok); }
  .step.failed .dot { background: var(--bad); }
  .step.running .dot { background: var(--info); animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .step.failed { color: var(--bad); }
  .step a { margin-left: auto; color: var(--faint); text-decoration: none; font-size: 11px; }
  .step a:hover { color: var(--info); }

  .checks { font-size: 11.5px; }
  .checks div { padding: 1px 0; color: var(--dim); }
  .checks div.fail { color: var(--bad); }
  .checks div.pass { color: var(--ok); }

  .finding { display: flex; gap: 7px; font-size: 12px; padding: 5px 0; border-bottom: 1px solid var(--line); }
  .finding:last-child { border-bottom: 0; }
  .finding .sev { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; margin-top: 6px; }
  .finding.error .sev { background: var(--bad); } .finding.warning .sev { background: var(--warn); }
  .finding.info .sev { background: var(--info); }
  .finding .ref { color: var(--faint); font-size: 11px; }

  .flash { background: #101012; border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px;
    font-size: 11.5px; color: var(--ok); overflow-x: auto; white-space: nowrap; margin-top: 6px; }

  @media (max-width: 760px) {
    main { flex-direction: column; }
    aside { flex: 0 0 auto; border-left: 0; border-top: 1px solid var(--line); max-height: 45%; }
    .stage { min-height: 260px; }
  }
</style>

<header>
  <div class="top">
    <h1 id="title">…</h1>
    <span class="pill" id="state" hidden></span>
    <span class="summary" id="summary"></span>
  </div>
  <div class="phases" id="phases"></div>
</header>

<main>
  <section class="stage">
    <nav class="tabs">
      <button id="tab-schematic" aria-selected="true">Schematic</button>
      <button id="tab-waves">Waveforms</button>
      <span class="spacer"></span>
      <span class="hint" id="hint"></span>
    </nav>
    <div class="panelbody">
      <div id="schematic"><div class="sheet"></div></div>
      <div id="waves" hidden>
        <canvas id="waveaxis"></canvas>
        <div id="wavescroll"><canvas id="wavecanvas"></canvas></div>
      </div>
      <div class="empty" id="empty" hidden></div>
    </div>
  </section>
  <aside id="rail"></aside>
</main>

<script>
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var fileParam = params.get('file') || '';
  var report = null, waves = null, tab = 'schematic';
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function bytes(n) {
    if (!n && n !== 0) return '';
    return n < 1024 ? n + ' B' : (n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(2) + ' MB');
  }

  // ------------------------------------------------------------------ fetching

  function load() {
    return fetch('/api/report?file=' + encodeURIComponent(fileParam) + '&t=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        report = data && data.report ? data.report : null;
        if (!report) { showEmpty('No report yet', 'Run the flow — <code>$YOSYS_TOOLCHAIN/flow.sh &lt;top&gt;</code> — and this pane fills in.'); render(); return null; }
        var wp = report.simulation && report.simulation.waves;
        if (!wp) { waves = null; return null; }
        return fetch('/' + wp + '?t=' + Date.now())
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (w) { waves = w; });
      })
      .then(function () { if (report) render(); })
      .catch(function (e) { showEmpty('Could not read the report', esc(e.message)); });
  }

  function showEmpty(title, html) {
    $('empty').hidden = false;
    $('empty').innerHTML = '<div><b>' + esc(title) + '</b>' + html + '</div>';
  }

  // ------------------------------------------------------------------ header + rail

  function render() {
    $('title').textContent = report.top;
    var s = $('state');
    s.hidden = false;
    s.className = 'pill ' + (report.ready ? 'ready' : 'notready');
    s.textContent = report.ready ? 'ready' : 'not ready';
    $('summary').textContent = report.summary || '';

    $('phases').innerHTML = (report.phases || []).map(function (p) {
      return '<span class="phase ' + esc(p.state) + '"><i class="dot"></i>' + esc(p.name) + '</span>';
    }).join('');

    renderRail();
    renderStage();
  }

  function renderRail() {
    var h = [], r = report;
    var errs = (r.findings || []).filter(function (f) { return f.severity === 'error'; });

    if ((r.findings || []).length) {
      h.push('<h2>' + (errs.length ? errs.length + ' error' + (errs.length === 1 ? '' : 's') : 'Findings') + '</h2><div class="card">');
      h.push(r.findings.slice(0, 40).map(function (f) {
        return '<div class="finding ' + esc(f.severity) + '"><i class="sev"></i><div>' + esc(f.message) +
          (f.ref ? ' <span class="ref">' + esc(f.ref) + '</span>' : '') + '</div></div>';
      }).join(''));
      h.push('</div>');
    }

    if (r.pnr && r.pnr.clocks && r.pnr.clocks.length) {
      h.push('<h2>Timing</h2>');
      h.push(r.pnr.clocks.map(function (c) {
        var head = Math.min(1, c.constraintMHz && c.achievedMHz ? c.constraintMHz / c.achievedMHz : 1);
        var x = c.constraintMHz ? (c.achievedMHz / c.constraintMHz) : 0;
        return '<div class="card"><div class="fmax ' + (c.pass ? '' : 'bad') + '">' +
          c.achievedMHz.toFixed(1) + ' MHz<small>' + esc(c.clock) + '</small></div>' +
          '<div class="bar ' + (c.pass ? '' : 'full') + '"><i style="width:' + (head * 100).toFixed(1) + '%"></i></div>' +
          '<div class="kv"><span class="k">asks for</span><span class="v">' + c.constraintMHz.toFixed(2) + ' MHz</span></div>' +
          (c.constraintMHz ? '<div class="kv"><span class="k">headroom</span><span class="v">' +
            (c.pass ? x.toFixed(1) + '\\u00d7' : 'misses by ' + (c.constraintMHz - c.achievedMHz).toFixed(1) + ' MHz') + '</span></div>' : '') +
          '</div>';
      }).join(''));
    }

    if (r.pnr && r.pnr.utilization && r.pnr.utilization.length) {
      h.push('<h2>On the chip</h2><div class="card">');
      h.push(r.pnr.utilization.map(function (u) {
        var cls = u.percent >= 90 ? 'full' : (u.percent >= 70 ? 'hot' : '');
        return '<div style="padding:3px 0"><div class="kv"><span class="k">' + esc(u.name) + '</span>' +
          '<span class="v">' + u.used + ' / ' + u.available + ' <span style="color:var(--faint)">' +
          (u.percent < 1 && u.percent > 0 ? '<1' : Math.round(u.percent)) + '%</span></span></div>' +
          '<div class="bar ' + cls + '"><i style="width:' + Math.max(u.percent, u.used ? 1.5 : 0).toFixed(1) + '%"></i></div></div>';
      }).join(''));
      h.push('</div>');
    }

    if (r.synthesis && r.synthesis.cells) {
      h.push('<h2>Cells</h2><div class="card">');
      h.push('<div class="kv"><span class="k">total</span><span class="v">' + r.synthesis.cells + '</span></div>');
      var types = r.synthesis.byType || {};
      h.push(Object.keys(types).map(function (k) {
        return '<div class="kv"><span class="k mono">' + esc(k) + '</span><span class="v">' + types[k] + '</span></div>';
      }).join(''));
      h.push('</div>');
    }

    if (r.bitstream) {
      h.push('<h2>Bitstream</h2><div class="card">');
      h.push('<div class="kv"><span class="k mono">' + esc(r.bitstream.path) + '</span><span class="v">' + bytes(r.bitstream.bytes) + '</span></div>');
      h.push('<div style="color:var(--dim);font-size:11.5px;margin-top:3px">Ready to flash an ' + esc(r.board ? r.board.name : 'iCE40') + ' over USB:</div>');
      h.push('<div class="flash mono">' + esc(r.bitstream.flash) + '</div></div>');
    }

    if (r.simulation && r.simulation.checks && r.simulation.checks.length) {
      h.push('<h2>Testbench</h2><div class="card checks">');
      h.push(r.simulation.checks.slice(0, 60).map(function (l) {
        var up = l.toUpperCase();
        var cls = up.indexOf('FAIL') === 0 || up.indexOf(' FAIL') >= 0 ? 'fail' : (up.indexOf('PASS') === 0 ? 'pass' : '');
        return '<div class="' + cls + '">' + esc(l) + '</div>';
      }).join(''));
      h.push('</div>');
    }

    h.push('<h2>Flow</h2><div class="card steps">');
    h.push((r.steps || []).map(function (st) {
      return '<div class="step ' + esc(st.state) + '"><i class="dot"></i>' + esc(st.name) +
        (st.log && st.state !== 'pending' ? '<a href="/' + esc(st.log) + '" target="_blank">log</a>' : '') + '</div>';
    }).join(''));
    h.push('</div>');

    if (r.board) {
      h.push('<h2>Target</h2><div class="card">');
      h.push('<div class="kv"><span class="k">board</span><span class="v">' + esc(r.board.name) + '</span></div>');
      h.push('<div class="kv"><span class="k">device</span><span class="v">' + esc(r.board.device) + ' ' + esc(r.board.package) + '</span></div>');
      h.push('<div class="kv"><span class="k">sources</span><span class="v mono" style="font-size:11px">' + esc((r.rtl || []).join(' ')) + '</span></div>');
      h.push('</div>');
    }

    $('rail').innerHTML = h.join('');
  }

  // ------------------------------------------------------------------ tabs

  function selectTab(name) {
    tab = name;
    $('tab-schematic').setAttribute('aria-selected', String(name === 'schematic'));
    $('tab-waves').setAttribute('aria-selected', String(name === 'waves'));
    renderStage();
  }
  $('tab-schematic').onclick = function () { selectTab('schematic'); };
  $('tab-waves').onclick = function () { selectTab('waves'); };

  function renderStage() {
    var sch = report && report.synthesis && report.synthesis.schematic;
    var hasWaves = waves && waves.signals && waves.signals.length;
    $('schematic').hidden = tab !== 'schematic';
    $('waves').hidden = tab !== 'waves';
    $('empty').hidden = true;

    if (tab === 'schematic') {
      $('hint').textContent = sch ? 'scroll to zoom · drag to pan · double-click to fit' : '';
      if (!sch) { $('schematic').hidden = true; showEmpty('No schematic yet', 'Synthesis writes <code>' + esc(report ? 'out/' + report.top + '.svg' : 'out/<top>.svg') + '</code>.'); return; }
      loadSchematic(sch);
    } else {
      var overflow = hasWaves && waves.signals.length * (LANE + GAP) > $('wavescroll').clientHeight;
      $('hint').textContent = hasWaves
        ? waves.signals.length + ' signals · scroll to zoom · drag to pan' + (overflow ? ' · shift-scroll for more signals' : '')
        : '';
      if (!hasWaves) { $('waves').hidden = true; showEmpty('No waveforms yet', 'The testbench needs <code>$dumpfile("out/sim.vcd")</code> and <code>$dumpvars</code>.'); return; }
      fitWaves();
      drawWaves();
    }
  }

  // ------------------------------------------------------------------ schematic: pan and zoom

  var sheet = $('schematic').querySelector('.sheet');
  var view = { x: 0, y: 0, k: 1 }, loadedSvg = null, svgSize = { w: 1, h: 1 };

  function loadSchematic(path) {
    if (loadedSvg === path && sheet.firstChild) return;
    fetch('/' + path + '?t=' + Date.now()).then(function (r) { return r.ok ? r.text() : null; }).then(function (text) {
      if (!text) { $('schematic').hidden = true; showEmpty('Schematic missing', esc(path) + ' is not on disk.'); return; }
      sheet.innerHTML = text;
      loadedSvg = path;
      var svg = sheet.querySelector('svg');
      if (svg) {
        svgSize = { w: parseFloat(svg.getAttribute('width')) || svg.clientWidth || 600,
                    h: parseFloat(svg.getAttribute('height')) || svg.clientHeight || 400 };
      }
      fitSchematic();
    });
  }

  function applyView() {
    sheet.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
  }
  function fitSchematic() {
    var box = $('schematic').getBoundingClientRect();
    var pad = 24;
    var k = Math.min((box.width - pad * 2) / svgSize.w, (box.height - pad * 2) / svgSize.h);
    view.k = Math.max(0.05, Math.min(k, 3));
    view.x = (box.width - svgSize.w * view.k) / 2;
    view.y = (box.height - svgSize.h * view.k) / 2;
    applyView();
  }

  var el = $('schematic'), drag = null;
  el.addEventListener('wheel', function (e) {
    e.preventDefault();
    var box = el.getBoundingClientRect();
    var mx = e.clientX - box.left, my = e.clientY - box.top;
    var f = Math.exp(-e.deltaY * 0.0015);
    var k = Math.max(0.05, Math.min(view.k * f, 20));
    view.x = mx - (mx - view.x) * (k / view.k);
    view.y = my - (my - view.y) * (k / view.k);
    view.k = k;
    applyView();
  }, { passive: false });
  el.addEventListener('pointerdown', function (e) {
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    el.classList.add('dragging'); el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', function (e) {
    if (!drag) return;
    view.x = e.clientX - drag.x; view.y = e.clientY - drag.y; applyView();
  });
  el.addEventListener('pointerup', function () { drag = null; el.classList.remove('dragging'); });
  el.addEventListener('dblclick', fitSchematic);

  // ------------------------------------------------------------------ waveforms on a canvas

  var canvas = $('wavecanvas'), ctx = canvas.getContext('2d');
  var axisCanvas = $('waveaxis'), actx = axisCanvas.getContext('2d');
  var GUTTER = 148, LANE = 26, GAP = 8, AXIS = 26, PAD = 12;
  var span = { t0: 0, t1: 1 }, cursor = null, wdrag = null, fitted = false;

  function fitWaves() {
    if (fitted && span.t1 > span.t0) return;
    span = { t0: 0, t1: Math.max(1, waves.end) };
    fitted = true;
  }

  function timeUnit(ticks) {
    var fs = ticks * (waves.tickFs || 1000);
    if (fs >= 1e15) return { div: 1e15 / (waves.tickFs || 1000), u: 's' };
    if (fs >= 1e12) return { div: 1e12 / (waves.tickFs || 1000), u: 'ms' };
    if (fs >= 1e9) return { div: 1e9 / (waves.tickFs || 1000), u: 'us' };
    if (fs >= 1e6) return { div: 1e6 / (waves.tickFs || 1000), u: 'ns' };
    if (fs >= 1e3) return { div: 1e3 / (waves.tickFs || 1000), u: 'ps' };
    return { div: 1 / (waves.tickFs || 1000), u: 'fs' };
  }
  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-12))));
    var n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function busText(bits) {
    if (/[xX]/.test(bits)) return 'x';
    if (/[zZ]/.test(bits)) return 'z';
    var s = bits, pad = (4 - (s.length % 4)) % 4, out = '';
    s = new Array(pad + 1).join('0') + s;
    for (var i = 0; i < s.length; i += 4) out += parseInt(s.substr(i, 4), 2).toString(16);
    return out.replace(/^0+(?=.)/, '');
  }
  function valueAt(sig, t) {
    var c = sig.changes, lo = 0, hi = c.length - 1, best = null;
    if (!c.length || t < c[0][0]) return null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (c[mid][0] <= t) { best = c[mid][1]; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  // The plot's geometry, shared by the axis strip and the lanes below it.
  function geom() {
    var box = $('waves').getBoundingClientRect();
    var W = Math.max(320, box.width);
    var dt = Math.max(1e-9, span.t1 - span.t0);
    var PW = W - GUTTER - PAD;
    return {
      W: W, PW: PW, dt: dt,
      viewH: Math.max(60, box.height - AXIS),
      contentH: waves ? waves.signals.length * (LANE + GAP) + 10 : 0,
      X: function (t) { return GUTTER + (t - span.t0) / dt * PW; },
    };
  }

  function prep(c, cx, w, h) {
    var dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.height = h + 'px';
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, w, h);
    cx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    cx.textBaseline = 'middle';
  }

  function ticks(g) {
    var step = niceStep(g.dt / Math.max(2, Math.floor(g.PW / 90)));
    var out = [];
    for (var t = Math.ceil(span.t0 / step) * step; t <= span.t1; t += step) out.push(t);
    return out;
  }

  function drawAxis(g) {
    prep(axisCanvas, actx, g.W, AXIS);
    var unit = timeUnit(g.dt);
    actx.fillStyle = '#1c1c1e'; actx.fillRect(0, 0, g.W, AXIS);
    actx.strokeStyle = '#2a2a2e'; actx.fillStyle = '#6a6a72'; actx.lineWidth = 1; actx.textAlign = 'left';
    ticks(g).forEach(function (t) {
      var x = Math.round(g.X(t)) + 0.5;
      actx.beginPath(); actx.moveTo(x, AXIS - 6); actx.lineTo(x, AXIS); actx.stroke();
      actx.fillText((t / unit.div).toFixed(t / unit.div % 1 ? 1 : 0) + ' ' + unit.u, x + 3, 9);
    });
    actx.strokeStyle = '#3a3a40';
    actx.beginPath(); actx.moveTo(GUTTER, AXIS - 0.5); actx.lineTo(g.W, AXIS - 0.5); actx.stroke();
    if (cursor != null && cursor >= span.t0 && cursor <= span.t1) {
      var cx = Math.round(g.X(cursor)) + 0.5;
      actx.strokeStyle = '#ff9f0a';
      actx.beginPath(); actx.moveTo(cx, 0); actx.lineTo(cx, AXIS); actx.stroke();
      var lab = (cursor / unit.div).toFixed(2) + ' ' + unit.u;
      actx.textAlign = 'left'; actx.fillStyle = '#ff9f0a';
      actx.fillText(lab, Math.min(cx + 4, g.W - actx.measureText(lab).width - 4), 9);
    }
  }

  function drawWaves() {
    if (!waves || !waves.signals.length || tab !== 'waves') return;
    var g = geom();
    drawAxis(g);

    var W = g.W, H = Math.max(g.viewH, g.contentH);
    prep(canvas, ctx, W, H);
    var t0 = span.t0, t1 = span.t1, X = g.X, PW = g.PW;

    ctx.strokeStyle = '#2a2a2e'; ctx.lineWidth = 1;
    ticks(g).forEach(function (t) {
      var x = Math.round(X(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    });

    // --- lanes
    for (var i = 0; i < waves.signals.length; i++) {
      var sig = waves.signals[i];
      var y0 = i * (LANE + GAP) + 4;
      var hi = y0 + 4, lo = y0 + LANE - 4, mid = (hi + lo) / 2;

      // name, and the value under the cursor
      ctx.textAlign = 'left';
      ctx.fillStyle = '#98989f';
      var label = sig.name.replace(/^[^.]+\\./, '');
      while (ctx.measureText(label).width > GUTTER - 54 && label.length > 4) label = label.slice(1);
      ctx.fillText(label + (sig.width > 1 ? '[' + (sig.width - 1) + ':0]' : ''), 8, mid);
      if (cursor != null) {
        var v = valueAt(sig, cursor);
        if (v != null) {
          ctx.textAlign = 'right';
          ctx.fillStyle = '#e8e8ed';
          ctx.fillText(sig.width > 1 ? busText(v) : v, GUTTER - 10, mid);
        }
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(GUTTER, y0, PW + PAD, LANE); ctx.clip();
      ctx.lineWidth = 1.5;
      var c = sig.changes;
      for (var j = 0; j < c.length; j++) {
        var ts = c[j][0], te = j + 1 < c.length ? c[j + 1][0] : Math.max(t1, waves.end);
        if (te < t0 || ts > t1) continue;
        var xa = X(Math.max(ts, t0 - 1)), xb = X(Math.min(te, t1 + 1));
        var val = c[j][1];
        var unknown = /[xz]/.test(val);
        if (sig.width === 1) {
          ctx.strokeStyle = unknown ? '#ff453a' : '#30d158';
          var y = unknown ? mid : (val === '1' ? hi : lo);
          if (unknown) {
            ctx.fillStyle = 'rgba(255,69,58,0.16)';
            ctx.fillRect(xa, hi, Math.max(1, xb - xa), lo - hi);
            ctx.beginPath(); ctx.moveTo(xa, hi); ctx.lineTo(xb, hi); ctx.moveTo(xa, lo); ctx.lineTo(xb, lo); ctx.stroke();
          } else {
            ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y);
            if (j > 0) { ctx.moveTo(xa, hi); ctx.lineTo(xa, lo); }
            ctx.stroke();
          }
        } else {
          var n = Math.min(4, Math.max(0, (xb - xa) / 2));
          ctx.strokeStyle = unknown ? '#ff453a' : '#5ac8fa';
          ctx.fillStyle = unknown ? 'rgba(255,69,58,0.16)' : 'rgba(90,200,250,0.13)';
          ctx.beginPath();
          ctx.moveTo(xa, mid); ctx.lineTo(xa + n, hi); ctx.lineTo(xb - n, hi);
          ctx.lineTo(xb, mid); ctx.lineTo(xb - n, lo); ctx.lineTo(xa + n, lo); ctx.closePath();
          ctx.fill(); ctx.stroke();
          var txt = busText(val);
          if (xb - xa > ctx.measureText(txt).width + 14) {
            ctx.fillStyle = unknown ? '#ff8a80' : '#bfe9ff';
            ctx.textAlign = 'center';
            ctx.fillText(txt, (Math.max(xa, GUTTER) + Math.min(xb, W)) / 2, mid);
          }
        }
      }
      ctx.restore();
    }

    // --- cursor
    if (cursor != null && cursor >= t0 && cursor <= t1) {
      var cx = Math.round(X(cursor)) + 0.5;
      ctx.strokeStyle = '#ff9f0a'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
    }
    if (waves.truncated) {
      ctx.textAlign = 'right'; ctx.fillStyle = '#6a6a72';
      ctx.fillText('dump truncated', W - 8, H - 10);
    }
  }

  function tAt(clientX) {
    var box = canvas.getBoundingClientRect();
    var PW = box.width - GUTTER - PAD;
    return span.t0 + (clientX - box.left - GUTTER) / PW * (span.t1 - span.t0);
  }
  canvas.addEventListener('wheel', function (e) {
    if (!waves) return;
    // Shift-wheel scrolls the lanes; a plain wheel zooms time, which is what a waveform is for.
    if (e.shiftKey) return;
    e.preventDefault();
    var at = tAt(e.clientX);
    var f = Math.exp(e.deltaY * 0.0015);
    var t0 = at - (at - span.t0) * f, t1 = at + (span.t1 - at) * f;
    if (t1 - t0 < 1) return;
    span = { t0: Math.max(0, t0), t1: Math.min(Math.max(waves.end, 1) * 1.02, t1) };
    drawWaves();
  }, { passive: false });
  canvas.addEventListener('pointerdown', function (e) {
    wdrag = { x: e.clientX, t0: span.t0, t1: span.t1 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (wdrag) {
      var box = canvas.getBoundingClientRect();
      var PW = box.width - GUTTER - PAD;
      var d = (e.clientX - wdrag.x) / PW * (wdrag.t1 - wdrag.t0);
      span = { t0: wdrag.t0 - d, t1: wdrag.t1 - d };
    }
    cursor = tAt(e.clientX);
    drawWaves();
  });
  canvas.addEventListener('pointerup', function () { wdrag = null; });
  canvas.addEventListener('pointerleave', function () { cursor = null; wdrag = null; drawWaves(); });
  canvas.addEventListener('dblclick', function () { fitted = false; fitWaves(); drawWaves(); });

  window.addEventListener('resize', function () {
    if (tab === 'waves') drawWaves(); else if (loadedSvg) fitSchematic();
  });

  // ------------------------------------------------------------------ live

  var es = new EventSource('/events');
  es.addEventListener('change', function () { loadedSvg = null; fitted = false; load(); });
  load();
})();
</script>`

function serveFile(res, full, req) {
  if (!full || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': type, 'content-length': statSync(full).size }); res.end(); return }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(readFileSync(full))
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const path = decodeURIComponent(url.pathname)

  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(page)
    return
  }
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': hello\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (path === '/api/report') {
    const full = findReport(url.searchParams.get('file') ?? '')
    res.writeHead(full ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    if (!full) { res.end('{"report":null}'); return }
    let report = null
    try { report = JSON.parse(readFileSync(full, 'utf8')) } catch { /* mid-write; the next change re-reads */ }
    res.end(JSON.stringify({ path: relative(workspace, full), report }))
    return
  }
  serveFile(res, safe(workspace, path.replace(/^\/+/, '')), req)
}).listen(port, '127.0.0.1', () => console.log(`[yosys] listening on http://127.0.0.1:${port}/ (workspace: ${workspace})`))

let timer = null
try {
  watch(workspace, { recursive: true }, (_event, name) => {
    const n = String(name ?? '')
    if (!n || n.startsWith('.harness') || n.includes('node_modules') || n.endsWith('.vvp') || n.endsWith('.asc')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n') }, 200)
  })
} catch (error) {
  console.log(`[yosys] watch failed: ${error.message}`)
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 20_000).unref()
