---
name: strudel
description: Write a live-coded track as a Strudel pattern — mini-notation, synths, effects, song structure — and check it with the verdict. Use whenever the workspace holds a .strudel file or the user asks for a beat, a groove, a bassline, a loop, a track, or music in the pane.
---

# Strudel

Strudel is TidalCycles in JavaScript. A track is **one expression** that describes a cycle; the REPL
plays that cycle forever until you change it. You write one file, `track.strudel`, and the pane
plays it — a save hot-swaps the pattern on the next cycle without stopping the transport.

The whole file is evaluated as ECMAScript 2022 (top-level `await` allowed), so JavaScript syntax
rules apply: balanced brackets, balanced quotes, `//` and `/* */` comments. There is no module
loader — **never write `import` or `require`**. Everything Strudel offers is already in scope.

Check after every save:

```sh
python3 "$STRUDEL_TOOLCHAIN/verdict.py"          # track.strudel
python3 "$STRUDEL_TOOLCHAIN/verdict.py" b.strudel
```

It parses the file with the same parser the REPL uses, says whether the track will play, and writes
`.harness/verdict.json`, which is what the pane header shows. It cannot hear anything — no headless
check can. **Playing is the pane's job and the user's ears.**

## Offline first: use synths, not samples

The REPL preloads sample *maps* from GitHub at start and fetches each `.wav` the first time it is
triggered. So `s("bd sd hh")` needs the internet, twice. These sound sources need nothing:

| Source | Names |
|---|---|
| Oscillators | `sine` `sawtooth` `square` `triangle` (aliases `sin` `saw` `sqr` `tri`) |
| Richer | `supersaw` (`unison`, `spread`, `detune`), `pulse` (`pw`, `pwrate`, `pwsweep`) |
| Noise | `white` `pink` `brown` (hard → soft), `crackle` (with `density`) |
| Drum | `sbd`, a synthesised bass drum |
| Chip | `zzfx` `z_sine` `z_sawtooth` `z_triangle` `z_square` `z_tan` `z_noise` |

Build drums out of those: `s("sbd*4")` is the kick, short noise is the snare and the hats.

```js
stack(
  s("sbd*4").decay(0.24).lpf(280),
  s("~ white ~ white").decay(0.11).sustain(0).hpf(1200).gain(0.5),
  s("white*8").decay(0.03).sustain(0).hpf(7000).gain("[0.3 0.14]*4")
)
```

Reach for `bd sd hh oh rim cp` and `.bank("RolandTR909")` only when the user wants real drum
machines and has a connection. Say so when you do; the verdict warns about it too.

If you set `note()` and no `s()`, the sound defaults to `triangle` — already offline.

## Mini-notation

Everything inside a double-quoted string is mini-notation. Single quotes are a plain string, not a
pattern.

| | |
|---|---|
| `a b c` | a sequence; the whole thing still takes one cycle, so more events = shorter events |
| `~` or `-` | a rest |
| `[a b]` | a subdivision — one slot of the outer sequence, nests as deep as you like |
| `<a b c>` | one per cycle. `<a b c>` is exactly `[a b c]/3` |
| `a*2` | faster / repeat within the slot (decimals allowed: `*2.75`) |
| `a/2` | slower — spread over 2 cycles |
| `a, b` | in parallel (a stack), at the top level or inside `[ ]` |
| `a!3` | replicate: `a a a`, *without* speeding up. Bare `!` means 2 |
| `a@3` | elongate: this one gets 3 slots' worth of time. Default weight 1 |
| `a?` `a?0.1` | drop it 50% / 10% of the time |
| `a\|b` | pick one at random each cycle |
| `a(3,8)` `a(3,8,1)` | Euclid: pulses, steps, and an optional rotation |
| `{a b c, x y}` `{a b c}%4` | polymeter |
| `bd:2` | second value — for `s()` that is the sample index, a third is gain |

```js
s("bd [hh hh] sd [hh bd]")                      // subdivision
note("<c2!2 g1!2 as1!2 f1!2>(3,8)").s("sawtooth") // 8 bars of euclidean bass
s("[bd sd]*2, white*8")                          // two voices in one string
n("<4 [3@3 4] [<2 0> ~] ~>").scale("d4:minor")   // weights and nesting
```

