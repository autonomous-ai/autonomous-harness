// The flow: every step of flow.sh with its tool, time and log; what the verdict found; what the
// testbench checked; what synthesis mapped the design to; and the bitstream with the line that
// flashes it.
import { h, ICONS, emptyState, ART, esc, duration, bytes, ago } from './util.js'

const TOOL = { sim: 'iverilog -g2012 · vvp', waves: 'vcd2json.py', synth: 'yosys synth_ice40', schematic: 'yosys prep', svg: 'netlistsvg', pnr: 'nextpnr-ice40', pack: 'icepack' }
const CELL_NOTES = {
  SB_LUT4: '4-input lookup table', SB_DFF: 'flip-flop', SB_DFFE: 'flip-flop, enable', SB_DFFSR: 'flip-flop, sync reset',
  SB_DFFSS: 'flip-flop, sync set', SB_DFFESR: 'flip-flop, enable + reset', SB_DFFESS: 'flip-flop, enable + set',
  SB_CARRY: 'carry chain', SB_RAM40_4K: 'block RAM', SB_IO: 'I/O buffer', SB_GB: 'global buffer', SB_SPRAM256KA: 'SPRAM',
  SB_MAC16: 'DSP multiplier', SB_PLL40_CORE: 'PLL', SB_PLL40_PAD: 'PLL', SB_HFOSC: 'HF oscillator', SB_LFOSC: 'LF oscillator',
}

export class FlowTab {
  constructor(root, ctx) {
    this.root = root
    this.ctx = ctx
    this.open = null
    this.logText = ''
    this.visible = false
    this.root.innerHTML = ''
    this.body = h('div.flow-body')
    this.root.append(this.body)
    new ResizeObserver(() => this.root.classList.toggle('flow-wide', this.root.clientWidth >= 1080)).observe(this.root)
  }

  show() { this.visible = true; this.render() }
  hide() { this.visible = false }
  reset() { this.open = null }

  focusStep(id) { this.open = id; this.render(); this.loadLog() }

  update(state, paths) {
    if (!this.open) {
      const failed = state.flow?.steps?.find((s) => s.state === 'failed')
      if (failed) this.open = failed.id
    }
    if (this.visible) this.render()
    if (this.open && (paths == null || paths.some((p) => p.startsWith(`out/logs/${this.open}.`)))) this.loadLog()
  }

  async loadLog() {
    const id = this.open
    try { this.logText = await this.ctx.apiText('log', { step: id }) } catch { this.logText = '' }
    if (id !== this.open) return
    const el = this.body.querySelector('.logview')
    if (el) this.fillLog(el)
  }

  fillLog(el) {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20
    el.innerHTML = ''
    const lines = this.logText.replace(/\n$/, '').split('\n')
    const shown = lines.length > 4000 ? lines.slice(-4000) : lines
    let firstErr = -1
    shown.forEach((l, k) => {
      const cls = /\b(ERROR|[Ee]rror|FAIL)\b/.test(l) ? 'e' : /\b(Warning|warning:)\b/.test(l) ? 'w' : /^\s*(ok\b|PASS\b)|Program finished normally/.test(l) ? 'o' : ''
      if (cls === 'e' && firstErr < 0) firstErr = k
      el.append(h(cls ? `div.${cls}` : 'div', l || ' '))
    })
    if (!this.logText) el.append(h('div', { style: { color: 'var(--faint)' } }, this.ctx.step(this.open)?.state === 'running' ? 'waiting for output…' : 'nothing printed'))
    const step = this.ctx.step(this.open)
    if (firstErr >= 0 && step?.state === 'failed') el.scrollTop = Math.max(0, el.children[firstErr].offsetTop - 80)
    else if (step?.state === 'running' || atBottom || !this.scrolled) el.scrollTop = el.scrollHeight
    this.scrolled = true
  }

