# This workspace

`circuit.txt` is the circuit, in CircuitJS1's text format. The pane beside the terminal is
CircuitJS1 itself, running it: charge moving along the wires, the scopes drawing. Edit the file and
the pane picks it up without reloading; poke at the circuit in the pane and it keeps running.

The starter is a 555 astable flashing an LED — elements 0–17 are CircuitJS1's own
"Square Wave Generator" example (GPL-2.0, © Paul Falstad and Iain Sharp), and the LED, its series
resistor and the third scope were added here.

    python3 "$CIRCUITJS_TOOLCHAIN/verdict.py"        # judge circuit.txt, write .harness/verdict.json

The `circuitjs` skill has the file format, the layout rules and eight more examples from upstream.
