---
name: circuitjs
description: Write and fix circuits in CircuitJS1's text format — the `$` options header, element lines on a 16-px grid, scope `o` lines, slider `38` lines, layout rules, and the workflow that keeps the pane moving. Use this for every circuit in this workspace, whether writing a new `circuit.txt`, editing one, or reading the verdict's findings.
---

# CircuitJS1's circuit format

A circuit is one plain-text file. Each line is either the options header, one element, one scope, or
one slider. That is the whole format. CircuitJS1 reads it with a tokenizer that splits on spaces and
gives up on a line it cannot make sense of, so a wrong field is a missing element, not an error
message — which is why `verdict.py` exists.

```
$ 1 0.000005 10.20027730826997 50 5 43 5e-11
v 176 224 176 112 0 1 40 5 0 0 0.5
r 176 112 336 112 0 1000
c 336 112 336 224 0 0.00001 0
w 176 224 336 224 0
g 176 224 176 256 0
o 2 64 0 2 5 0.0125
```

That is a working RC low-pass: a 5 V sine into 1 kΩ, across 10 µF, with the capacitor on the scope.
Everything else is more of the same.

## The `$` options header

One line, first, always.

```
$ <flags> <maxTimeStep> <iterations> <currentSpeed> <voltageRange> [<powerBrightness> <minTimeStep>]
```

| Field | What it does | Sane value |
|---|---|---|
| `flags` | 1 show current dots, 2 small (8-px) grid, 4 hide voltage colour, 8 show power, 16 hide values, 64 adaptive timestep, 128 auto-DC on reset | `1` |
| `maxTimeStep` | seconds per simulation step | `0.000005` (5 µs) |
| `iterations` | how fast it runs on screen: steps per second ≈ `160 × this`. At `5` and a 5 µs step the simulator advances about 4 ms of circuit time per second of wall clock, so a 300 Hz oscillator reads as a ~1 Hz blink | `5` to `10` |
| `currentSpeed` | how fast the charge dots move | `50` |
| `voltageRange` | volts per full colour swing | `5` (or the supply) |
| `powerBrightness`, `minTimeStep` | optional | `43 5e-11` |

**`iterations` is the dial that makes a circuit watchable.** Slow it down (`2`) for something that
should visibly blink; leave it (`10`) for a waveform on a scope.

## Element lines

```
<code> <x1> <y1> <x2> <y2> <flags> [values…]
```

Everything after `flags` belongs to that element and differs per code. Coordinates are integers on a
**16-px grid** — CircuitJS1 snaps to it, and two ends that are not on it will not meet.

**Elements connect only by sharing a coordinate.** There are no net names and no explicit
connections: two posts at exactly the same `(x, y)` are the same node. Crossing wires that do not
share an endpoint do not touch. `w` is an ideal wire and exists purely to move a node somewhere else
on the canvas.

### Where an element's posts are

| Shape | Posts |
|---|---|
| **Two-terminal** — `r c l d z v i w s m p I 162 175 176 181 182 183 187 203 209 216 350 370 374 404 415 422 425 426` | exactly `(x1,y1)` and `(x2,y2)` |
| **One-terminal** — `g R O L M A n 170 172 200 201 207 210 211 368 408 411 418 424` | `(x1,y1)` only; `(x2,y2)` is just which way it points |
| **Decoration** — `x b 403 423` | none |
| **Everything else** (chips, transistors, op-amps, pots, transformers) | at offsets the app computes — see below |

### The ones you will actually write

