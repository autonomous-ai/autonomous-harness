# Jev Lander in OpenHarness

On the left, Jev Lander is a landing pad: a booster drops out of the sky under gravity, and **Jev —
TypeSafe's System One model — is the flight computer.** Every tick Jev reads altitude, vertical
speed and fuel, and sets a throttle to bring it down soft. Touch down slow and it's a clean landing;
hit hard and the booster is scrap. The physics is synthetic; the decision loop is the show.

On the right, you edit `lander.json`. This is the ONLY file you edit. It holds the mission profile —
the gravity, the fuel budget, the launch height — and the viewer watches it and Jev adapts
immediately.

## The lander file

```jsonc
{
  "title": "Jev Lander",
  "description": "Jev is the flight computer: throttle a booster down to a soft landing.",
  "instrument": "LANDER",
  "tickMs": 300,
  "gravity": 1.2,
  "fuel": 260,
  "altitude": 80,
  "safeSpeed": 2.0,
  "style": "The booster is falling under gravity. Bring it down to the pad gently: watch altitude and vertical speed, burn early and hard enough to keep descent in check, and ease off so you touch down soft. A fast touchdown is a crash — go for the gentle landing."
}
```

- **`gravity`** — the downward pull per tick (acceleration). Low (`1.0`) is an easy, forgiving
  descent that Jev brings down soft; high (`3.0+`) makes it fall fast, burn hard, and start crashing.
  This is the difficulty dial.
- **`fuel`** — the paper fuel budget. Each tick thrust (COAST/HOVER/BURN) spends a little fuel. Less
  fuel means Jev has less room to recover from a bad burn.
- **`altitude`** — how high the booster starts. Higher up = more chance to pick up speed and more
  chance to recover; very low = almost no room to react.
- **`safeSpeed`** — the maximum touchdown speed for a soft landing. `2.0` is a gentle pad.
- **`tickMs`** — how often the booster updates (and Jev decides). Fast ticks = a frantic controller;
  slow ticks = a contemplative descent.
- **`style`** — the instruction to Jev. It should name a landing strategy so Jev *decides* rather
  than guesses.

## Your job

Design `lander.json` so the landing is an event:

- **Pick a gravity with tension.** `1.0–1.5` gives clean, readable soft landings. Crank `vol` up to
  `3+` and watch Jev's burns get twitchy and touchdowns start to crash — that flip is the fun.
- **Choose a fuel budget.** On a high-gravity world, too little fuel means an inevitable crash; too
  much means Jev hovers comfortably.
- **Write a distinct style line.** "A fast touchdown is a crash, burn early and hard" plays very
  differently from "coast as long as you can, then flare at the last second."

Do NOT just ship the template. Every `lander.json` you publish should be its own mission with a
deliberate, testable difficulty.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the landing: does Jev bring
the booster down soft at the gravity you set, and crash when you crank it up — or does it hover
forever (dull) or slam in even at easy gravity (bad)? Either extreme is a finding to report, not a
bug to mask.

## Rules

- Keep `lander.json` valid JSON always. A bad edit freezes the landing on the last good state. You
  can change `gravity`/`fuel`/`altitude` live — the viewer rebuilds the mission for the new profile.
- Keep `title`, `description` and `style` truthful — and never present this as real rocketry, real
  telemetry, or real mission control.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read before you
  commit to it (e.g. "what does Jev set at G 3.0?"). Use the `jev` helpers: `noul`, `choice`,
  `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the telemetry
  and picks a sensible throttle — so the demo runs offline. With a key, the viewer calls the real
  API.
- The Jev Lander viewer writes `.harness/verdict.json` itself (ticks flown, throttle, landing
  outcome). Do not edit it.
- This is a demo. The booster, the physics and the telemetry are made up — never present this as a
  real launch or real mission control.

## Definition of done

- A valid `lander.json` that parses and passes `toolchain/check.mjs`.
- A mission with a real decision loop: Jev reads the telemetry, sets a throttle, and on a healthy
  profile brings the booster down soft — and crashes when gravity is cranked up.
- The gravity and style actually shape the burns — report it if Jev hovers forever, or slams in no
  matter what.
