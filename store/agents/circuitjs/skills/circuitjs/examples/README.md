# Nine circuits from upstream, unchanged

These files are CircuitJS1's own example circuits, copied verbatim from
[`src/com/lushprojects/circuitjs1/public/circuits/`](https://github.com/pfalstad/circuitjs1/tree/master/src/com/lushprojects/circuitjs1/public/circuits)
at commit `5bdb129`. They are part of CircuitJS1 and carry its licence: **GPL-2.0**, © Paul Falstad
and Iain Sharp. See `../../../LICENSE-circuitjs1`. Nothing here is modified; they are the grammar's
ground truth, and the right thing to read when a value or a flag looks ambiguous.

| File | In the app's Circuits menu | Read it for |
|---|---|---|
| `voltdivide.txt` | Voltage Divider | the smallest real circuit: `v`, `r`, `w`, `O`. No scope, no ground element — the source's own negative end is the reference. |
| `filt-lopass.txt` | Low-Pass Filter (RC) | a swept source (`170`), a series `r` into a shunt `c`, two scopes, an `h` hint line. |
| `rectify.txt` | Half-Wave Rectifier | an AC source (`v` with waveform 1), a `d`, two scopes in the short old-style form. |
| `amp-invert.txt` | Inverting Amplifier | an op-amp (`a`) with its feedback resistor, and how its three pins sit off the line's own ends. |
| `amp-noninvert.txt` | Non-Inverting Amplifier | the same op-amp with `flags 1` — the one bit that swaps `+` and `−`. |
| `npn.txt` | NPN Transistor | a transistor (`t`) with two variable rails (`172`) driving base and collector. |
| `555square.txt` | Square Wave Generator | a chip (`165`), a rail (`R`), the new-style scope lines with `4096` set. This is what `template/circuit.txt` is built on. |
| `lrc.txt` | LRC Circuit | `l`, `c`, `s`, and three `38` slider lines — the way to give the user a knob. |
| `ledflasher.txt` | LED Flasher | ten `162` LEDs off a ring counter (`163`), and a clock rail. Big, and all wires. |

The installed app has all 373 of them: open the Circuits menu in the pane.
