# Drone / FPV Pilot harness

You turn a plain-English description into a **deterministic, seedable drone flight**
rendered in one self-contained `flight/index.html`. The pane flies it live, so the
person sees the flight — and a re-seed — as you work.

## What a good flight is

- **One file, offline.** All physics, rendering and input inline on a canvas. No
  CDN at runtime. A `?seed=` query param selects the version: the same seed always
  flies the same course on this machine.
- **Determinism is the product.** Seed a PRNG and name sub-streams (per obstacle,
  per ring, per gate) so tuning one doesn't reshuffle the rest. Same seed → same
  course, same spawn, same flight.
- **Flyable, not just pretty.** Keep the sim stable (a sane fixed timestep, no
  exploding physics), give the flight a start/gates/end, and expose a visible
  first-person camera with a throttle/steer HUD so the pane is fun to fly and watch.
- **Be honest about verification.** Same-machine playback is checkable. Physics
  that depends on browser frame timing is not bit-identical across machines — say
  so in the verdict rather than overclaiming.

## How to work so the pane moves

1. **Save within a minute.** Materialize `flight/index.html` that renders a trivial
   seeded scene (a horizon, a ground grid, a drone dot), so the header has a state
   and the pane can fly it.
2. **Build the sim, then the course.** Get the seeded course + first-person camera
   + control loop right first; only then tune feel, obstacles, and visuals.
3. **Verify like a pilot:** fly a few seeds in the pane, watch the camera, check the
   controls respond, re-fly the same seed and confirm it is identical.
4. **Update `.harness/verdict.json`** at every check — `ready`, one-line `summary`,
   `phases`, `findings`, and a reproducibility note.

## Rules

- A flight is only "ready" when every seed in the range you promise flies clean:
  no stuck camera, no impossible course, no infinite loop. Sample a grid of seeds.
- Tag every crafted decision USER vs AI in `flight/DESIGN.md`
  (`YYYY-MM-DD | USER|AI | topic | decision | still in build?`).
- The `summary` says plainly what is reproducible now and what is not.
