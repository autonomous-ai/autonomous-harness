# Jev Pendulum

**Jev, TypeSafe's System One model, is a live balancing act.** A stiff rod is hinged on a cart that
runs along a rail. About twelve times a second Jev reads the lean and the swing as plain text and
picks a push on the cart. Gusts keep knocking the rod. You tune the rig (gravity, rod length, push
authority, gusts) and watch how much Jev can hold.

This is a harness for OpenHarness. The agent on the right edits `pendulum.json`. The viewer on the
left runs the rig and asks Jev for every push, live. The rig is made up. The decision loop is the
demo.

## Anatomy

```
jev-pendulum/
  harness.json              # DSH manifest (engine: claude)
  AGENTS.md                 # tells the agent how to shape a rig
  skills/pendulum/SKILL.md  # rig tuning and how to verify it
  template/pendulum.json    # a starter rig
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API, or a deterministic offline stand-in)
    viewer.sh               # launches the viewer
    check.mjs               # validates pendulum.json (same ranges the viewer clamps to)
    setup.sh / doctor.sh / init-workspace.sh
  viewer/
    viewer.mjs              # the loop: ask Jev, step the rig, stream a frame
    sim.mjs                 # cart and rod physics, pure functions
    serve.mjs               # loopback-only server, verdict writer, config watcher
    index.html / studio.css / studio.js / jev-hud.js   # the pane
```

## The pane

The pane draws at 60 frames a second and eases between Jev's decisions. The camera follows the
cart along a long rail with a ruler on it, so the cart really moves, and the wall and the lamps
behind it slide by at their own pace.

- **The rig**: a cart with turning wheels, a steel rod with a glowing tip, and a fading trail
  behind the tip. The tip and the light on the rig turn from teal to amber to red as the rod gets
  into trouble. Hard shoves throw sparks off the wheels. A gust blows streaks across the scene.
- **The angle arc** at the hinge shows the lean in degrees.
- **The danger wedges** run from the "no return" lines out to the fall lines. The wedge on the
  side the rod is tipping to lights up as the rod runs out of room.
- **Jev's mind, on the cart**: five force arrows, one per option, sized and lit by probability. The
  push Jev made is green, with its percentage. `CENTER` is the ring on the cart.
- **The lean budget** (top right) is the honest limit. It adds the lean to where the swing is about
  to carry it, against the lean where gravity beats the hardest shove. Past the white line the rod
  cannot be saved, whatever Jev answers. Jev's own answer to "under control?" sits next to it.
- **The run timer** (top left) counts this run against the best run and turns gold on a new best.
- **The tilt trace** at the bottom shows the last 160 decisions, with every gust marked.
- **The top bar** shows decisions per second, decisions so far and cost so far, large, next to
  this run, best run, falls and tilt.
- **The rail** shows the shared "Jev live mind" panel, the exact text Jev reads, and a bar for
  every finished run.

### Things you can do in the pane

- **Click left or right of the rod** to flick it that way. The further from the tip, the harder.
- **Gust now** sends one gust at the rod.
- **Stand it up** starts a new run.
- **Gravity, Rod length, Gusts** sliders change the rig while it runs. An edit to
  `pendulum.json` resets them.
- **Pause, Step, Reset.**

When the rod falls it swings all the way down and thuds onto the cart. The result shows for about
two and a half seconds, then a new run starts on its own with a new seed. It never sits idle.

## The dials, and why they are honest

The physics is the textbook cart and pole. Gravity pulls the rod over with `g · sin(lean)`. The
hardest shove accelerates the cart by `2 × maxTorque`. So past a lean of
`atan(2 × maxTorque / gravity)` the rod cannot be held: 21.8° at gravity 4, 12.9° at gravity 7,
7.6° at gravity 12. A gust is a blow at the tip, so it swings a short rod harder than a long one,
and a short rod also falls faster. Nothing random is added to make Jev fail, and a test checks
that every fall came after the lean budget ran out.

Measured with the offline stand-in (template rig, 3000 decisions each, 240 seconds):

| setting | falls | best run |
|---|---|---|
| `gravity` 4 | 0 | 240 s |
| `gravity` 7 (template) | 4 | 118 s |
| `gravity` 12 | 39 | 9 s |
| `length` 0.5 | 47 | 6 s |
| `length` 1.6 | 3 | 95 s |

## Jev, honestly

The viewer calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set. Without a key it uses a
deterministic offline stand-in, and the pane shows a `MOCK` badge. The stand-in reads only the
same text live Jev gets (angle, swing, cart speed, gravity, the push each action gives) and picks
the push that steadies the rod. It is a stand-in for the plumbing, not for Jev's judgement.

An earlier version of the stand-in let a clearly falling rod go more often as a "hardness" label
rose (5 of 400 answers at hardness 0, 16 of 400 at hardness 1). That was injected randomness. It
is gone, and a test keeps it out. The rig used to be a torque on a fixed pivot; it is now a real
cart, so "lean right, push right" is what Jev has to learn from the text.

This is a toy rig. It shows decision rate under pressure. It is not real control software.

## Tests

`node --test test/viewer.test.mjs` runs 13 tests: the loop, the verdict, every control, config in
`/state`, a fall and the automatic new run, a bad JSON edit, a non-loopback `Host` header (403),
the stand-in's read, the dials, and the honesty of every fall. `harness dsh check .` checks the
manifest.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API; it contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed; this wrapper is MIT too (see `LICENSE`).
- **You** (Autonomous) built this harness for OpenHarness's store.