## Notes, scales, chords

- `note("c3 e3 g3")` — letters a–g, `b`/`#`, optional octave 0–9, default octave 3. MIDI numbers
  work too (`note("48 55")`, 69 = A4).
- `n("0 2 4").scale("c4:minor")` — degrees of a scale, zero-indexed, negatives wrap backwards. The
  scale name takes **no spaces**: `"c:minor"`, `"f#4:mixolydian"`, `"a:harmonic:minor"`.
- `[c3,eb3,g3]` inside a pattern is a chord — a stack of notes in one slot.
- `n("0 1 2 3").chord("<C Am F G>").voicing()` builds voicings from chord symbols.
- `.arp("0 [0,2] 1 [0,2]")` spreads a stacked chord over time. It takes a **pattern of indices**,
  not mode names like `"up"`.

```js
note("<[c3,ds3,g3] [g2,as2,d3] [as2,d3,f3] [f2,gs2,c3]>")
  .s("supersaw").unison(5).spread(0.45).attack(0.5).release(1.2).room(0.6)
```

## Shaping the sound

- **Envelope** `attack`/`att`, `decay`/`dec`, `sustain`/`sus`, `release`/`rel`, or all four at once
  as `.adsr(".1:.1:.5:.2")`. `clip` (alias `legato`) multiplies note length.
- **Filter** `lpf` (aliases `cutoff`, `lp`), `hpf`, `bpf`; resonance is `lpq` (alias `resonance`,
  0–50), `hpq`, `bpq`. `ftype` picks `12db` / `ladder` / `24db`.
- **Filter envelope** `lpattack` `lpdecay` `lpsustain` `lprelease` `lpenv` (short: `lpa` `lpd`
  `lps` `lpr` `lpe`). `lpenv` is the depth and may be negative.
- **Space** `room` (0–1) with `roomsize` (alias `rsize`/`size`, 0–10 — change it sparsely);
  `delay`, `delaytime`/`dt`, `delayfeedback`/`dfb`. `orbit(n)` gives a voice its own reverb and
  delay bus; patterns on the same orbit share one.
- **Colour** `distort` (prefer it over the deprecated `shape`), `crush` (1 crunchy … 16 clean),
  `coarse`, `vowel("<a e i o u>")`, `phaser`.
- **Level and place** `gain`, `postgain`, `pan` (0 left … 1 right).

Many of these take several values through `:` — `lpf("1000:10")` is cutoff and resonance,
`delay("0.65:0.25:0.9")` is level, time and feedback, `room("0.9:4")` is level and size.

```js
note("c3 bb2 f3 eb3").s("sawtooth").lpf(600).adsr(".1:.1:.5:.2")
note("c2 e2 f2 g2").s("sawtooth").lpf(300).lpa(0.5).lpenv("<4 2 1 0 -1 -2 -4>/4")
```

## Moving the pattern

`rev` `palindrome` `iter(4)` `chunk(4, f)` `ply(2)` `off(1/16, f)` `superimpose(f)` `layer(f)`
`jux(rev)` `juxBy(0.5, f)` `segment(16)` `struct("x ~ x x")` `mask("1 0")` `degradeBy(0.3)`
`sometimes(f)` `sometimesBy(0.4, f)` `often` (0.75) `rarely` (0.25) `almostAlways` (0.9)
`someCyclesBy(p, f)` `every(4, f)` `slow(2)` `fast(2)` `euclid(3,8)` `euclidRot(3,8,1)`
`euclidLegato(3,8)` `add(note("12"))` `echo(3, 1/8, 0.5)` `linger` `swingBy(1/3, 4)` `hurry(2)`.

```js
n("0 1 [4 3] 2 0 2 [~ 3] 4").s("triangle").jux(rev)
s("white*8").sometimesBy(0.4, x => x.hpf(2000).gain(0.4))
n("0 [4 <3 2>] <2 3> [~ 1]".off(1/16, x => x.add(4))).scale("c5:minor").s("triangle").dec(0.1)
```

## Signals as modulators

`sine` `cosine` `saw` `isaw` `tri` `square` `rand` `perlin` run 0…1 (the `…2` variants, `sine2`
`saw2` `rand2`, run −1…1); `irand(n)` is called as a function. Shape them with `.range(lo, hi)`
(or `.rangex` for exponential) and slow them with `.slow(n)`.

