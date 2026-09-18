# Jev Pendulum in OpenHarness

On the left, Jev Pendulum is a live inverted-pendulum experiment: a stiff rod stands upright on a
pivot, and **Jev — TypeSafe's System One model — is the balancer.** Every tick Jev reads the rod's
lean and angular velocity and picks a corrective torque (`LEFT_HARD`, `LEFT`, `CENTER`, `RIGHT`,
`RIGHT_HARD`); the rod swings. Hold it up long enough and it's a balancing act you can watch.

On the right, you edit `pendulum.json`. This is the ONLY file you edit. It sets the simulation —
gravity, torque authority, gust strength — and the style line that tells Jev how to balance. The
viewer watches it and Jev adapts immediately.

## The pendulum file

```jsonc
{
  "title": "The Balance Rod",
  "description": "Jev keeps a stiff rod upright on a pivot — a live balancing act.",
  "instrument": "ROD",
  "gravity": 7,
  "length": 1.0,
  "damping": 0.5,
  "maxTorque": 0.8,
  "stepMs": 80,
  "gustEvery": 10,
  "gustStrength": 0.5,
  "fallDeg": 60,
  "style": "Keep the rod upright. Correct every lean immediately, shrink the swing, and never let it drift past the edge. You are a fast, steady balancer."
}
```

- **`gravity`** — the difficulty dial. `5–6` is calm; `7–8` is tense; `9+` Jev starts to lose it and
  the rod topples. This is *the* knob the agent turns to stress Jev.
- **`maxTorque`** — how strong Jev's corrective torque is. Lower authority (≈`0.8`) makes Jev work
  harder and gives bigger swings; very high authority makes balancing trivial.
- **`gustEvery` / `gustStrength`** — a sideways kick every N ticks. Jev must recover before the
  next one; strong+fast gusts are how you make it visibly lose control.
- **`length` / `damping` / `fallDeg`** — physical tuning. Keep `fallDeg` around `60` (the pane draws
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

- Keep `pendulum.json` valid JSON always. A bad edit freezes the rig on the last good state.
- Keep `title`, `description` and `style` truthful — and never present this as a real physical
  system or real control software.

## Rules

- Never propose opening a browser, changing ports, or running a second server. The viewer is already
  running on the left.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read on a state
  before you commit to a rig (e.g. "what does Jev do at angle 8°, velocity 0.3?"). Use the `jev`
  helpers: `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the angle,
  velocity and hardness dial and biases toward the balancing torque — so the demo runs offline. With
  a key, the viewer calls the real API.
- The Jev Pendulum viewer writes `.harness/verdict.json` itself (falls, best run, current tilt). Do
  not edit it.
- This is a demo. The rod is a canvas drawing and Jev is picking paper torque values — never present
  this as real control engineering.

## Definition of done

- A valid `pendulum.json` that parses and passes `toolchain/check.mjs`.
- A rig with real tension: Jev visibly wobbles and, if you push gravity or gusts hard enough, drops.
  A swing that's never in danger is a solved problem, not a good harness.
- The style line actually shapes the balance — report it if Jev behaves identically no matter what
  you write.
