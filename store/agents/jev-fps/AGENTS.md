# Jev FPS in OpenHarness

On the left is a first-person arena shooter that **Jev plays by itself**. Jev is TypeSafe's System
One model. It never sees pixels. About nine times a second the fight is written out as a few lines
of text and Jev answers four typed questions in one call: `turn`, `move`, `fire` and `threat`. The
pane shows the 3D view, a minimap, Jev's answers as lit keys, and the exact text Jev reads.

On the right, you edit `level.json`. This is the ONLY file you edit. The viewer watches it and
restarts the fight at wave 1 the moment you save.

## The level file

```jsonc
{
  "title": "Jev FPS",
  "description": "One line about this level.",
  "map": [                       // 8 to 40 rows, every row the same width (8 to 64)
    "################",
    "#P.....#.......#",          // P  the marine's start (exactly one)
    "#......#...D...#",          // D  a demon spawn (at least one, reachable from P)
    "#..%%..=..M..A.#",          // M  medkit   A  ammo   .  floor
    "################"           // #  stone wall   %  tech wall   =  hell brick   (border must be wall)
  ],
  "tickMs": 110,                 // one Jev decision per tick. 60 to 1000.
  "demons": 4,                   // alive at once in wave 1 (+1 each wave). 1 to 24.
  "demonSpeed": 1.2,             // tiles per second in wave 1 (+12% each wave). 0.2 to 6. THE DIAL.
  "demonHealth": 60,             // a shot does 34. 10 to 400.
  "demonDamage": 9,              // per bite, about two bites a second. 1 to 60.
  "kills": 12,                   // kills to clear wave 1 (+4 each wave). 1 to 200.
  "ammo": 60,                    // starting ammo. 0 to 99.
  "seed": 7,
  "style": "How Jev should fight, in plain words. It is the first line of the text Jev reads."
}
```

## Your job

Design a level that is fun to watch, then find out where Jev breaks.

- **Draw the map.** Rooms, corridors, pillars for cover, a boss room. Use `%` and `=` walls to give
  areas their own look. Put spawns where demons arrive from more than one side. Put medkits and ammo
  where reaching them is a risk.
- **Set the pace.** `demonSpeed` and `demons` are the difficulty. Slow and few: Jev clears wave
  after wave. Fast and many: it gets surrounded. The person can also change speed live with the
  slider in the pane.
- **Write the style line.** "Keep your back to a wall and let them come" plays differently from
  "hunt them down". With a real key, Jev reads it on every decision.
- **Report what you see.** Read `.harness/verdict.json` for wave, kills, deaths, best wave and shot
  accuracy. Say at which speed Jev stops clearing waves. If it never dies the level is dull. If it
  dies in wave 1 every time it is unfair. Either is a finding to report, not something to hide.

Do NOT just ship the template. Every level should be its own arena with a pace you chose on purpose.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`. It checks the map shape, the border, that
there is one `P`, that every `D` can be reached, and every number's range.

## Rules

- Edit only `level.json`. Keep it valid JSON. A bad edit does not crash the fight. The pane shows
  the error and keeps running on the last good level.
- Never edit `.harness/verdict.json`. The viewer writes it.
- The viewer is already running in the left pane. Never propose opening a browser, changing ports
  or running a second server.
- You can ask Jev yourself through `toolchain/jev.mjs` (`evaluate`, and the `jev.choice`,
  `jev.noul`, `jev.score` builders), for example to see how it reads one situation.
- Without `TYPESAFE_API_KEY` the harness runs on a deterministic offline stand-in, and the pane
  says `MOCK`. The stand-in reads the same text and answers the same questions. It is there so the
  demo runs anywhere. It is not Jev's judgement, so do not describe its play as Jev's.
- This is a demo. The arena and the demons are made up. Do not present the numbers as a benchmark.

## Definition of done

- `level.json` parses and passes `toolchain/check.mjs`.
- The pane shows your map, and the fight runs without an error banner.
- You told the person what pace you chose, how far Jev gets, and where it starts to fail.
