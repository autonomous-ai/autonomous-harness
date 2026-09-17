// blink_tb.v — the testbench for blink.v.
//
// Every testbench in this workspace follows the same shape:
//   1. `$dumpfile("out/sim.vcd")` and `$dumpvars(0, <tb name>)`, so the pane can draw the waves;
//   2. a clock;
//   3. checks that print PASS or FAIL — the verdict reads "FAIL" as a failed simulation;
//   4. `$finish`, always, so `vvp` returns instead of running forever.
//
// Simulating 12 million clocks per blink would take minutes, so the design's parameters are
// overridden to a 16 Hz "clock": HALF = 16 / 2 = 8 cycles. The RTL under test is unchanged.

`timescale 1ns / 1ps
`default_nettype none

module blink_tb;

    localparam integer CLK_HZ   = 16;
    localparam integer BLINK_HZ = 1;
    localparam integer HALF     = CLK_HZ / (2 * BLINK_HZ);  // 8 clocks between toggles
    localparam integer PERIODS  = 6;

    reg  clk   = 1'b0;
    reg  btn_n = 1'b1;
    wire ledg_n;
    wire ledr_n;

    integer errors  = 0;
    integer toggles = 0;
    reg     last_g;

    blink #(.CLK_HZ(CLK_HZ), .BLINK_HZ(BLINK_HZ)) dut (
        .clk   (clk),
        .btn_n (btn_n),
        .ledg_n(ledg_n),
        .ledr_n(ledr_n)
    );

    always #5 clk = ~clk;  // 10 ns period

    // Count every change of the green LED.
    initial last_g = 1'bx;
    always @(posedge clk) begin
        if (last_g !== 1'bx && ledg_n !== last_g) toggles = toggles + 1;
        last_g = ledg_n;
    end

    // `check` is the shape every testbench here uses: one line per assertion, the word FAIL on the
    // ones that did not hold. (Do not call this task `expect` — that is a reserved word in -g2012.)
    task check(input condition, input [8*40-1:0] what);
        begin
            if (condition) begin
                $display("  ok   %0s", what);
            end else begin
                errors = errors + 1;
                $display("  FAIL %0s (at %0t)", what, $time);
            end
        end
    endtask

    initial begin
        $dumpfile("out/sim.vcd");
        $dumpvars(0, blink_tb);

        // The button is released: the red LED is dark (active low, so high).
        @(posedge clk);
        check(ledr_n === 1'b1, "red LED dark while button released");

        // Press it: the red LED lights.
        btn_n = 1'b0;
        #1;
        check(ledr_n === 1'b0, "red LED lit while button held");
        btn_n = 1'b1;

        // Let the counter run: HALF clocks per toggle, so PERIODS full blinks are 2*PERIODS toggles.
        repeat (2 * PERIODS * HALF + 2) @(posedge clk);
        check(toggles >= 2 * PERIODS - 1, "green LED toggled once per half period");
        check(toggles <= 2 * PERIODS + 1, "green LED did not toggle too often");

        if (errors == 0)
            $display("PASS  blink: %0d toggles in %0d clocks", toggles, 2 * PERIODS * HALF);
        else
            $display("FAIL  blink: %0d check%0s failed", errors, (errors == 1) ? "" : "s");

        $finish;
    end

endmodule

`default_nettype wire
