# Building a flagship Jev harness

You are building ONE harness for the OpenHarness store. A harness is a folder. When a person opens
it, they get a **viewer on the left** (a live web pane) and a **coding agent in a chat on the
right**. The agent edits one JSON file in the workspace; the viewer watches that file and reacts
live. **The viewer is the experience.** It must be a joy to watch and to poke at. A plain canvas with
a few shapes is a failure. Aim for something a person would screen-record and post.

## What Jev is (facts, verified from the docs)

Jev is TypeSafe AI's "System One" model. It never writes text. You send a `state` (text or JSON)
plus a map of typed `questions`. It answers ALL questions in one parallel pass in roughly 100 ms,
each with calibrated probabilities:

- `noul` yes/no, returns `{ noul: 0..1 }`
- `choice` one of up to 255 options, returns `{ choice, probabilities: {opt: p}, confidence }`
- `score` a position on a 2 to 10 level scale, returns `{ score, legend, probabilities, confidence }`

Price is $0.042 per million input tokens and output is free. State is encoded once and shared, and
about 100 questions in one call cost almost no extra latency. So the idiomatic move is: **put shared
facts in `state`, and ask MANY questions in ONE call.** Questions cannot see each other.

What people post about Jev always flexes three numbers: **how fast, how cheap, how many.** Your
viewer must show them, live.

## The kit (copy it, do not rewrite it)

Kit root: `store/tools/jev-kit/`. Copy these into your harness folder unchanged, then keep them current with `node store/tools/sync-jev-kit.mjs`:

| kit file | goes to | what it is |
|---|---|---|
| `jev.mjs` | `toolchain/jev.mjs` | Jev client. Real API when `TYPESAFE_API_KEY` is set, else a deterministic mock. |
| `kit.mjs` | `viewer/kit.mjs` | Loopback-only server: static files, `/state`, `/events` SSE, `/jev`, `/control`. Also `writeVerdict`, `watchConfig`, `mulberry32`, `clean`. |
| `jev-hud.js` | `viewer/jev-hud.js` | The "Jev live mind" panel. Auto-mounts into `[data-jev-hud]`, else first in `#rail`. |
| `base.css` | `viewer/base.css` | Shared look. Set `--accent` and `--accent2` in your `studio.css`. |
| `LICENSE`, `THIRD_PARTY_NOTICES.md`, `.gitignore` | same names | boilerplate: copy from `store/agents/jev-fps/` |
| `toolchain/setup.sh`, `init-workspace.sh`, `doctor.sh`, `viewer.sh`, `README.md` | `toolchain/` | boilerplate: copy from `store/agents/jev-fps/toolchain/`. Fix the harness name in the comments of `doctor.sh` and `viewer.sh`. Keep them executable (`chmod +x`). |

`jev.mjs` API:

```js
import { evaluate, jev, snapshot } from '../toolchain/jev.mjs'
const res = await evaluate({
  state,                       // string | object | array
  questions: {                 // ask many at once
    team: jev.choice({ billing: 'payment or invoice problems', tech: 'bugs, outages' }, 'Which team owns this?'),
    move: jev.choice(['LEFT', 'RIGHT', 'HOLD'], 'Which way?'),
    urgent: jev.noul('Does this need a reply today?'),
    anger: jev.score(['calm', 'annoyed', 'furious'], 'How angry is the customer?'),
  },
  salt,                        // mock only: vary per call
  mock: (stateText, id, q, salt) => answerOrNull,   // mock only: YOUR domain reader (see below)
})
res.answers.team  // { type:'choice', choice:'tech', confidence:0.8, probabilities:{billing:.1, tech:.8} }
res.client        // 'typesafe' | 'mock'
res.latencyMs
```

