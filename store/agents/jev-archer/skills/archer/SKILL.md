---
name: archer
description: Shape a Jev Archer range (target speed, bullseye size, shots), then verify Jev plants the slow targets and leaks the fast ones.
---

# Craft — Jev Archer

Jev Archer is a 1-D tracking game: a target slides across a line and Jev nudges the aim to track it,
releasing an arrow every window. The craft is curating the target speed and the bullseye size into a
range that shows a real decision loop — Jev plants the slow ones and leaks the fast ones.

## The decision loop

Each tick the viewer gives Jev its current read: the aim x, the target x, and how many ticks until
the arrow releases. Jev answers one Choice:

```
Which way do you nudge the aim this tick? LEFT_FAST / LEFT / HOLD / RIGHT / RIGHT_FAST
```

The mock reads the same lines and nudges toward the target. The physics — how far the target slides
per tick and how precise the bullseye is — is what makes it hard or easy, not randomness.

## Reading and shaping the range

```jsonc
{
  "speed": 0.6,       // target slides this many slots per tick
  "bullHalf": 1.0,    // half of the bullseye in slots when the arrow releases
  "targetWidth": 24,  // range width in slots
  "shots": 16,        // arrows in the session
  "style": "track the target"
}
```

- **`speed` is the honest limit.** At `0.4–0.6` the target slides less than the aim corrects in one
  tick, so Jev stays glued and it's nearly a clean day. Past ~`1.2` the target outruns the aim each
  tick, the aim trails, and the arrow releases off-center.
- **`bullHalf` is the precision knob.** Tight (`0.4`) demands the aim land within a whisker; wide
  (`1.5+`) lets Jev string clean days together.
- **`style` changes how Jev plays.** "Hug the target, correct instantly" vs "read its direction and
  lead the motion" produce visibly different aim behavior.

## Shaping tension

A good range should have a deliberate flip: pick a `speed` where it's calm, and know what speed (or
what bullseye) makes Jev start to leak. Start at `0.6`, then either speed the target up to `1.2+` for
a busy, miss-heavy range, or tighten the bullseye for a precise one. Report the flip: does Jev plant
a clean day at the calm setting and leak when sped up?

## Verifying

```bash
node "$JEV_DSH/toolchain/check.mjs"
```

Then run the real loop and watch: a good range plants the slow and leaks the fast. A dull range never
leaks; a broken one leaks even on a slow target. Report whichever extreme you see — don't hide it.

## Definition of done

- `archer.json` passes `check.mjs`.
- Jev visibly tracks the target and plants it at a calm speed.
- Speeding the target up (or shrinking the bullseye) visibly raises the misses — the knobs actually
  matter.