  render() {
    const s = this.ctx.state
    if (!s) return
    const b = this.body
    const keepScroll = b.scrollTop
    b.innerHTML = ''
    const r = s.report
    const flow = s.flow
    if (!flow?.run && !r) {
      b.append(emptyState({ icon: ART.flow, title: 'The flow has not run yet', body: `The agent runs <code>$YOSYS_FLOW ${esc(s.top ?? '&lt;top&gt;')}</code> after every edit: simulate, synthesise, place and route, pack. Each step and its log shows up here as it happens.` }))
      return
    }
    const grid = h('div.flow-grid')
    b.append(grid)
    const colA = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } })
    const colB = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } })
    grid.append(colA, colB)

    // --- the run and its steps
    const run = flow?.run
    const total = run?.finishedAt && run?.startedAt ? run.finishedAt - run.startedAt : null
    const runSub = run
      ? flow.running ? `running for ${duration(Date.now() - run.startedAt)}` : flow.abandoned ? 'interrupted' : `${ago(run.finishedAt)} · ${duration(total)}`
      : ''
    const steps = h('div.card2', h('h4', 'Steps', h('span.sub', runSub), h('span.grow'),
      run ? h('span.note', { style: { fontWeight: 400 } }, `${run.device?.replace(/^--/, '') ?? ''} ${run.package ?? ''}`) : null))
    const list = h('div.steps')
    for (const st of flow?.steps ?? []) {
      const cur = this.open === st.id
      const row = h(`div.step-row${cur ? '.cur' : ''}`, {
        dataset: { state: st.state },
        onclick: () => { this.open = cur ? null : st.id; this.scrolled = false; this.render(); if (this.open) this.loadLog() },
      },
      h('span.ic'),
      h('span', h('span', { style: { fontWeight: 550 } }, st.name), ' ', h('span.tool', TOOL[st.id] ?? '')),
      h('span.ms', st.state === 'running' && st.startedAt ? `${duration(Date.now() - st.startedAt)}…` : st.ms != null ? duration(st.ms) : st.state === 'pending' ? '' : st.state),
      st.log ? h('button.icon-btn', { title: 'Open the log in a drawer', html: ICONS.log, onclick: (e) => { e.stopPropagation(); this.ctx.openLog(st.id) } }) : h('span'),
      st.state === 'failed' && st.error ? h('span.err', st.error) : st.state === 'running' && st.last ? h('span.err', { style: { color: 'var(--accent)' } }, st.last) : null)
      list.append(row)
      if (cur) {
        const lv = h('div.logview')
        list.append(lv)
        requestAnimationFrame(() => this.fillLog(lv)) // once attached, so it can scroll to the error
      }
    }
    steps.append(list)
    colA.append(steps)

    // --- findings
    const findings = r?.findings ?? []
    if (findings.length) {
      const card = h('div.card2', h('h4', 'Findings', h('span.sub', `${findings.filter((f) => f.severity === 'error').length} errors · ${findings.filter((f) => f.severity === 'warning').length} warnings`)))
      const box = h('div')
      for (const f of findings.slice(0, 80)) {
        const m = /^([^:]+\.(?:s?v|pcf)):?(\d+)?/.exec(f.ref ?? '')
        box.append(h(`div.finding.${f.severity}`, h('i.sev'), h('div', { style: { minWidth: 0 } }, f.message,
          f.ref ? h('div', h('span.ref', { onclick: () => (m ? this.ctx.openSource(m[1], m[2] ? Number(m[2]) : undefined) : f.ref.startsWith('out/logs/') ? this.ctx.openLog(f.ref.replace(/^out\/logs\/|\.log$/g, '')) : null) }, f.ref)) : null)))
      }
      card.append(box)
      colA.append(card)
    }

    // --- testbench
    const checks = r?.simulation?.checks ?? []
    if (checks.length || r?.simulation) {
      const passes = checks.filter((l) => /^ok\b/i.test(l)).length
      const fails = checks.filter((l) => /^FAIL\b/.test(l) && !/checks? failed/i.test(l)).length
      const card = h('div.card2', h('h4', 'Testbench', h('span.sub', checks.length ? `${passes} passed${fails ? ` · ${fails} failed` : ''}` : 'no checks printed'), h('span.grow'),
        h('a', { href: '#', style: { fontSize: '11.5px', fontWeight: 400 }, onclick: (e) => { e.preventDefault(); this.ctx.openSource(`tb/${s.top}_tb.v`) } }, `tb/${s.top}_tb.v`)))
      const box = h('div.checks')
      for (const l of checks) {
        const fail = /^FAIL\b/.test(l)
        const sum = /^(PASS|FAIL)\b/.test(l) && /checks?/i.test(l)
        box.append(h(`div.check${fail ? '.fail' : /^ok\b/i.test(l) || /^PASS/.test(l) ? '.ok' : ''}${sum ? '.sum' : ''}`,
          h('span.m', fail ? '✕' : '✓'), h('span', l.replace(/^(ok|FAIL|PASS)\s+/, ''))))
      }
      if (!checks.length) box.append(h('div.check', h('span.m', '·'), h('span', { style: { color: 'var(--faint)' } }, 'The testbench printed no ok / PASS / FAIL lines.')))
      card.append(box)
      colB.append(card)
    }

    // --- bitstream
    if (r?.bitstream) {
      const cmd = r.bitstream.flash
      colB.append(h('div.card2', h('h4', 'Bitstream', h('span.sub', `${bytes(r.bitstream.bytes)} · ${r.board?.name ?? 'iCE40'}`)),
        h('div.inner',
          h('div.kv', h('span.k', 'file'), h('span.v.mono', r.bitstream.path)),
          h('div.note', { style: { marginTop: '6px' } }, 'Plug the board in over USB and flash it:'),
          h('div.flash', h('code', cmd), h('button.btn', {
            title: 'Copy',
            onclick: async (e) => {
              const btn = e.currentTarget
              try { await navigator.clipboard.writeText(cmd); btn.lastChild.textContent = 'Copied' } catch { btn.lastChild.textContent = 'Select it' }
              setTimeout(() => { btn.lastChild.textContent = 'Copy' }, 1400)
            },
          }, h('span', { html: ICONS.copy }), h('span', 'Copy'))))))
    }

    // --- cells
    const types = r?.synthesis?.byType ?? {}
    if (Object.keys(types).length) {
      colB.append(h('div.card2', h('h4', 'Cells after synthesis', h('span.sub', `${r.synthesis.cells} cells · yosys synth_ice40`)),
        h('div.types', Object.entries(types).map(([k, v]) => h('div', { title: CELL_NOTES[k] ?? '' }, h('span.mono', k), h('b', String(v)))))))
    }

    // --- sources
    if (s.sources?.length) {
      colB.append(h('div.card2', h('h4', 'Sources'),
        h('div.inner', s.sources.map((f) => h('div.kv',
          h('a.mono', { href: '#', onclick: (e) => { e.preventDefault(); this.ctx.openSource(f.path) } }, f.path),
          h('span.v.note', `${bytes(f.size)} · ${ago(f.mtime)}`))))))
    }
    b.scrollTop = keepScroll
  }

  key() {}
}
