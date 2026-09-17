// The pane's readers, without a browser or a toolchain: `npm test` (or node --test viewer/test/*.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extendBits, parseVcd, tickFs, vcdMeta, vcdSignal } from '../lib/vcd.mjs'
import { buildChip, moduleOf, routeSegments, tilesFromText } from '../lib/chip.mjs'
import { cleanModuleName, hierarchy, moduleForRender, moduleIndex, paramsOf } from '../lib/netlist.mjs'
import { errorLine, findTop, flowState, parsePcf } from '../lib/workspace.mjs'
import { formatValue, uartDecode, uartTiming } from '../public/wavecore.js'

// Trimmed from Icarus: two $dumpvars make the testbench scope appear twice, a task scope, a
// parameter, aliases between the testbench and the DUT, left-truncated buses, and $dumpoff.
const VCD = `$date today $end
$version Icarus Verilog $end
$timescale 1ps $end
$scope module tb $end
$var wire 1 ! tx $end
$var reg 1 " clk $end
$var parameter 32 # BIT $end
$upscope $end
$scope module tb $end
$scope module dut $end
$var wire 1 ! tx $end
$var wire 1 " clk $end
$var reg 8 $ data [7:0] $end
$scope task check $end
$var reg 1 % condition $end
$upscope $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
b1101000 #
1!
0"
bx $
$end
#5
1"
b1001000 $
#10
0"
#10
1"
#15
0"
b1 $
#20
$dumpoff
x!
x"
bx $
$end
`

test('timescale and bit extension', () => {
  assert.equal(tickFs('1ps'), 1e3)
  assert.equal(tickFs('10 ns'), 1e7)
  assert.equal(tickFs('nonsense'), 1e3)
  assert.equal(extendBits('1', 4), '0001')
  assert.equal(extendBits('x1', 4), 'xxx1')
  assert.equal(extendBits('z', 3), 'zzz')
  assert.equal(extendBits('0101', 4), '0101')
})

test('scopes merge by path, aliases share a signal, parameters keep their value', () => {
  const p = parseVcd(VCD)
  assert.deepEqual(p.scopes.map((s) => s.path), ['tb'])
  const tb = p.scopes[0]
  assert.deepEqual(tb.vars.map((v) => v.name), ['tx', 'clk', 'BIT'])
  assert.deepEqual(tb.children.map((c) => c.path), ['tb.dut'])
  assert.deepEqual(tb.children[0].children.map((c) => [c.name, c.kind]), [['check', 'task']])
  const dutTx = tb.children[0].vars.find((v) => v.name === 'tx')
  assert.equal(dutTx.id, '!')
  assert.equal(p.vars.find((v) => v.name === 'BIT').value, '00000000000000000000000001101000')
  const data = p.vars.find((v) => v.name === 'data')
  assert.equal(data.width, 8)
  assert.equal(data.msb, 7)
  assert.equal(data.lsb, 0)
  assert.equal(p.end, 20)
  assert.equal(p.timescale, '1ps')
})

test('changes: repeats dropped, same tick collapses, buses extended, $dumpoff is x', () => {
  const p = parseVcd(VCD)
  const clk = p.signals.get('"')
  // 0@0, 1@5, (0 then 1)@10 collapses to "still 1" and is dropped, 0@15, x@20
  assert.deepEqual(clk.times, [0, 5, 15, 20])
  assert.deepEqual(clk.values, ['0', '1', '0', 'x'])
  const data = p.signals.get('$')
  assert.deepEqual(data.values, ['xxxxxxxx', '01001000', '00000001', 'xxxxxxxx'])
  const s = vcdSignal(p, '"')
  assert.deepEqual(s.t, [0, 5, 10, 5])
  assert.equal(s.v, '010x')
  const meta = vcdMeta(p)
  assert.equal(meta.changes['"'], 4)
  assert.equal(meta.scopes[0].vars.find((v) => v.name === 'BIT').value.length, 32)
})

