# Jev Lander

**Jev, TypeSafe's System One model, is the flight computer.** A booster falls out of the night sky.
Every tick Jev reads altitude, vertical speed, gravity and fuel as plain text and sets a throttle:
`CUT`, `COAST`, `HOVER` or `BURN`. Touch down slowly and it is a soft landing. Touch down fast and
the booster is scrap.

This is a harness for OpenHarness. The agent on the right edits `lander.json`. The viewer on the
left runs the flight and asks Jev for every throttle, live. The booster, the physics and the
telemetry are made up. The decision loop is the demo.

## Anatomy

```
jev-lander/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent how to shape a mission
  skills/lander/SKILL.md    # mission tuning and how to verify it
  template/lander.json      # a starter mission
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API, or a deterministic offline stand-in)
    viewer.sh               # launches the viewer
    check.mjs               # validates lander.json (same ranges the viewer clamps to)
    setup.sh / doctor.sh / init-workspace.sh
  viewer/
    viewer.mjs              # the loop: ask Jev, step the flight, stream a frame
    sim.mjs                 # the flight physics, pure functions
    serve.mjs               # loopback-only server, verdict writer, config watcher
    index.html / studio.css / studio.js / jev-hud.js   # the pane
```

## The pane

The pane draws at 60 frames a second and eases between Jev's decisions. The camera zooms in on the
pad as the booster comes down, and the mountain ridges swell with it.

- **The booster**: a lit body with grid fins, an engine bell, and landing legs that swing out below
  30. They take the weight and compress on touchdown.
- **The plume**: three nested flames that scale with the throttle and flicker, with shock diamonds
  at full burn. The engine lights the underside of the booster and the pad. Smoke trails from the
  flame, and near the pad it is blown out sideways as dust.
- **Touchdown**: a soft landing throws a dust ring and turns the pad lights green. A crash is a
  white flash, a fireball, tumbling debris, a smoke column, a wreck on the pad and a hard screen
  shake.
- **The velocity arrow** beside the booster is green when the speed is soft enough, amber when it
  is not yet, and red when the fall can no longer be stopped.
- **The braking bar** under the booster is the honest limit: the height it would need to stop at
  full burn. When it reaches past the pad, no answer can save the landing.
- **Jev's mind, in the scene**: a throttle gauge with four segments, `BURN` on top, each filled by
  its probability, the chosen one lit green. Above it is Jev's own answer to "will the touchdown be
  soft?".
- **The fuel tank** drains as the engine burns, sloshes, and flashes red when it is low.
- **The result banner** sits at the top of the sky, so it never covers the booster.
- Also in the scene: an altitude ruler, a large altitude readout, a night sky with a moon and
  twinkling stars, and a small plot of this flight's altitude, coloured by throttle.
- **The top bar** shows decisions per second, decisions so far and cost so far, large, next to
  altitude, vertical speed, landed and crashed.
- **The rail** shows the shared "Jev live mind" panel, the exact text Jev reads, and a bar for
  every finished flight (touchdown speed, red for a crash).

### Things you can do in the pane

- **Click the sky**: below the booster is a downdraft (it falls 3 faster), above it is an updraft.
- **Engine out** kills the engine for four decisions, whatever Jev sets.
- **Fuel leak** loses 30% of the fuel that is left.
- **New booster** drops a new one now.
- **Gravity, Tank** sliders change the flight while it runs. An edit to `lander.json` resets them.
- **Pause, Step, Reset.**

After a touchdown the result shows for about three seconds, then the next booster drops on its
own, from a slightly different height and with a slightly different fall. It never sits idle.

## The dials, and why they are honest

Per tick: the throttle pushes up (`CUT` 0, `COAST` 0.4, `HOVER` 1.15, `BURN` 2.6) and burns the same
amount of fuel, gravity pulls down, and air drag takes `0.004 · v²`. So the engine can brake by at
most `2.6 − gravity` per tick, and every tick in the air costs about `gravity` of fuel. High
gravity means weaker braking and a thirstier descent, until the tank runs dry above the pad.
Nothing random is added to make Jev fail, and a test checks that every crash came with a dry tank
or a fall that full burn could not stop.

Measured with the offline stand-in (template mission, tank 60, 20 flights each):

| setting | landed | crashed | mean fuel left |
|---|---|---|---|
| `gravity` 1.0 | 21 | 0 | 33.6 |
| `gravity` 1.6 | 20 | 0 | 15.0 |
| `gravity` 2.15 (40 flights) | 21 | 19 | — |
| `gravity` 2.3 | 0 | 20 | 0 |
| `gravity` 2.8, tank 400 | 0 | 8 | 372 (it cannot brake at all) |
| `gravity` 1.2, tank 22 | 0 | 21 | 0.1 |

## Jev, honestly

The viewer calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set. Without a key it uses a
deterministic offline stand-in, and the pane shows a `MOCK` badge. The stand-in reads only the
same telemetry text live Jev gets and follows a gentle glide slope. It does not plan for a small
tank, so it is a stand-in for the plumbing, not for Jev's judgement.

An earlier version of the stand-in took a worse throttle more often as the gravity label rose (11
of 400 answers at G 1.2, 60 of 400 at G 3.0, for the same falling booster). That was injected
randomness. It is gone, and a test keeps it out. The template tank went from 260 to 60, so that
fuel is a real constraint and the gauge means something.

This is a toy flight. It is not real rocketry, real telemetry or real mission control.

## Tests

`node --test test/viewer.test.mjs` runs 13 tests: the loop, the verdict, every control, config in
`/state`, a touchdown and the automatic next flight, a bad JSON edit, a non-loopback `Host` header
(403), the stand-in's read, the dials, and the honesty of every crash. `harness dsh check .` checks
the manifest.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.
