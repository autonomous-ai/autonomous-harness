# Jev Pendulum in OpenHarness

On the left, Jev Pendulum is a live balancing rig: a stiff rod is hinged on a cart that runs along
a rail, and **Jev — TypeSafe's System One model — is the balancer.** Every tick Jev reads the rod's
lean and swing and picks a push on the cart (`LEFT_HARD`, `LEFT`, `CENTER`, `RIGHT`, `RIGHT_HARD`).
To catch a rod that leans right, the cart must go right, to get back under it.

On the right, you edit `pendulum.json`. This is the ONLY file you edit. It sets the simulation —
gravity, rod length, push authority, gust strength — and the style line that tells Jev how to balance. The
viewer watches it and Jev adapts immediately.

## The pendulum file

```jsonc
{
  "title": "The Balance Rod",
  "description": "Jev keeps a stiff rod upright on a cart. A live balancing act.",
  "instrument": "ROD",
  "gravity": 7,
  "length": 1.0,
  "damping": 0.5,
  "maxTorque": 0.8,
  "stepMs": 80,
  "gustEvery": 10,
  "gustStrength": 0.55,
  "fallDeg": 60,
  "style": "Keep the rod upright. Correct every lean immediately, shrink the swing, and never let it drift past the edge. You are a fast, steady balancer."
}
```

- **`gravity`** — the difficulty dial. `4–5` never falls; `7` is tense with a fall now and then;
  `10+` topples every few seconds. Gravity pulls harder the more the rod leans, and the hardest
  shove is fixed, so past `atan(2 × maxTorque / gravity)` the rod cannot be saved. The pane draws
  that lean as the "no return" lines.
- **`maxTorque`** — Jev's authority. The hardest shove accelerates the cart by `2 × maxTorque`.
  Low authority (about `0.8`) makes Jev work hard; very high authority makes balancing trivial.
- **`gustEvery` / `gustStrength`** — a sideways blow at the tip of the rod every N ticks. The same
  blow swings a short rod harder than a long one. Jev must recover before the next one.
- **`length`** — the rod's length. A short rod falls faster and is hit harder by gusts, so it is
  much harder to keep up than a long one.
- **`seed`** — the seed for the gusts. Same seed, same gusts.
- **`damping` / `fallDeg`** — physical tuning. Keep `fallDeg` around `60` (the pane draws
  the danger wedge there).
- **`style`** — the instruction to Jev. It should name a coherent balancing strategy (aggressive
  correction, wait-and-see, shrink the swing) so Jev *decides* rather than guesses.

## Your job

Design `pendulum.json` so the balancing act is an event:

- **Pick a gravity with tension.** `8–9` is a sweet spot: Jev keeps it up for a while, wobbles hard,
  and eventually drops if the gusts are unfriendly. `5` never falls (you'll want to show that first
  so the audience sees Jev *can* hold it); `11+` drops fast.
- **Tune gusts for drama.** A gust every few ticks at a strength that pushes the rod near the wedge
  but not over — then Jev's recovery is the show.
- **Write a distinct style line.** Give Jev a strategy. `"Shrink the swing and never let it drift
  past the edge"` plays differently from `"react fast to every lean, don't overthink it"`.

Do NOT just ship the template. Every `pendulum.json` you publish should be its own rig with a
deliberate, testable balance.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the motion: does Jev hold it
up, struggle, and sometimes lose it — or does it always stand like a statue (too easy) or always
fall (too hard)? Either extreme is a finding to report, not a bug to mask.

## Keep current

- Keep `pendulum.json` valid JSON always. After a bad edit the viewer keeps running on the last
  good rig and shows the parse error in the pane.
- The person can also poke the rig in the pane (flick the rod, send a gust, move the gravity, rod
  length and gust sliders). Those are runtime overrides. Your next edit to `pendulum.json` resets them.
- Keep `title`, `description` and `style` truthful — and never present this as a real physical
  system or real control software.

## Rules

- Never propose opening a browser, changing ports, or running a second server. The viewer is already
  running on the left.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read on a state
  before you commit to a rig (e.g. "what does Jev do at angle 8°, velocity 0.3?"). Use the `jev`
  helpers: `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local stand-in that reads the same text
  (angle, swing, cart speed, gravity, the push each action gives) and picks the push that steadies
  the rod. It adds no randomness, so every fall has a physical cause. The demo runs offline. With
  a key, the viewer calls the real API.
- The Jev Pendulum viewer writes `.harness/verdict.json` itself (falls, best run, current tilt). Do
  not edit it.
- This is a demo. The rod is a canvas drawing and Jev is picking paper pushes — never present
  this as real control engineering.

## Definition of done

- A valid `pendulum.json` that parses and passes `toolchain/check.mjs`.
- A rig with real tension: Jev visibly wobbles and, if you push gravity or gusts hard enough, drops.
  A swing that's never in danger is a solved problem, not a good harness.
- The style line actually shapes the balance — report it if Jev behaves identically no matter what
  you write.
