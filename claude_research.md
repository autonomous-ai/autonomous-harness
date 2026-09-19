# Research review: seven interactive creation harnesses

Reviewed 2026-09-19. This replaces the earlier speculative research narrative, preserved in Git
history. That narrative mixed possible projects with unsupported model names, rankings, release
claims and license conclusions. Those claims are not used as evidence for this release.

The product decision is to give people a working creative system they can direct in plain language,
inspect, change and export. Each starter uses original code and browser APIs; none incorporates
third-party engine code or promises access to physical equipment or hosted model services.

| Harness | User capability | Artifact and feedback loop |
|---|---|---|
| Voxel Worlds / Tidelands | Build a place and inhabit it | Offline WebGL island, collision, block editing, day/night, save and restore |
| Generative Art / Fieldwork | Design a reproducible edition | Three geometric systems, named random streams, palette controls, print export |
| Music Studio / Afterhours | Compose and keep a track | Editable score, synthesized PCM, a finite arrangement, mix controls, WAV |
| Creative Direction / Forme | Make a coherent visual identity | Coordinated poster/type/palette systems, contrast measurement, SVG and tokens |
| Drone Pilot / Vector | Explore control policies through flight | Fixed-step gate course, manual/autopilot handoff, telemetry, repeatable runs |
| Game Master / Relay | Test strategic ideas against evidence | Finite matches, replayable decisions, competing policies, seeded tournaments |
| Lab Bench / Signal | Investigate an experiment | Explicit synthetic model, observations, regression, uncertainty, CSV |

## Sources and what they establish

- [tiny-world-builder](https://github.com/jasonkneen/tiny-world-builder) is an upstream browser-world
  project and an inspiration for the domain. No code from that project is bundled here. Its
  existence is not evidence for any particular model's benchmark ranking.
- [p5.js: randomSeed](https://p5js.org/reference/p5/randomSeed/) documents repeatable random sequences
  from a seed. Our implementations use their own named PRNG streams and directly test repeatability.
- [MDN: Web Audio](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) documents browser
  audio graphs and playback. Afterhours uses its own deterministic PCM synthesis and Web Audio
  playback, with no sample downloads, GPU model or external service.
- [MDN: Pointer Lock](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API) documents
  first-person mouse input and the iframe permission it requires. Tidelands also supports dragging
  and visible movement controls.
- [MDN: iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
  documents the sandbox permissions relevant to forms, same-origin APIs, pointer lock and
  downloads. Our regression reproduces sibling-fetch, localStorage and module loading through the
  real viewer. The viewer runs trusted local workspace code and is not an isolation boundary.

## Engineering conclusions, supported by this branch

A beautiful waiting screen does not confer a capability. The earlier seven placeholders and
URL-change-only E2E were insufficient. Each starter now begins as an actual working artifact,
contains a reusable pure model, exposes meaningful controls, and produces an export the user owns.

The model checker is copied into every workspace. It reads the user's actual edited HTML,
exercises seeds and writes evidence. Browser behavior and presentation are verified separately.
Coverage of a Node helper does not establish coverage of a browser artifact or shell subprocess.

See [work/REVIEW.md](work/REVIEW.md) for the audit and
[the test guide](store/tools/experience-tests/README.md) for reproducible verification.