| Code | Element | Fields after `flags` |
|---|---|---|
| `w` | wire | *(none)* |
| `r` | resistor | `resistance` |
| `c` | capacitor | `capacitance voltdiff [initialVoltage [seriesResistance]]` (the last needs flag 4) |
| `l` | inductor | `inductance current [initialCurrent saturationCurrent]` |
| `d` | diode | `modelName` when flag 2 is set (`default`, `zener`, `1N4004`, `led-*`); with flags 0 the default silicon diode and no fields |
| `z` | zener | `zenerVoltage` with flags 0 |
| `v` | voltage source | `waveform frequency maxVoltage bias phaseShift dutyCycle` |
| `R` | rail (one-terminal source) | same six as `v` |
| `g` | ground | `symbolType` (0 normal, 1 chassis, 2 signal, 3 earth) |
| `s` | switch | `position momentary [label]` — `0`/`1` or `false`/`true`, label needs flag 4 |
| `O` | output (voltmeter label) | `scale` (0 auto) |
| `p` | probe | `meter scale resistance` |
| `162` | LED | diode fields, then `red green blue [maxBrightnessCurrent]` — `1 0 0` is red |
| `207` | labeled node | `name` — every `207` with the same name is the same node, wire-free |
| `x` | text | `size escapedText` — flags 4, spaces written `\s` |
| `170` | sweep source | `minF maxF maxV sweepTime` |
| `174` | potentiometer | `maxResistance position sliderLabel` |

Waveforms for `v` and `R`: `0` DC, `1` sine, `2` square, `3` triangle, `4` sawtooth, `5` pulse,
`6` noise. `frequency` is in hertz, `maxVoltage` is the amplitude, `bias` the offset, `phaseShift`
radians, `dutyCycle` a fraction. A 5 V DC supply is `v x1 y1 x2 y2 0 0 40 5 0 0 0.5` — the `40` is a
leftover frequency that DC ignores. **Post 0 is `(x1,y1)`, the negative end; post 1 is the positive
end.** Look at the examples before inventing a value.

### Placing an op-amp, a transistor or a chip

Their pins are not at the line's own ends, so writing the wires around them by hand is the one place
this format bites. Two that are worth knowing exactly, both drawn left to right at the default size:

- **Op-amp `a x1 y1 x2 y2 flags [maxOut minOut gbw v0 v1 gain]`** — inputs at `(x1, y1−16)` and
  `(x1, y1+16)`, output at `(x2, y2)`. With `flags 0` the **upper input is the inverting (−)** one;
  `flags 1` swaps them. See `examples/amp-invert.txt` (flags 0) and `examples/amp-noninvert.txt`.
- **Transistor `t x1 y1 x2 y2 flags type vbe vbc beta [model]`** — `type` is `1` for NPN and `-1`
  for PNP. Base at `(x1, y1)`; for an NPN with `flags 0`, **collector at `(x2, y2−16)` and emitter at
  `(x2, y2+16)`**. `flags 1` flips them, and PNP swaps them. `beta` is usually `100`. See
  `examples/npn.txt`.

For anything with a body — the 555 (`165`), counters, gates, flip-flops, transformers, pots — **do
not compute the pins.** Copy the whole block, chip line and surrounding wires together, out of an
example, and if you need it somewhere else add the same offset to every coordinate in the block. The
verdict will tell you the ends that stopped meeting. `template/circuit.txt` is exactly this: the 555
and its wires lifted unchanged out of `examples/555square.txt`, with an LED branch added on the
output node.

## Scope lines: `o`

A scope is what makes the pane worth looking at. Put at least one on every circuit.

```
o <element> <speed> <value> <flags> <scaleV> <scaleA> [position]
```

- **`element` is an index, counting only element lines, from 0.** The commonest mistake in the whole
  format. Insert an element in the middle and every scope below it is watching the wrong thing — so
  **append new elements at the end** rather than inserting, or renumber every `o` and `38` line.
- `speed` — simulation steps per pixel column. `64` is a good default; larger sweeps slower.
- `value` — `0` voltage, `3` current, `7` power. For a transistor: `1` Ib, `2` Ic, `4` Vbe, `6` Vce.
- `flags` — `1` plot current, `2` plot voltage, `8` show frequency, `256` show minimum, `512` show
  the scale, `8192` auto-scale. `3` (both traces) is a good default.
- `scaleV`, `scaleA` — volts and amps per division.
- `position` — which stacked slot, from 0.

