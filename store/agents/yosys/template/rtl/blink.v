// blink.v — the starter design: the green LED blinks at 1 Hz off the iCEBreaker's 12 MHz clock,
// and the red LED lights while the on-board button is held.
//
// Verilog-2005, synthesisable subset. Two rules hold everywhere in this workspace:
//   - every flip-flop is written with non-blocking assignment (<=) inside `always @(posedge clk)`;
//   - the width of the counter comes from the parameters, so the testbench can shrink time.
//
// The board's LEDs and its button are ACTIVE LOW: a 0 on the pin lights the LED, and the button
// reads 0 while it is pressed. The `_n` suffix on a port is how that is said out loud.

`default_nettype none

module blink #(
    parameter integer CLK_HZ   = 12_000_000,  // the iCEBreaker's oscillator
    parameter integer BLINK_HZ = 1            // full on-off cycles per second
) (
    input  wire clk,     // 12 MHz, pin 35
    input  wire btn_n,   // on-board button, 0 = pressed
    output wire ledg_n,  // green LED, 0 = lit
    output wire ledr_n   // red LED, 0 = lit
);

    // Half a blink period, in clock cycles, and just enough bits to count it.
    localparam integer HALF  = CLK_HZ / (2 * BLINK_HZ);
    localparam integer WIDTH = $clog2(HALF);

    reg [WIDTH-1:0] count = {WIDTH{1'b0}};
    reg             lit   = 1'b0;

    always @(posedge clk) begin
        if (count == HALF - 1) begin
            count <= {WIDTH{1'b0}};
            lit   <= ~lit;          // one toggle every half period => BLINK_HZ full cycles
        end else begin
            count <= count + 1'b1;
        end
    end

    // Active low on both: invert here, once, at the pins.
    assign ledg_n = ~lit;
    assign ledr_n = btn_n;  // btn_n is already 0 while pressed, so the red LED follows it

endmodule

`default_nettype wire
