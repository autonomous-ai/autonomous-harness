---
name: yosys
description: Write synthesisable Verilog-2005 for an iCE40 FPGA and take it to a bitstream — the language subset that synthesises, the testbench shape the pane draws waves from, the iCEBreaker pinout, how to read the utilisation and Fmax report, the mistakes that cost you a day (inferred latches, multi-driven nets, blocking assignments in sequential logic, missing reset), and ready-made UART / PWM / debounce blocks. Use whenever writing, simulating, synthesising or debugging RTL in this workspace.
---

# Verilog to a bitstream, with the open-source flow

Six tools, one command, and a strict subset of one language. Everything below is what actually
passes through Icarus Verilog, Yosys, nextpnr and icepack — not what the standard permits.

## The flow

```sh
"$YOSYS_FLOW" blink            # the whole thing, for top module `blink`
```

| step | tool | in | out |
|---|---|---|---|
| sim | `iverilog -g2012` + `vvp` | `rtl/*.v` + `tb/blink_tb.v` | `out/sim.vcd`, PASS/FAIL on stdout |
| waves | `vcd2json.py` | `out/sim.vcd` | `out/waves.json` — a signal summary for the verdict (the pane reads the VCD itself) |
| synth | `yosys synth_ice40` | `rtl/*.v` | `out/blink.json` — the iCE40 netlist, and cell counts |
| schematic | `yosys prep` | `rtl/*.v` | `out/blink_schematic.json` — technology-independent |
| svg | `netlistsvg` | that JSON | `out/blink.svg` — the top module drawn (the pane draws every module of the hierarchy) |
| pnr | `nextpnr-ice40 --up5k --package sg48` | netlist + `constraints/blink.pcf` | `out/blink.asc`, `out/blink_pnr.json` (utilisation, Fmax, critical paths), `out/blink_routed.json` (placement and routing — the pane's floorplan) |
| pack | `icepack` | `.asc` | **`out/blink.bin`** — the bitstream |

Each step's full output is at `out/logs/<step>.log`, with `<step>.start`, `<step>.time` and
`<step>.exit` beside it and `out/logs/run.json` for the run as a whole — the pane reads those to show
which step is running. The flow does not stop the world on a failure: synthesis still runs when
simulation fails, so you see every problem at once.

Single steps, when you are iterating on one thing:

```sh
iverilog -g2012 -o out/sim.vvp rtl/*.v tb/blink_tb.v && vvp out/sim.vvp   # just the simulation
yosys -p "read_verilog rtl/*.v; synth_ice40 -top blink; stat"             # just the cell count
```

Then always finish with the full `"$YOSYS_FLOW" <top>` so the pane and the verdict are current.

## The synthesisable subset

Yosys turns a description of hardware into gates. Anything that does not describe hardware is
either rejected or, worse, quietly turned into something you did not mean.

**Always**

```verilog
`default_nettype none        // first line of every file: an undeclared name is now an error,
                             // not a silent 1-bit wire. This catches every typo'd port.

module counter #(
    parameter integer WIDTH = 8          // parameters, not `define — they are per-instance
) (
    input  wire              clk,
    input  wire              rst,
    input  wire              en,
    output reg  [WIDTH-1:0]  count       // a port assigned in an always block is `reg`
);

    always @(posedge clk) begin          // ONE clock, ONE edge, no other signal in the list
        if (rst)      count <= {WIDTH{1'b0}};
        else if (en)  count <= count + 1'b1;
    end

endmodule

`default_nettype wire        // last line: put it back, so other files are not surprised
```

Rules that are not negotiable:

- **`<=` in `always @(posedge clk)`, `=` in `always @(*)`.** Non-blocking for flip-flops, blocking
  for combinational logic. Mixing them is the single most common source of "it simulates but does
  not synthesise the same".
- **A signal is driven from exactly one `always` block** (or one `assign`), never two. Two drivers
  is an error in synthesis and an `x` in simulation.
- **Every `always @(*)` assigns every output on every path.** An `if` without an `else`, or a
  `case` without a `default`, infers a *latch* — see the pitfalls below.
- **Sized literals everywhere**: `8'd0`, `4'b1010`, `16'hBEEF`, `{WIDTH{1'b0}}`. A bare `0` is
  32 bits and will silently widen an expression.
- **`$clog2(N)`** for a counter's width. It is Verilog-2005 and Yosys supports it.
- No `initial` blocks for logic (initial *values* on a `reg` are fine and do synthesise on iCE40 —
  the bitstream sets the flip-flops). No `#delays`. No `fork`/`join`. No `while`/`forever`. No
  `real`. `for` loops only with constant bounds — they unroll into copies of hardware.
- Multiplication by a constant power of two is a shift and is free; `*` by a variable costs a lot
  of LUTs (the UP5K has 8 DSP blocks, `synth_ice40 -dsp` maps to them). Division is not free and
  usually means you want a different algorithm.

**State machines** — two blocks, always:

```verilog
localparam [1:0] IDLE = 2'd0, RUN = 2'd1, DONE = 2'd2;
reg [1:0] state, next;

always @(posedge clk)                    // the register
    if (rst) state <= IDLE; else state <= next;

always @(*) begin                        // the transition, fully assigned
    next = state;                        // <-- the default that prevents a latch
    case (state)
        IDLE: if (start) next = RUN;
        RUN:  if (done)  next = DONE;
        DONE:            next = IDLE;
        default:         next = IDLE;
    endcase
end
```

## The testbench

One per top module, at `tb/<top>_tb.v`. The shape matters: the pane draws its waves from the VCD,
and the verdict reads the word `FAIL`.

```verilog
`timescale 1ns / 1ps
`default_nettype none

module counter_tb;
    reg clk = 1'b0, rst = 1'b1, en = 1'b0;
    wire [7:0] count;
    integer errors = 0;

    counter #(.WIDTH(8)) dut (.clk(clk), .rst(rst), .en(en), .count(count));

    always #5 clk = ~clk;                       // a 100 MHz clock: 10 ns period

    task check(input condition, input [8*40-1:0] what);   // NOT `expect` — reserved in -g2012
        begin
            if (condition) $display("  ok   %0s", what);
            else begin errors = errors + 1; $display("  FAIL %0s (at %0t)", what, $time); end
        end
    endtask

    initial begin
        $dumpfile("out/sim.vcd");               // exactly this path — the flow reads it
        $dumpvars(0, counter_tb);               // 0 = this scope and everything under it

        repeat (2) @(posedge clk); rst = 1'b0; en = 1'b1;
        repeat (5) @(posedge clk); #1;
        check(count == 8'd5, "counts five clocks");

        if (errors == 0) $display("PASS  counter: %0d checks", 3);
        else             $display("FAIL  counter: %0d check(s) failed", errors);
        $finish;                                 // ALWAYS: without it vvp runs forever
    end
endmodule
```

- **`#1` after `@(posedge clk)` before checking.** At the edge itself the non-blocking update has
  not landed yet; one time unit later it has.
- **Simulate in shrunken time.** A 1 Hz blink off a 12 MHz clock is 12 million cycles. Parameterise
  the design (`CLK_HZ`) and override it in the testbench (`.CLK_HZ(16)`), so the same RTL runs in a
  hundred clocks. Never change the RTL to make the test fast.
- `$dumpvars(0, tb)` dumps everything including the DUT's internals — that is what you want: the
  pane's Waves tab browses every scope, shows parameters with their values, and opens on the DUT's
  ports and registers. A line named `tx`/`rx` is decoded as UART (baud measured off the line); an
  8-bit bus named `data`/`byte`/`char` starts in ASCII. Keep a dump under a few tens of millions of
  changes — `$dumpoff` around a long quiet stretch, as `hello_uart`-style testbenches do.
- The word `FAIL` anywhere in the output fails the verdict. Do not print it in passing messages.

## The board: iCEBreaker, iCE40UP5K-SG48

5280 logic cells, 30 × 4 kbit block RAMs, 4 × 16 kB single-port RAMs, 8 DSP blocks, 1 PLL.
Pin numbers are the board's, from
[the iCEBreaker project's own constraints file](https://codeberg.org/icebreaker-fpga/icebreaker-verilog-examples/src/branch/main/icebreaker/icebreaker.pcf).

```
set_io -nowarn clk   35     # 12 MHz oscillator
set_frequency clk 12        # nextpnr's extension: this is what Fmax is measured against
set_io -nowarn btn_n 10     # on-board button   — ACTIVE LOW (0 = pressed)
set_io -nowarn ledr_n 11    # red LED           — ACTIVE LOW (0 = lit)
set_io -nowarn ledg_n 37    # green LED         — ACTIVE LOW (0 = lit)
set_io -nowarn rx     6     # UART from the on-board FTDI (FPGA's point of view)
set_io -nowarn tx     9     # UART to the FTDI
```

The full board — RGB LED (39/40/41), SPI flash, PMOD 1A/1B/2, and the snap-off section's five
**active-high** LEDs and three buttons — is commented out in `constraints/blink.pcf`; uncomment
what you use. `-nowarn` lets one PCF carry pins the current design does not have.

Every port of the top module needs a `set_io` line, or nextpnr fails with "unconstrained IO".
Nothing else in the design does; internal signals are routed automatically.

Another board: change `constraints/<top>.pcf` and set `YOSYS_DEVICE` / `YOSYS_PACKAGE`
(e.g. `YOSYS_DEVICE=--hx8k YOSYS_PACKAGE=ct256` for the HX8K breakout).

## Reading the report

`out/<top>.report.json` is what the pane draws; read it when you want the numbers in words.

- **`synthesis.byType`** — what Yosys mapped the design to. `SB_LUT4` is a 4-input lookup table,
  `SB_DFFSR`/`SB_DFFE` are flip-flops, `SB_CARRY` is the fast carry chain an adder uses,
  `SB_RAM40_4K` is block RAM. Roughly: a logic cell is one LUT4 + one flip-flop, so
  `ICESTORM_LC` ≈ max(LUTs, FFs) after packing, not their sum.
- **`pnr.utilization`** — used / available per resource, with a percentage. Under 70 % is
  comfortable; over 90 % and nextpnr starts to struggle to route.
- **`pnr.clocks[].achievedMHz` vs `constraintMHz`** — the design closes at the first, the PCF's
  `set_frequency` asks for the second. `pass: false` means the critical path is too long: the fix
  is to break it with a pipeline register, not to lower the clock, unless lowering it is honest.
  The path itself, hop by hop with the RTL line of each net, is `critical_paths` in
  `out/<top>_pnr.json` — and drawn on the floorplan in the pane's Chip tab.
- **`bitstream.path`** — `out/<top>.bin`, and `iceprog out/<top>.bin` flashes a board over USB
  (install `icestorm`'s `iceprog`; the user needs the board plugged in).

## Pitfalls that cost a day

**Inferred latch.** A combinational block that does not assign an output on every path becomes a
level-sensitive latch — which on an FPGA is built out of a LUT feeding itself, is not timed, and
glitches. Yosys says `Warning: ... latch` and the verdict raises it.

```verilog
always @(*) if (sel) y = a;              // BAD: what is y when sel is 0? A latch.
always @(*) begin y = 1'b0; if (sel) y = a; end   // GOOD: a default first.
```

**Multi-driven net.** Two `always` blocks (or an `always` and an `assign`) writing the same signal.
Simulation shows `x`, synthesis errors with "conflicting drivers". One signal, one driver.

**Blocking assignment in sequential logic.** `always @(posedge clk) begin a = b; c = a; end` makes
*one* flip-flop and a wire; with `<=` it makes two flip-flops in a shift register. Simulation and
synthesis can disagree about which you meant. Use `<=`.

**An asynchronous input sampled directly.** A button or an incoming UART line is not synchronous to
your clock; sampling it straight into logic causes metastability. Two flip-flops first, always:

```verilog
reg [1:0] sync;
always @(posedge clk) sync <= {sync[0], btn_n};
wire btn_safe = sync[1];
```

**Reset that is not thought about.** On iCE40 a `reg x = 1'b0;` initial value *is* honoured — the
bitstream loads it — so a global reset is often unnecessary. If you do use one, use it
synchronously (`if (rst)` inside `@(posedge clk)`) and on every register in the block.

**A counter one bit too narrow.** `reg [7:0] c; if (c == 300)` never fires. Size from the constant:
`reg [$clog2(LIMIT)-1:0]`.

**Width mismatch.** `wire [7:0] a = b + c;` where `b`,`c` are 8-bit silently drops the carry. Widen
first: `{1'b0, b} + {1'b0, c}`.

**`$finish` missing.** `vvp` runs forever and the flow hangs. Every testbench ends with `$finish`.

## Blocks you will need

**Clock divider / strobe** — one cycle high every N clocks, which is how you make anything slow:

```verilog
localparam integer DIV = CLK_HZ / RATE_HZ;
reg [$clog2(DIV)-1:0] div = 0;
reg tick = 1'b0;
always @(posedge clk) begin
    tick <= 1'b0;
    if (div == DIV - 1) begin div <= 0; tick <= 1'b1; end
    else                       div <= div + 1'b1;
end
```

**PWM** — `duty` out of 2^BITS, no multiplier, one adder:

```verilog
module pwm #(parameter integer BITS = 8) (
    input wire clk, input wire [BITS-1:0] duty, output wire out
);
    reg [BITS-1:0] acc = 0;
    always @(posedge clk) acc <= acc + 1'b1;
    assign out = (acc < duty);
endmodule
```

(For an LED, gamma matters: perceived brightness goes as roughly the square of `duty`.)

**Button debounce** — hold the input steady for a few milliseconds before believing it:

```verilog
module debounce #(parameter integer COUNT = 12_000) (   // 1 ms at 12 MHz
    input wire clk, input wire in, output reg out = 1'b0
);
    reg [1:0] sync = 2'b00;
    reg [$clog2(COUNT)-1:0] n = 0;
    always @(posedge clk) begin
        sync <= {sync[0], in};
        if (sync[1] == out) n <= 0;
        else if (n == COUNT - 1) begin out <= sync[1]; n <= 0; end
        else n <= n + 1'b1;
    end
endmodule
```

**UART transmitter** — 8N1, at `CLK_HZ / BAUD` clocks per bit (12 MHz / 115200 = 104):

```verilog
module uart_tx #(parameter integer CLK_HZ = 12_000_000, parameter integer BAUD = 115_200) (
    input  wire       clk,
    input  wire       send,          // pulse high for one clock
    input  wire [7:0] data,
    output reg        tx    = 1'b1,  // idles high
    output wire       busy
);
    localparam integer DIV = CLK_HZ / BAUD;
    reg [$clog2(DIV)-1:0] cnt = 0;
    reg [3:0]             bit_i = 4'd0;   // 0 = idle, 1 = start, 2..9 = data, 10 = stop
    reg [7:0]             shift = 8'd0;

    assign busy = (bit_i != 4'd0);

    always @(posedge clk) begin
        if (!busy) begin
            if (send) begin shift <= data; bit_i <= 4'd1; cnt <= 0; tx <= 1'b0; end
        end else if (cnt == DIV - 1) begin
            cnt <= 0;
            case (bit_i)
                4'd10:   begin tx <= 1'b1; bit_i <= 4'd0; end      // stop bit done
                default: begin tx <= shift[0]; shift <= {1'b0, shift[7:1]}; bit_i <= bit_i + 1'b1; end
            endcase
            if (bit_i == 4'd9) tx <= 1'b1;                          // the stop bit itself
        end else cnt <= cnt + 1'b1;
    end
endmodule
```

Test a UART by counting the bit times in the testbench, not by eye on the waveform.

**Block RAM** — a plain inferred array; Yosys maps it to `SB_RAM40_4K` when it is big enough:

```verilog
reg [7:0] mem [0:255];
always @(posedge clk) begin
    if (we) mem[addr] <= din;
    dout <= mem[addr];                 // registered read — required for block RAM inference
end
```

An asynchronous read (`assign dout = mem[addr];`) is *not* block RAM; it becomes hundreds of LUTs.

## Adding a module

1. `rtl/<name>.v`, one module per file, `default_nettype none` at the top.
2. Instantiate it from the top module **by name**: `uart_tx #(.BAUD(115200)) u (.clk(clk), ...)`.
   Positional connections are how ports get swapped.
3. Add its checks to `tb/<top>_tb.v` — or give it its own `tb/<name>_tb.v` and run
   `"$YOSYS_FLOW" <name>` to exercise it alone.
4. New top-level ports need new `set_io` lines in `constraints/<top>.pcf`.
5. Run the flow. Read the findings. Fix. Repeat.
