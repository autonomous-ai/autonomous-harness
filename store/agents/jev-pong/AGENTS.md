# Jev Pong in OpenHarness

On the left, Jev Pong is a live paddle-defense rally: a ball ricochets around a slim court and
**Jev — TypeSafe's System One model — is the paddle.** Every tick Jev reads the ball's position and
velocity and moves the paddle to meet the return. Each successful hit makes the ball a little
faster, so a long rally is a losing battle — the show is Jev chasing, wobbling and finally dropping
it.

On the right, you edit `pong.json`. This is the ONLY file you edit. It sets the court, the paddle's
authority, and the starting ball speed; the viewer watches it and Jev adapts immediately.

## The pong file

```jsonc
{
  "title": "Jev Pong",
  "description": "Jev is the paddle — keep the rally alive as the ball speeds up.",
  "instrument": "PONG",
  "courtW": 200,
  "courtH": 120,
  "paddleH": 26,
  "ballR": 3,
  "speed": 6,
  "maxSpeed": 2,
  "accel": 1,
  "topSpeed": 40,
  "stepMs": 60,
  "seed": 90210,
  "style": "Keep the rally alive. Track the ball, predict where it will cross your wall, and get the paddle there in time. Be decisive."
}
```

- **`speed`** — the serve pace, in court units per decision (the difficulty dial). `3–6` gives a
  long build-up; `12–16` is tense from the first serve; `20+` ends most rallies in a few returns.
- **`accel`** — how much faster the ball gets per return. Higher accel makes rallies short and
  hectic; lower lets them grow long before Jev is overrun. This is the *other* tension knob.
- **`maxSpeed`** — how far a plain paddle move goes in one decision. A FAST move goes twice as
  far. This is the honest limit: once the ball comes back before the paddle can cross the court,
  Jev misses. `check.mjs` prints the pace where that starts.
- **`topSpeed`** — the cap the ball can reach. Leave it well above the pace `check.mjs` prints, or
  Jev may never miss.
- **`seed`** — the seed for the serves. Same seed, same rallies.
- **`courtW` / `courtH` / `paddleH` / `stepMs`** — court geometry and responsiveness. A wider
  court means longer cross-court flight (easier reads); a taller court means more vertical
  scrambling.
- **`style`** — the instruction to Jev. A decisive "get there in time" reads differently from a
  cautious "wait for the ball".

## Your job

Design `pong.json` so the rally is an event:

- **Pick a starting speed with tension.** `6` is a sweet spot: Jev holds about twenty returns, the
  ball speeds up, and it finally slips past. That is the natural arc of Pong.
- **Tune accel for the right pace.** Low accel (about 0.5) builds long streaks; high accel (2 or
  more) makes every rally short and frantic.
- **Set a style line that names a strategy.** Jev should *decide* how to defend, not guess.

Do NOT just ship the template. Every `pong.json` you publish should be its own court with a
deliberate, testable pace.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the motion: does Jev hold a
few exchanges, speed the ball up, and occasionally lose it — or does it never miss (too easy) or
always drop (too hard)? Either extreme is a finding to report, not a bug to mask.

## Rules

- Keep `pong.json` valid JSON always. After a bad edit the viewer keeps playing on the last good
  court and shows the parse error in the pane.
- The person can also poke the rally in the pane (shove the ball, speed burst, sliders). Those are
  runtime overrides. Your next edit to `pong.json` resets them.
- Never propose opening a browser, changing ports, or running a second server. The pane on the
  left is the viewer.
- Keep `title`, `description` and `style` truthful — and never present this as a real physics app
  or real control software.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read on a state
  before you commit to it (e.g. "what does Jev do for a ball at x 40 y 70, vx −6 vy 2, paddle at
  50?"). Use the `jev` helpers: `noul`, `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the ball
  and paddle and steers toward the predicted intercept — so the demo runs offline. With a key, the
  viewer calls the real API.
- The Jev Pong viewer writes `.harness/verdict.json` itself (misses, best rally, current rally). Do
  not edit it.
- This is a demo. The ball and paddle are canvas shapes and Jev is picking paper moves — never
  present this as real game software or real control.

## Definition of done

- A valid `pong.json` that parses and passes `toolchain/check.mjs`.
- A rally with real pace: Jev returns a few balls, the rally accelerates, and it eventually drops
  one. A rally that never dies is a solved problem, not a good harness.
- The style line actually shapes the defense — report it if Jev behaves identically no matter what
  you write.
