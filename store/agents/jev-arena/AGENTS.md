# Jev Arena in OpenHarness

You are building a Jev Arena: a tiny grid world where **Jev — TypeSafe's System One model — is the
brain**. On the left, the Jev Arena viewer shows a live game board and a "Jev's brain" panel. Jev
picks every move in real time (about 3 per second), and the viewer shows the probability
distribution over `up / down / left / right / wait`, plus Jev's confidence. The user watches a
decision model think.

On the right, you design the world. **You shape the arena; Jev plays it.**

## The workspace

- `arena.json` — the world + rules. This is the ONLY file you edit. The viewer watches it and
  adapts live; you do not need to restart anything.

```jsonc
{
  "title": "My Arena",                       // shows in the viewer header
  "description": "A maze that tests Jev.",   // subtitle
  "width": 18, "height": 12,                 // 2..32 each ("size": 12 still works for a square board)
  "hero":  { "x": 1, "y": 1 },               // where Jev starts
  "goal":  { "x": 10, "y": 10 },             // where Jev must reach
  "walls": [ { "x": 3, "y": 2 }, ... ],      // blocked cells
  "coins": [ { "x": 5, "y": 3 }, ... ],      // collect these on the way
  "rules": "Reach the star. Move one cell at a time; you cannot pass through walls.",
  "speed": 320,                              // ms per decision (60..2000)
  "sight": 2,                                // cells Jev can see (1..99). 99 = the whole board
  "remix": false,                            // false: replay YOUR layout. true: a fresh seeded layout after each run
  "seed": 7                                  // fresh layouts are built from this
}
```

**When the user asks for a world of their own, set `"remix": false`.** With `true` (the starter
value) your layout plays once and is then replaced by fresh seeded layouts.

`sight` is the honest dial. Jev only knows the walls it has seen, and the step counts it reads
treat unseen floor as open. A short sight (1 to 3) sends Jev into dead ends it has to back out of.
The whole board (99) lets it walk the shortest way. Pick it on purpose and say why in chat.

## Your job

Make Jev interesting to watch, and make the arena test it. Good arenas:

- **Reward intelligence.** A maze with walls, a goal, and coins positioned so a dumb "always go
  right" policy starves. Watch Jev's probability distributions change as it reconsiders.
- **Surprise Jev.** A layout where the obvious path is blocked, so you can see Jev's confidence dip
  and recover. That visible uncertainty is the point.
- **Tell a story.** Title and description that make the attempt feel like an event ("the escape", "the
  vault heist", "rescue the last battery").

Do NOT just set a goal in an empty room. Every arena.json you ship should be worth watching for at
least a minute.

You can also tune the pace: lower `speed` (~100) for frantic decisions, higher (~500) for a
deliberate, readable pace. The viewer has Pause / Step / Reset controls so the user can stop
Jev mid-thought and step one decision at a time.

The user can also play in the pane: click a tile to build or break a wall, drop a coin, drag the
star, and move the Sight, Pace and Walls sliders. Those are overrides for their session only. Your
next save of `arena.json` resets them, so tell the user when you save.

## Keep current

- Keep `arena.json` valid JSON at all times. The viewer keeps running on the last good world and
  shows the parse error in the pane until the file parses again.
- Keep `title` and `description` truthful.
- When you change walls / goal / coins, that is the "pause and watch Jev react" moment. Say so in
  chat after you save.

## Rules

- Never propose opening a browser, changing ports, or running a second server. The viewer is already
  running on the left.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly to drive your own experiments
  (for example, to ask Jev to score an arena you designed before committing to it). Use the `jev`
  helpers: `noul`, `choice`, `score`. See `toolchain/README.md`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock so everything still works
  offline. With one set, the viewer calls the real TypeSafe API automatically.
- The Jev Arena viewer writes `.harness/verdict.json` itself. Do not edit it.

## Definition of done

- A valid `arena.json` that parses.
- The world is genuinely interesting to watch (walls, a goal, a route; ideally coins).
- Jev can reach the goal (test it: hit Step or let it run and confirm it arrives).
- Title and description set.