The generic mock scores word overlap between the state and each option's name plus description, so
**always give options descriptions** and make synthetic text contain matching vocabulary. For a
game or control loop, pass a `mock` function that parses your state text and returns a full answer
object, in the same shape the API returns, with a real probability distribution (chosen option
around 0.7 to 0.9, the rest spread, never exactly one-hot). Return `null` to fall through to the
generic mock. The mock must read ONLY the state text that live Jev would also get. No peeking at
hidden simulator variables. The mock is a stand-in for plumbing, and the HUD badges it `MOCK`.

`kit.mjs` API: `serveViewer({ here, port, files?, state, control })` returns
`{ url, broadcast(obj, event='state'), close() }`. `watchConfig(file, defaults, onChange)` returns
`{ get(), error(), close() }`. `writeVerdict(workspace, {ready, summary, findings, artifact, phases})`.

## Folder contract (the store's tests check all of this)

```
store/agents/<name>/
  harness.json          spec 1. id MUST be "autonomous/<name>". description <= 300 chars.
  store.json            ONLY these keys: homepage, upstream, license, tagline (<= 80 chars), examples[{prompt, caption}]. NO "$schema".
  README.md             must contain the exact heading "## Credit and stewardship"
  AGENTS.md             instructions for the chat agent
  LICENSE  THIRD_PARTY_NOTICES.md  .gitignore
  skills/<skill>/SKILL.md
  template/<marker>.json      the starter file the agent edits
  toolchain/  jev.mjs check.mjs setup.sh init-workspace.sh doctor.sh viewer.sh README.md
  viewer/     viewer.mjs kit.mjs index.html base.css studio.css studio.js jev-hud.js
  test/viewer.test.mjs
```

Copy `harness.json`, `store.json`, `README.md`, `AGENTS.md`, `skills/*/SKILL.md` and
`toolchain/check.mjs` structure from the reference harness `store/agents/jev-fps/` and rewrite
every word for your harness. `harness.json` keeps the same shape: `engine: "claude"`,
`workspace{template, marker, init}`, `agent{instructions, skills, env{JEV_DSH, JEV_MODEL}}`,
`toolchain{setup, doctor}`, `viewer{command, url, artifactExtensions}`, `verdict`.

`viewer.mjs` must export `async function start<Name>Viewer({ workspace, port = 0 })` returning
`{ url, close() }`, and must run standalone from env `HARNESS_WORKSPACE` and `HARNESS_VIEWER_PORT`
(see the bottom of `store/agents/jev-fps/viewer/viewer.mjs`). The viewer writes `.harness/verdict.json` itself.

Rules for the words you write (README, AGENTS.md, SKILL.md, store.json):

- It is a demo on synthetic data. Never present it as real trading, real security advice, real
  medical or financial judgement, or a real product launch. Say the data is made up.
- In AGENTS.md: the agent edits ONLY the marker JSON. It must never propose opening a browser,
  changing ports, or running a second server. It must not edit `.harness/verdict.json`.
- Plain, simple English. Short sentences. No hype words.
- No trademarks in the harness name or id.

## Viewer architecture

- `viewer.mjs` owns the simulation. It ticks on a timer, calls `evaluate()` each decision, and
  `broadcast()`s a compact state frame over SSE. Support `POST /control` commands at least
  `pause`, `start`, `reset`, `tick` (advance exactly one decision, used by tests so they never wait
  on timers), plus your own interaction commands.
- Seed all randomness with `mulberry32` so runs are reproducible.
- A bad JSON edit must never crash the demo. Keep the last good config and show the parse error in
  the pane (`watchConfig` gives you this).
- **Declare every `let` before the first function call that can touch it.** A past harness hit a
  temporal-dead-zone error inside a try/catch, fell back to defaults silently, and ignored its
  config. Add a test that a non-default config value really shows up in `/state`.
- **Never end.** When an episode finishes, show the result for about 3 seconds, then start the next
  episode on its own. An idle finished screen is a dead demo.
- `studio.js` renders with `requestAnimationFrame` at 60 fps and interpolates between server frames,
  so motion is smooth even when decisions arrive 8 to 10 times a second. Handle device pixel ratio
  and resize. No frameworks, no CDNs, no network calls except to the viewer's own server.