test('radixes', () => {
  assert.equal(formatValue('01001000', 'hex', 8), '48')
  assert.equal(formatValue('01001000', 'ascii', 8), "'H'")
  assert.equal(formatValue('00001010', 'ascii', 8), "'\\n'")
  assert.equal(formatValue('0000000001001000' + '01001001', 'ascii', 24), '"HI"')
  assert.equal(formatValue('11111111', 'sdec', 8), '-1')
  assert.equal(formatValue('11111111', 'dec', 8), '255')
  assert.equal(formatValue('101', 'oct', 3), '5')
  assert.equal(formatValue('0x01', 'hex', 4), 'x')
  assert.equal(formatValue('0000x001', 'hex', 8), '0x')
  assert.equal(formatValue('1'.repeat(64), 'dec', 64), '18446744073709551615')
  assert.equal(formatValue('1', 'hex', 1), '1')
})

/** An idle-high line carrying bytes at `bit` ticks per bit, 8N1, with idle gaps between them. */
function serial(bytes, bit) {
  const t = [0], v = ['1']
  let now = bit * 7
  const put = (level) => {
    if (v[v.length - 1] === level) return
    t.push(now); v.push(level)
  }
  for (const b of bytes) {
    const bits = ['0', ...Array.from({ length: 8 }, (_, k) => ((b >> k) & 1 ? '1' : '0')), '1']
    for (const x of bits) { put(x); now += bit }
    now += bit * 3
  }
  return { t: Float64Array.from(t), v: v.join(''), scalar: true, width: 1 }
}

test('UART: baud from the line, bytes from the frames', () => {
  const bit = 8680555 // ps per bit at 115200 baud; a 1 ps timescale is tickFs 1000
  const d = serial([...'HELLO\n'].map((c) => c.charCodeAt(0)), bit)
  const timing = uartTiming(d, 1000)
  assert.ok(timing)
  assert.equal(timing.baud, 115200)
  const frames = uartDecode(d, timing.bit)
  assert.equal(String.fromCharCode(...frames.map((f) => f.byte)), 'HELLO\n')
  assert.ok(frames.every((f) => !f.err))
})

test('PCF: set_io flags, commented pins, set_frequency', () => {
  const pcf = parsePcf('set_io -nowarn clk 35\nset_frequency clk 12\n#   set_io -nowarn tx 9\nset_io -pullup yes btn_n 10  # the button\n')
  assert.deepEqual(pcf.frequencies, { clk: 12 })
  assert.equal(pcf.ios.length, 3)
  assert.deepEqual(pcf.ios[0], { port: 'clk', pin: '35', line: 1, commented: false, nowarn: true })
  assert.equal(pcf.ios[1].commented, true)
  assert.equal(pcf.ios[2].pullup, 'yes')
  assert.equal(pcf.ios[2].port, 'btn_n')
})

