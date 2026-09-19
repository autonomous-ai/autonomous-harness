# Jev Duel in OpenHarness

On the left, the Jev Duel viewer runs a live Reversi battle. **Jev — TypeSafe's System One model —
plays BOTH sides**, and a third Jev referees. You shape the confrontation; Jev fights it and judges
it.

On the right, you edit `battle.json`. This is the ONLY file you edit. The viewer watches it and
reframes both rivals live — edit the personalities mid-game and the fight changes character.

## The workspace

- `battle.json` — the duel's staging.

```jsonc
{
  "title": "A Snappy Name",
  "description": "A subtitle felt in the viewer.",
  "size": 6,               // even, 4..12. 6 is a tense, fast game.
  "speed": 700,            // ms per move (min 200)
  "rivals": {
    "O": { "name": "Patience", "personality": "Patient and positional. You prize the corners above all..." },
    "X": { "name": "Greed",    "personality": "Greedy and opportunistic. Every turn you want the biggest flip..." }
  },
  "referee": "Call it fairly: how strong was the move, was it aggressive or quiet, and how decided is the game now? Name the leader and warn when the game tips."
}
```

`O` and `X` are the disks. Each rival needs a `name` and a `personality` — a short, vivid instruction
that reframes how Jev chooses a move. `toolchain/check.mjs` validates the shape.

## Your job

Make the duel worth watching. The game rules are fixed (fair Reversi); the *drama* is yours:

- **Give the rivals clashing personalities.** "You prize the corners above all, you never hand your
  rival a dangerous square" vs "you want the biggest flip, you smother the center". The mock reads
  the personality into its move bias; live Jev does the same. Two different personas on one board
  is the show.
- **Give them a story.** Name them like fighters ("Patience" / "Greed", "The Glacier" / "The
  Comet"). Title and description set the stage.
- **Tune the referee.** A sharp referee focus ("name the leader, warn the moment the game tips")
  turns the running log into commentary instead of a score ticker.

Do NOT just ship the template's rivals. Every `battle.json` you publish should stage a distinct
confrontation with distinct, clash-prone personalities.

Validate with `node "$JEV_DSH/toolchain/check.mjs"` (parses + range-checks `battle.json`). The real
test is the board: watch whether the personalities actually fight — does the greedy side grab flips
while the patient side takes corners? If their play looks identical, sharpen the personalities.

## Keep current

- Keep `battle.json` valid JSON always. A bad edit freezes the battle on the last good state.
- Keep `title`, `description`, and rival names truthful.
- When you change a personality, that's the "pause and watch Jev change character" moment. Say so in
  chat after you save.

## Rules

- Never propose opening a browser, changing ports, or running a second server. The viewer is already
  running on the left; it auto-plays the battle on a clock. Use its Play / Pause / Step buttons.
- Jev is reached through `toolchain/jev.mjs`. You can call it directly — for example, to ask the
  referee Jev to score a matchup before you commit to it, or to audition a personality. Use the
  `jev` helpers: `noul`, `choice`, `score`. See `toolchain/README.md`.
- Without a `TYPESAFE_API_KEY`, Jev runs on a deterministic local mock that still *plays legal
  Reversi* (reads the same board text) so everything works offline. With a key set, the viewer calls
  the real TypeSafe API automatically.
- The Jev Duel viewer writes `.harness/verdict.json` itself. Do not edit it.

## Definition of done

- A valid `battle.json` that parses and passes `toolchain/check.mjs`.
- Two rivals with real, clashing personalities, distinct names, a story in title/description.
- A game that actually reaches a conclusion (let it run; confirm a winner or draw appears, or at
  least that both sides are making distinct-looking moves).
