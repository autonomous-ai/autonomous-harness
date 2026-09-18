# Jev Launcher in OpenHarness

On the left, Jev Launcher is a live predictive command palette. **Jev — TypeSafe's System One
model — is the oracle.** You type into the palette; on every keystroke Jev reads your query and
re-ranks the launch targets, showing which one it would fire and how confident it is. Launching a
target is always your call, and nothing actually launches — it's a demo of a decision model ranking
in real time.

On the right, you edit `launcher.json`. This is the ONLY file you edit. It holds the palette: the
name, category and aliases for each launch target. The viewer watches it and Jev adapts
immediately — change a target's aliases and the ranking moves.

## The palette file

```jsonc
{
  "title": "The Developer's Deck",
  "description": "A command palette for a developer's everyday launch targets.",
  "prompt": "You are Jev, a fast launcher oracle. Pick the ONE launch target the user most likely wants, and be decisive at every keystroke.",
  "targets": [
    { "name": "Run tests", "category": "Dev", "aliases": ["test", "pytest", "npm test", "spec"], "featured": true },
    { "name": "Open Editor", "category": "Apps", "aliases": ["code", "vscode", "ide", "vim"] }
  ]
}
```

- **`targets[].name`** — what Jev is choosing among (shown in the ranking).
- **`targets[].aliases`** — the words people would type to reach it. Jev fuzzy-matches your query
  against name + aliases. Better aliases = sharper, more distinct ranking.
- **`targets[].category`** — a small tag shown next to the name.
- **`targets[].featured`** — true targets lead when the palette is idle and nothing is typed yet.

## Your job

Design palettes that show Jev ranking well:

- **Give every target good aliases.** Jev ranks by matching your query against name + aliases.
  Distinct, overlapping aliases (e.g. "ship", "release", "deploy") make the ranking obvious and fun
  to watch as a query narrows.
- **Curate a coherent palette.** Pick targets with a theme (a developer's deck, a media hub, a
  spaceship's launch console). The `title` + `description` make it an event.
- **Make it ambiguous-then-resolved.** A good demo is one where a partial query (like "de") is
  genuinely uncertain and a longer one ("dep") snaps to a clear winner — that's the live re-ranking.

Do NOT just ship the template. Every `launcher.json` you publish should be a distinct palette with a
deliberate, testable ranking.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. The real test is the ranking: does Jev's top
pick track the query you typed — or does it pick the same target no matter what? If it doesn't move,
that's a finding to report (likely aliases that don't match your queries), not a bug to mask.

## Keep current

- Keep `launcher.json` valid JSON always. A bad edit freezes the palette on the last good state.
- Keep `title`, `description` and `prompt` truthful — and never present this as a real OS launcher.

## Rules

- Never propose opening a browser, changing ports, or running a second server. The viewer is already
  running on the left.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to ask Jev's read on a query
  before you commit it (e.g. "what does Jev pick for 'de'?"). Use the `jev` helpers: `noul`,
  `choice`, `score`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still reads the palette
  and query and ranks by fuzzy match, so the desk works offline. With a key, the viewer calls the
  real API.
- The Jev Launcher viewer writes `.harness/verdict.json` itself. Do not edit it.
- This is a demo. Launching is always on paper — never present it as real software launching.

## Definition of done

- A valid `launcher.json` that parses and passes `toolchain/check.mjs`.
- A palette with a coherent theme and good per-target aliases so Jev's ranking is meaningful.
- The ranking tracks the query: Jev's pick changes as you type, and confident queries get a clear
  winner (report if it never moves).