test('floorplan: tiles, modules, routes', () => {
  const grid = tilesFromText('.comment x\n.device 5k\n.io_tile 1 0\n0101\n.logic_tile 1 1\n.ramb_tile 6 1\n.dsp0_tile 0 5\n')
  assert.equal(grid.device, '5k')
  assert.equal(grid.width, 7)
  assert.equal(grid.height, 6)
  assert.equal(grid.rows[0][1], 'I')
  assert.equal(grid.rows[1][1], 'L')
  assert.equal(grid.rows[1][6], 'B')
  assert.equal(grid.rows[5][0], 'D')
  assert.equal(moduleOf('u_uart.left_SB_DFFESS_Q_D_SB_LUT4_O_LC'), 'u_uart')
  assert.equal(moduleOf('a.b.c_LC'), 'a.b')
  assert.equal(moduleOf('send_SB_LUT4_I2_LC'), '')
  assert.equal(moduleOf('$abc$123$auto$blifparse.cc:1'), '')
  // lutff_6 in X9/Y5 drives a span-4 at X9/Y8, which drives a local wire in X9/Y4
  const r = routeSegments('X9/Y5/lutff_6:out;;1;X9/Y8/sp4_v_b_9;X9/Y5/9.5.lutff_6:out.->.9.8.sp4_v_b_9;1;X9/Y4/local_g1_5;X9/Y4/9.8.sp4_v_b_9.->.9.4.local_g1_5;1')
  assert.deepEqual(r, { segs: [9, 5, 9, 4], global: false })
  assert.equal(routeSegments('X12/Y2/lutff_global:clk;X12/Y2/0.1.glb_netwk_4.->.12.2.lutff_global:clk;1').global, true)

  const chip = buildChip({
    asc: '.device 5k\n.logic_tile 9 5\n.io_tile 9 0\n',
    routed: {
      modules: {
        top: {
          settings: { 'arch.type': 'up5k', 'arch.package': 'sg48' },
          cells: {
            'u_uart.cnt_SB_DFF_Q_LC': { type: 'ICESTORM_LC', parameters: { DFF_ENABLE: '1', CARRY_ENABLE: '0', LUT_INIT: '0000000000000010' }, attributes: { NEXTPNR_BEL: 'X9/Y5/lc3' }, port_directions: { O: 'output', I0: 'input' }, connections: { O: [7], I0: [8] } },
            'tx$sb_io': { type: 'SB_IO', parameters: {}, attributes: { NEXTPNR_BEL: 'X9/Y0/io1' }, port_directions: { D_OUT_0: 'input' }, connections: { D_OUT_0: [7] } },
          },
          netnames: { 'u_uart.cnt[0]': { bits: [7], attributes: { ROUTING: 'X9/Y5/lutff_3:out;;1;X9/Y0/io_1:D_OUT_0;X9/Y1/9.5.lutff_3:out.->.9.0.io_1:D_OUT_0;1' } } },
        },
      },
    },
    report: { utilization: { ICESTORM_LC: { used: 1, available: 5280 } }, fmax: {}, critical_paths: [] },
  })
  assert.deepEqual(chip.modules, ['', 'u_uart'])
  assert.equal(chip.cells[0].ff, 1)
  assert.equal(chip.cells[0].lut, 1)
  assert.equal(chip.cells[0].b, 'lc3')
  assert.equal(chip.nets[0].d, 0)
  assert.deepEqual(chip.nets[0].k, [1])
  assert.deepEqual(chip.nets[0].s, [9, 5, 9, 1])
  assert.ok(chip.pins.some((p) => p.pin === '35' && p.x === 12 && p.y === 31))
})