`o 2 64 0 3 5 0.0125` reads: watch element 2, 64 steps per column, plot its voltage and current, 5 V
and 12.5 mA per division. Files saved by the app itself set flag `4096` and write a longer,
multi-plot form; both load, and the short one above is the one to write by hand.

## Slider lines: `38`

A knob in the app's right-hand column. The user turning it while the sim runs is most of the fun.

```
38 <element> F<flags> <editItem> <min> <max> <sharedWith> <label> <step>
```

`element` is the same index as a scope's. `editItem` is which of that element's editable values the
slider drives, from 0 — `0` is the primary one (a resistor's resistance, a capacitor's capacitance).
`F0` is plain, `F2` logarithmic. `sharedWith` is `-1`. Spaces in the label are written `\s`.
`38 0 F0 0 1 101 -1 Resistance 0` puts a 1 Ω – 101 Ω knob on element 0. See `examples/lrc.txt`.

## Other line types

`h` a hint the app shows, `!` a custom-logic model, `.` a composite-subcircuit model, `32` and `34`
transistor and diode model definitions. Copy them when you copy a block; do not write them fresh.

## Laying it out

The drawing is the explanation, so lay it out the way a schematic is read.

1. **Signal flows left to right.** Source on the left, load or output on the right.
2. **Supplies at the top, ground at the bottom.** Put the `g` at the lowest point of the circuit and
   run the return wire along the bottom.
3. **Everything on the 16-px grid**, and prefer multiples of 32 or 48 for the spacing between
   parallel branches — a two-terminal part wants about 64–160 px of room.
4. **One axis at a time.** Wires are horizontal or vertical; turn a corner with a second `w` rather
   than one diagonal.
5. **Keep it around 500 × 400.** The pane fits that without scrolling; the app centres what it gets.
6. **Label the nodes that matter** with `x` text, or use `207` labeled nodes instead of long wires
   across the canvas.
7. **Leave the scope elements' indices alone** — append, don't insert.

## How to work

The pane is live: it re-imports `circuit.txt` on every save without reloading the app, keeping the
simulation running. So save early and often, and let the user watch it grow.

1. **Source and ground first.** `v` (or `R`), `g`, and the return wire. Save. Run the verdict. The
   pane already shows something running.
2. **Then the circuit proper**, one branch at a time, saving after each. Two-terminal parts are the
   easy path; reach for a chip only when the circuit really is one.
3. **Then a scope on the output node, and a slider on the value worth turning.** Say in one line
   which knob you gave them.
4. **Run the verdict after every save:**

   ```sh
   python3 "$CIRCUITJS_TOOLCHAIN/verdict.py"            # circuit.txt
   python3 "$CIRCUITJS_TOOLCHAIN/verdict.py" other.txt
   ```

   Errors mean CircuitJS1 will drop a line: an unknown code, a truncated element, a scope pointing
   past the last element. Fix those. Warnings are usually real too — a floating end is a part that
   is not in the circuit, an off-grid coordinate is two ends that look joined and are not. An
   `open_end` **info** on a circuit that contains a chip or a transistor is expected: that end is a
   pin the checker cannot see.

5. **Never write the XML dump.** `exportCircuit()` in the app returns XML; this workspace is the
   text format, which the app still reads and a human can still edit.

## When something does not work

| What you see | Usually |
|---|---|
| A part is missing from the pane | its line had a bad field and the loader skipped it; check the field count against the table |
| Two parts look joined but nothing flows | their ends differ by a few pixels, or one is off the grid |
| "Capacitor loop with no resistance" or a hang | add a small series resistance, or a resistor in the loop |
| Everything reads 0 V | no ground: add a `g`, or the source's negative end is not the reference |
| The scope is flat | it is watching the wrong element index — count the element lines again |
| It runs far too fast or slow to see | change `iterations` in the `$` line, not the circuit |

## Examples

`examples/` holds eight of CircuitJS1's own circuits, unchanged (GPL-2.0, © Paul Falstad and Iain
Sharp) — see `examples/README.md` for what each one is worth reading for. The installed app has all
373 in its **Circuits** menu; open one in the pane, poke at it, and copy the lines you want.