```js
note("<[c2 c3]*4 [bb1 bb2]*4>").s("sawtooth").lpf(sine.range(100, 2000).slow(4))
n(saw.range(0, 8).segment(8)).scale("c:major")
n(irand(8)).struct("x x*2 x x*3").scale("c:minor")
```

**The catch worth knowing:** a signal is sampled once per *event*, not continuously. A pad held for
a whole cycle gets one filter value per note, not a sweep. Add events to hear the movement:

```js
s("supersaw").seg(16).lpf(tri.range(100, 5000).slow(2))
```

Envelopes *are* continuous in time: `attack`/`decay`/`release`, the pitch envelope (`penv`,
`pattack`, `pdecay`), the filter envelopes, `tremolo`, `phaser`, `vib`.

## Putting a track together

**Tempo.** `setcpm(120/4)` — cycles per minute, and with one bar per cycle that is 120 bpm in 4/4.
`setcps(x)` is the same thing per second; the default is 0.5 cps, a 2-second cycle. Set it on the
first line so the file says its own tempo.

**Layers.** `stack(a, b, c)` plays voices together and is the shape to reach for. The `$:` label
form does the same thing one line at a time, and `_$:` mutes a line — handy when the user asks to
drop a part:

```js
setcpm(120/4)
$: s("sbd*4").decay(0.24)
$: note("<c2 g1>(3,8)").s("sawtooth").lpf(800)
_$: n("0 3 7").scale("c4:minor").s("triangle")   // muted
```

**Name every voice.** The pane draws one lane per `stack` argument (or `$:` line) — its notes
scrolling under a playhead, an activity light, Mute and Solo — and titles the lane from the comment
directly above the voice, up to the first ` — `, `:` or `.`. So give every voice its own argument and
a title line, and keep what it does after the dash:

```js
stack(
  // Kick — four on the floor
  s("sbd*4").decay(0.24),
  // Bass — three pulses in eight, filter opening over four bars
  note("<c2 g1>(3,8)").s("sawtooth").lpf(sine.range(220, 1600).slow(4))
)
```

A named label (`bass: note(...)`) is its own title. Without a comment the lane is named after the
first sound it plays.

**Structure.** A cycle is a bar. Longer form comes from `<>` (one per cycle), `!` and `@` to hold a
chord for two bars, `/n` to stretch, and `every(n, f)` / `someCyclesBy` to vary. Eight bars of
harmony is `<[chord]!2 [chord]!2 [chord]!2 [chord]!2>`.

- **Intro** — one or two voices, filter closed, no lead. `.lpf(400)` on everything is a whole intro.
- **Groove** — kick, backbeat, hats, bass, then harmony. Give each voice its own register and one
  clear rhythmic idea; do not let two voices play the same subdivision at the same volume.
- **Break** — `.mask("<1 1 1 0>")` drops a voice for the fourth bar of four; `every(4, x => x.fast(2))`
  doubles it instead. A break is one voice leaving, not everything changing.
- **Lift** — open the filter, add `.jux(rev)`, add an octave with `.sometimes(add(note("12")))`.

**Mix.** Keep `gain` roughly: kick 0.9–1, snare 0.5, hats 0.15–0.3, bass 0.8, pad 0.3, lead 0.3.
Reverb on one or two voices only, and `roomsize` set once. Everything at 1 is mud.

**Effects are single-use per voice.** `s("bd").lpf(100).distort(2).lpf(800)` does not chain — the
last `lpf` wins. Use `superimpose` or a second stack entry for a second treatment.

## How to work

1. Write `track.strudel` with a tempo and one or two voices within the first minute, run the
   verdict, and tell the user to click **Play**. The pane hot-swaps from then on.
2. Build up a voice at a time, running the verdict after each save. A file that does not parse
   leaves the pane playing the last good pattern and shows the error, with its line, above the code —
   the music never breaks, but nothing new is heard until the verdict is clean.
3. Prefer synths. If the user asks for real drums, use them and say the pane needs the internet.
4. Ask only what you cannot infer — tempo, key, mood, length. Otherwise decide, say so in one line,
   and play it.
5. Deliver `track.strudel`. It is plain text and pastes straight into strudel.cc.