test('netlist: readable module names, hierarchy, a module on its own', () => {
  const nl = {
    modules: {
      '$paramod$abc\\uart_tx': { attributes: {}, parameter_default_values: { BAUD: '00000000000000011100001000000000' }, ports: { tx: { direction: 'output', bits: [2] } }, cells: {}, netnames: { tx: { bits: [2] } } },
      top: {
        attributes: { top: '00000000000000000000000000000001', src: 'rtl/top.v:1.1-9.9' },
        ports: { clk: { direction: 'input', bits: [2] } },
        cells: {
          u_uart: { type: '$paramod$abc\\uart_tx', connections: { tx: [3] }, port_directions: { tx: 'output' }, attributes: { src: 'rtl/top.v:5.1-5.20' } },
          '$reduce_or$x': { type: '$reduce_or', connections: {}, port_directions: {}, attributes: {} },
          '$and$y': { type: '$and', connections: {}, port_directions: {}, attributes: {} },
        },
        netnames: { clk: { bits: [2] }, '$0\\q[0:0]': { hide_name: 1, bits: [3] }, q: { bits: [3] } },
      },
    },
  }
  assert.equal(cleanModuleName('$paramod$abc\\uart_tx'), 'uart_tx')
  assert.equal(cleanModuleName("$paramod\\breathe\\STEP_DIV=s32'01"), 'breathe')
  assert.deepEqual(paramsOf(nl.modules['$paramod$abc\\uart_tx']), { BAUD: '115200' })
  const tree = hierarchy(nl)
  assert.equal(tree.label, 'top')
  assert.deepEqual(tree.children.map((c) => [c.name, c.label, c.path, c.params.BAUD]), [['u_uart', 'uart_tx', 'u_uart', '115200']])
  const one = moduleForRender(nl, 'top', new Set(['$and']))
  assert.deepEqual(Object.keys(one.modules), ['top'])
  assert.equal(one.modules.top.attributes.top, 1)
  assert.equal(one.modules.top.cells.u_uart.type, 'uart_tx u_uart')
  assert.equal(one.modules.top.cells['$reduce_or$x'].type, 'reduce_or')
  assert.equal(one.modules.top.cells['$and$y'].type, '$and')
  const idx = moduleIndex(nl, 'top')
  assert.deepEqual(idx.nets['3'].names, ['q', '$0\\q[0:0]'])
  assert.equal(idx.cells.u_uart.module, '$paramod$abc\\uart_tx')
  assert.equal(idx.ports.clk.direction, 'input')
})

test('flow state: running, done, failed with its error line, skipped once the run is over', () => {
  const ws = mkdtempSync(join(tmpdir(), 'yosys-pane-'))
  try {
    const logs = join(ws, 'out', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(ws, 'out', '.top'), 'blink\n')
    writeFileSync(join(logs, 'run.json'), JSON.stringify({ top: 'blink', pid: process.pid, startedAt: 1, finishedAt: null }))
    writeFileSync(join(logs, 'sim.start'), '1000\n')
    writeFileSync(join(logs, 'sim.time'), '1000 1750\n')
    writeFileSync(join(logs, 'sim.exit'), '0\n')
    writeFileSync(join(logs, 'sim.log'), '  ok   one\nPASS\n')
    writeFileSync(join(logs, 'synth.start'), '2000\n')
    writeFileSync(join(logs, 'synth.log'), 'reading\n3.1 Executing PROC\n')
    let st = flowState(ws)
    assert.equal(findTop(ws, ''), 'blink')
    assert.equal(st.running, true)
    assert.equal(st.steps[0].state, 'done')
    assert.equal(st.steps[0].ms, 750)
    assert.equal(st.steps[2].state, 'running')
    assert.equal(st.steps[2].last, '3.1 Executing PROC')
    assert.equal(st.steps[5].state, 'pending')

    writeFileSync(join(logs, 'synth.exit'), '1\n')
    writeFileSync(join(logs, 'synth.log'), 'reading\nrtl/blink.v:3: ERROR: syntax error, unexpected TOK_END\nEnd of script.\n')
    writeFileSync(join(logs, 'run.json'), JSON.stringify({ top: 'blink', pid: process.pid, startedAt: 1, finishedAt: 3000 }))
    st = flowState(ws)
    assert.equal(st.running, false)
    assert.equal(st.steps[2].state, 'failed')
    assert.equal(st.steps[2].error, 'rtl/blink.v:3: ERROR: syntax error, unexpected TOK_END')
    assert.equal(st.steps[1].state, 'skipped')
    assert.equal(st.steps[5].state, 'skipped')

    // a run whose process is gone and never finished was interrupted, not running forever
    writeFileSync(join(logs, 'run.json'), JSON.stringify({ top: 'blink', pid: 2 ** 22 + 12345, startedAt: 1, finishedAt: null }))
    rmSync(join(logs, 'synth.exit'))
    st = flowState(ws)
    assert.equal(st.abandoned, true)
    assert.equal(st.steps[2].state, 'interrupted')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
  assert.equal(errorLine('fine\n  ok   no error here\nError: it broke\n'), 'Error: it broke')
})
