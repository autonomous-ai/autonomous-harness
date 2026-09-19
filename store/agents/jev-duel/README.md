# Jev Duel

**A live Reversi battle where Jev plays BOTH sides, and a third Jev is the referee.** Jev is
TypeSafe's System One decision model. It never writes text. It answers typed questions with
probabilities, fast. Two rivals with different personalities meet on the board, and the referee
scores every move.

This is a harness for OpenHarness. The agent on the right edits `battle.json`. The viewer on the
left runs the game. The game is made up. The decision loop is the demo.

## The pane

- **The board.** A disk is thrown in from its player's card and drops onto the square. The disks it
  wins really turn over in 3D, one after the other from the nearest outward, with sparks.
- **Jev's mind is on the board.** Right after a move, the next player has already answered. Every
  legal square gets a dot in that player's colour. The strength of the dot is the probability Jev
  gave that move, with the number next to it. The chosen square has a white ring.
- **Two player cards** sit left and right of the board: name, disk count, personality, what the
  player reads, and its last move with the referee's call. The card of the side to move glows.
- **Territory bar** shows cyan, empty and rose as shares of the board.
- **Move quality** is a line of the referee's score (0 blunder to 2 brilliant) for every move of the
  game, with each player's average.
- **The top bar** shows decisions per second, decisions made, and cost so far, next to the game
  number, the move number and games won.
- **It never stops.** When a game ends the winner's card lights up, the winner's colour rains over
  the board, and a banner counts down. About five seconds later a new game starts by itself.

## Things you can do in the pane

| Do this | What happens |
|---|---|
| Click a dot on the board | Plays that move for the side to move, instead of Jev's pick. It is marked "you" in the log. |
| **Swap sides** | The two players change colour. The player to move rethinks at once, so the dots change. |
| **Board** 6, 8, 10 | Starts a new game on that size. |
| **Pace** slider | Time between moves, 120 to 2000 ms. |
| **Reads** slider on each card | How much the text tells that player about each move. The dots change at once. |
| Pause, Step, Reset | Stop the clock, play one move, or start over from `battle.json`. |

The sliders and buttons are overrides for this session. An edit to `battle.json` resets them.

## The honest dial: what each player reads

Each player gets the board and its list of legal moves as text. `insight` sets how much that list says:

- **0** the move and how many disks it flips
- **1** plus where the square sits: corner, edge, next to an open corner, or inner square
- **2** plus what the rival can do in reply: its best reply, whether it is handed a corner, how many
  moves it is left with

A player that reads more plays better. Nothing random is added. Measured with the offline stand-in,
same neutral personality on both sides, 6 by 6 board, about 43 games each:

| O reads | X reads | O wins | X wins |
|---|---|---|---|
| 2 | 0 | 41 | 1 |
| 0 | 2 | 0 | 43 |
| 2 | 2 | 16 | 25 |

Personality matters too. With both reading 2, a patient corner-lover as O beat a greedy disk-grabber
48 to 11 in 60 games.

## battle.json

```jsonc
{
  "title": "The Quiet War",
  "description": "A patient corner-lover versus a greedy opportunist.",
  "size": 6,                 // even, 4 to 12
  "speed": 700,              // ms per move
  "rivals": {
    "O": { "name": "Patience", "personality": "Patient and positional. You prize the corners...", "insight": 2 },
    "X": { "name": "Greed",    "personality": "Greedy and opportunistic. You want the biggest flip...", "insight": 2 }
  },
  "referee": "Call it fairly: how strong was the move, was it aggressive, how decided is the game?"
}
```

A bad edit never stops the demo. The viewer keeps the last good settings and shows the error in the pane.

## Anatomy

```
jev-duel/
  harness.json              the manifest (engine: claude)
  AGENTS.md                 tells the chat agent how to write rivals worth watching
  skills/duel/SKILL.md      the matchmaking and checking craft
  template/battle.json      the starter duel ("The Quiet War": patience against greed)
  toolchain/
    jev.mjs                 the Jev client (real TypeSafe API, or the offline stand-in)
    check.mjs               checks battle.json
    viewer.sh, setup.sh, doctor.sh, init-workspace.sh
  viewer/
    viewer.mjs              the loopback server and the game loop
    game.mjs                Reversi rules, and the text the players and the referee read
    mock.mjs                the offline stand-in's reader. It reads only the text Jev gets.
    index.html, studio.css, studio.js, jev-hud.js   the pane
  test/viewer.test.mjs
```

Each move makes two Jev calls. The referee call asks three questions at once: `strong` (a score from
blunder to brilliant), `aggressive` (yes or no) and `decided` (a score from wide open to decided).
The player call asks two: `move` (one of the legal squares) and `confident` (yes or no).

The viewer calls `POST /v1/systemone` at TypeSafe when `TYPESAFE_API_KEY` is set. Without a key it
uses the offline stand-in, so everything runs offline and in tests, and the pane shows a `MOCK`
badge. It writes `.harness/verdict.json` itself.

## Jev, honestly

Jev is new and in early access. Its headline claims mostly come from the vendor. The offline
stand-in is for the plumbing, not for judgement: it weighs the facts written in the text (flips,
corners, the rival's reply) with weights taken from words in the personality. The rules engine keeps
every move legal, so Jev can only pick from legal squares. How well it plays is up to the model.
Treat its play as a fast, cheap signal, not a solved player.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness only calls the public API. It
  contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This harness is MIT too (see `LICENSE`).
- **Autonomous** built this harness for the OpenHarness store.
