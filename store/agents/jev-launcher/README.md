# Jev Launcher

**A command palette where Jev, TypeSafe's System One model, ranks every target on every keystroke.**
On each key the palette and the query are written out as text, and Jev answers three typed questions
in one call: which target to launch (with a probability for every target), which category the person
is after, and whether the query is clear enough to launch now.

**The palette is made up and nothing is ever really launched.** "Launch" only writes a line in the
log.

This is a harness for OpenHarness. The agent on the right edits `launcher.json`. The viewer on the
left is the palette.

## The pane

- **The input is the hero.** Click it and type. Every key goes to Jev, and the rows re-sort with a
  smooth slide, usually in 10 to 20 ms on the offline stand-in. The letters you typed light up inside
  the names and aliases.
- **Jev's mind on every row.** Each row carries a probability bar. The first row glows. A "launch
  ready" chip shows Jev's yes/no read on whether the query is clear enough.
- **The ghost typist.** When nobody has typed for 15 seconds, a demo typist takes over, clearly
  tagged **DEMO**. It picks a target it wants, types one of that target's handles a letter at a time
  (sometimes with a fumbled letter), and launches whatever Jev ranks first. Because its intent is
  known, the pane can score Jev honestly. It stops the moment you press a key.
- **Jev's mind, key by key.** A strip of stacked columns, one per ranking. Colours are targets. You
  can watch the probability pile onto one target as letters arrive. A tick marks a right launch.
- **First row right, by letters typed.** One bar per query length. One letter is ambiguous. Four
  letters are almost always enough.
- **The top bar.** Keystrokes per second, rankings made and cost so far, large. Also how often the
  first row was right, how many letters it took, launches, and the key-to-ranking time.
- **The rail.** The shared "Jev live mind" panel, the launch log, and how it works.

## Things to try in the pane

- **Type** to take over from the demo typist.
- **Arrow keys** pick a row. **Enter** launches it on paper, with a small burst. **Esc** clears.
- **Click a row** to mark it as the right answer. The pane then scores Jev's first row and adds it to
  the top-1 accuracy. Click another row to change your mind: the same ranking is re-scored, not
  counted twice.
- **Typos**, **Letters typed** and **Look-alikes** sliders: the honest difficulty dials. See below.
- **Typist speed** slider, **Pause typist** and **Reset**.

The sliders override `launcher.json` while you play. The next edit to `launcher.json`, or Reset,
puts the file back in charge.

## The difficulty dials, measured

The dials change what Jev gets to read, never Jev. `typos` is the chance the demo typist fumbles a
letter. `chars` is how few letters it types before it launches. `lookalikes` adds near-duplicate
targets that share the same aliases. Nothing random is added to Jev's decision. Measured on the
offline stand-in with the template palette, about 400 demo launches each:

| setting | first row right |
|---|---|
| easy: `typos` 0, `chars` 12, `lookalikes` 0 | 99.2% |
| template: `typos` 0.06, `chars` 8 | 96.4% |
| `typos` 0.2 | 81.8% |
| `typos` 0.4 | 52.0% |
| `chars` 2 | 78.3% |
| `chars` 1 | 35.2% |
| `lookalikes` 6 | 68.5% |
| hard: `typos` 0.35, `chars` 3, `lookalikes` 6 | 39.9% |

Inside one easy run, by letters typed: 35% right after one letter, 77% after two, 96% after three,
99% after four, 100% from five. The test suite proves the dials, together and one at a time.

## Anatomy

```
jev-launcher/
  harness.json              # manifest (engine: claude)
  AGENTS.md                 # tells the agent how to shape launcher.json
  skills/launcher/SKILL.md  # palette design and how to check it
  template/launcher.json    # a starter palette
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API, or a deterministic offline stand-in)
    check.mjs               # validates launcher.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs              # loopback server, the ranking loop, the demo typist, the controls, the verdict
    mock.mjs                # the offline stand-in's reader for this palette
    index.html studio.js studio.css base.css jev-hud.js
  test/viewer.test.mjs
```

## `launcher.json`

| key | range | meaning |
|---|---|---|
| `title`, `description` | text | shown in the pane |
| `prompt` | text | Jev's brief. It is part of the text Jev reads |
| `targets[]` | 2 to 30 | `name`, `category`, `aliases[]`, optional `featured` |
| `typos` | 0 to 1 | chance the demo typist fumbles a letter. A difficulty dial |
| `chars` | 1 to 12 | the demo typist launches after at most this many letters. A difficulty dial |
| `lookalikes` | 0 to 6 | how many targets get a near-duplicate twin. A difficulty dial |
| `stepMs` | 40 to 2000 | demo typist pace, milliseconds per keystroke |
| `idleMs` | 1000 to 120000 | the demo typist comes back after this long without a human key |
| `seed` | 0 and up | makes the demo typist repeatable |

A bad JSON edit never stops the palette. It keeps running on the last good file and shows the error.

## Jev, honestly

The viewer calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set. Without a key it uses a
deterministic offline stand-in, and the pane shows a MOCK badge. The stand-in in `viewer/mock.mjs`
reads only the text Jev would read: the numbered palette lines and the current query. It knows
nothing about who is typing or which target they want. It exists because the generic reader in
`toolchain/jev.mjs` gives weight to every word of an option's name that appears anywhere in the
text, and every name is printed in the palette, so long names always led (the query "music" ranked
"Deploy to prod" above "Music"). `toolchain/jev.mjs` is unchanged. The stand-in is there to prove the
plumbing, not to stand for Jev's judgement. Cost in the pane is what live Jev would charge for the
same tokens.

The controls: `POST /control` with `query` (`text`), `launch` (`name`), `mark` (`name`), `touch`,
`demo`, `pause`, `start`, `reset`, `tick` (`{"n": 500}` runs 500 demo typist steps at once, tests use
it so they never wait), and `set` (`key`: `typos`, `chars`, `lookalikes`, `stepMs` or `idleMs`). The
reply carries the new ranking, so the pane updates without waiting for the event stream. The server
only answers on loopback.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- Built by Autonomous for the OpenHarness store.