- Everything must work from `http://127.0.0.1:<port>/` inside an embedded pane about 900 to 1400 px
  wide. Check 1100x800 as well as 1440x900.

## The quality bar for the viewer

1. **Alive in the first second.** Motion, numbers changing, no "press start".
2. **Jev's mind is visible.** The kit HUD shows the questions and probability bars. Also tie the
   decision into the main scene (an aim line, a highlight on the chosen option, a confidence glow).
3. **The three numbers**: decisions per second, cost so far, items done. Large, in the top bar.
4. **The person can play.** At least three real interactions in the pane (click, drag, type, slider,
   buttons) that change what Jev faces, with instant visible effect. Explain them in one short line.
5. **The difficulty dial is honest.** Easy settings: Jev does well. Hard settings: it visibly
   struggles, because of a real limit (speed, noise, ambiguity), never injected randomness.
   Prove the dial in a test.
6. **Polish**: glow, particles, easing, trails, tabular numbers, no layout jumps, no overlapping
   text, nothing clipped, no scrollbars in the main scene. Dark theme from `base.css`.
7. **Honest**: the MOCK badge stays visible. Label synthetic data as synthetic.

## Environment rules (important, the shell is restricted)

- Work ONLY inside your harness folder and your scratch folder (both given in your task).
- The shell refuses complex inline commands: no heredocs, no `for` loops with variables, no
  `node -e` with long code, no `cd` to other repos. **Create and edit files with the Write and
  Edit tools.** To run logic, write a `.mjs` file in your scratch folder and run `node <file>`.
- Do NOT run any `git` command. Do not commit. The lead does that.
- Do not install packages. Node 26 is available. No npm dependencies at all.
- Use ports in your assigned range only.

## How to look at your viewer (do this, more than once)

`shot.mjs` in the kit drives a headless Chrome over CDP port 9333. Start one first:
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 --user-data-dir=<a scratch folder> about:blank`

1. Write a tiny `serve.mjs` in your scratch folder that copies your `template/` into a temp
   workspace and calls your `start<Name>Viewer({ workspace, port })` on a port in your range.
   Run it in the background.
2. `node store/tools/jev-kit/shot.mjs --url http://127.0.0.1:<port>/ --out <scratch>/a.png --wait 3000`
   For interactions, write a `steps.json` (format is documented at the top of `shot.mjs`).
3. Open the PNG with the Read tool and **look at it critically**. Fix what is ugly, empty, cramped,
   overlapping or confusing. Repeat until it looks great. Any `PAGE EXCEPTION` or `PAGE console.error`
   line printed by the tool is a bug to fix.
4. Restart `serve.mjs` after you change `viewer.mjs` (it is a long-running process). Static files
   are re-read on every request, so CSS and JS changes only need a new screenshot.

## Tests and checks (all must pass before you report)

- `node --test test/viewer.test.mjs` from your harness folder, with at least these tests:
  the loop advances and Jev decides; config takes effect in `/state`; verdict file is written with
  `spec:1`, `summary`, `findings[]`, `phases[]`; all control commands return 200; a bad JSON edit
  keeps the demo alive and reports an error; a non-loopback `Host` header gets 403 (use a raw
  `node:net` socket, because `fetch` will not let you override `Host`); **the difficulty dial**
  (easy beats hard by a clear margin). Drive time with the `tick` control, not sleeps.
- `harness dsh check .` from your harness folder prints `conforms to spec 1`.
- `node toolchain/check.mjs` accepts the template and rejects an out-of-range value.
- Screenshots reviewed at 1440x900 and 1100x800, with a clean page console.

## Report back

End with a short report: what you built, the interactions, the dial and its measured numbers, the
test and check output (pass counts), the screenshot paths you judged final, and anything you know
is weak. Be honest. If something does not work, say so.
