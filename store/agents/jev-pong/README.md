# Jev Pong

**Jev, TypeSafe's System One model, is the paddle.** A ball bounces around a neon court. About
sixteen times a second Jev reads the ball and the paddle as plain text and picks a paddle move.
Every return makes the ball faster. The paddle never gets faster. So every rally ends the same
honest way: one day the ball comes back before the paddle can cross the court.

This is a harness for OpenHarness. The agent on the right edits `pong.json`. The viewer on the left
runs the rally and asks Jev for every move, live. The court and the ball are made up. The decision
loop is the demo.

## Anatomy

```
jev-pong/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent how to shape a court
  skills/pong/SKILL.md      # court tuning and how to verify it
  template/pong.json        # a starter court
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API, or a deterministic offline stand-in)
    viewer.sh               # launches the viewer
    check.mjs               # validates pong.json (same ranges the viewer clamps to)
    setup.sh / doctor.sh / init-workspace.sh
  viewer/
    viewer.mjs              # the loop: ask Jev, step the court, stream a frame
    sim.mjs                 # the court physics, pure functions
    serve.mjs               # loopback-only server, verdict writer, config watcher
    index.html / studio.css / studio.js / jev-hud.js   # the pane
```

## The pane

The pane draws at 60 frames a second and eases between Jev's decisions. Each frame from the server
carries the exact path the ball took during that decision, so bounces land on the rails.

- **The table**: neon rails, a glowing ball with a motion trail that turns from cyan to amber to
  red as it speeds up, sparks on every return, a paddle that squashes on impact, a flash where the
  ball strikes a rail, and a screen shake with a red burst when a ball gets through.
- **The rally counter** sits huge and faint behind the play. It pulses on every return.
- **Jev's mind, in the court**: five ghost paddles show where each option would put the paddle
  next, lit by probability. The chevrons beside the paddle show the same five probabilities, with
  the chosen move in green. A ring on Jev's wall marks where the ball will cross, with a dashed
  path to it. The ring turns from green to red as Jev's own answer to "will I reach it?" drops.
  The violet band is how far the paddle can still travel before the ball arrives.
- **The pace meter** under the court shows the ball's pace, the serve pace, and a red zone. Past
  the red mark a ball at the far end of the wall cannot be reached, even moving FAST all the way.
- **The top bar** shows decisions per second, decisions so far and cost so far, large, next to
  rally, best, misses and ball pace.
- **The rail** shows the shared "Jev live mind" panel, the exact text Jev reads, and a bar for
  every finished rally.

### Things you can do in the pane

- **Click the court** to shove the ball toward that point. The crossing point jumps and Jev has to
  re-plan.
- **Speed burst +4** makes the ball faster right now, as if it had been returned four more times.
- **New serve** throws the ball away and serves a new one.
- **Start pace, Paddle speed, Paddle size** sliders change the court while it runs. An edit to
  `pong.json` resets them.
- **Pause, Step, Reset.**

After a miss the pane shows the result for about two and a half seconds, then serves a new ball
with a new seed. It never sits idle.

## The dial, and why it is honest

`speed` is the serve pace, in court units per decision. `accel` is added on every return, up to
`topSpeed`. `maxSpeed` is how far a plain paddle move goes in one decision; a FAST move goes twice
as far. Nothing random is added to make Jev fail. A miss happens only when the ball comes back
before the paddle can travel that far, and a test checks this for every single miss.

Measured with the offline stand-in (template court, `maxSpeed` 2):

| setting | result |
|---|---|
| `accel` 0, `speed` 5, 2500 decisions | 0 misses, 33 returns |
| `accel` 0, `speed` 30, 2500 decisions | 19 misses, mean rally 4.7 |
| `accel` 1, `speed` 3, 4000 decisions | 4 misses, mean rally 22.8 |
| `accel` 1, `speed` 20, 4000 decisions | 25 misses, mean rally 5.6 |

## Jev, honestly

The viewer calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set. Without a key it uses a
deterministic offline stand-in, and the pane shows a `MOCK` badge. The stand-in reads only the
same text live Jev gets. It works out where the ball will cross and scores each move by how close
it leaves the paddle. It is a stand-in for the plumbing, not for Jev's judgement.

An earlier version of the stand-in never matched the viewer's text, so it guessed blind (about 25%
confidence on every move) and the ball could stick to the paddle and count a "rally" every tick.
Both are fixed, and a test keeps the reader honest.

This is a toy court. It shows decision rate and tracking. It is not real game software or real
control software.

## Tests

`node --test test/viewer.test.mjs` runs 12 tests: the loop, the verdict, every control, config in
`/state`, a bad JSON edit, a non-loopback `Host` header (403), the stand-in's read, the dial, and
the honesty of every miss. `harness dsh check .` checks the manifest.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.
