# Jev Browser

**Jev operates a web browser, live, and books a flight in a few seconds.** Jev is TypeSafe's System
One model. It never sees the screen and never writes a word. At every step the page of a small
made-up travel site is written out as text: the task, the page, and every element that can be
acted on. Jev answers in **one call**:

| question | type | what it drives |
|---|---|---|
| `action` | choice, a new option list every step | the ONE element to act on next |
| `done` | noul (yes/no) | is the task already complete |
| `obstacle` | noul (yes/no) | is something covering the page |

Clicking an input fills it with the right value from the task. In the fast browser agents people
built with Jev, a small text model wakes up only to type. Here a plain lookup plays that part.

The pane shows the site in a browser window with a cursor that flies to each chosen element, rings
on the page showing the probability Jev gave the top candidates, the exact text Jev reads, a timer,
and a live panel with decisions per second, latency, tokens and cost. Every booking is checked
against the task: the right flight, the right passenger, the right bags, no extras.

This is a harness for OpenHarness. The agent on the right edits `site.json`. The viewer on the left
runs the site and asks Jev for every step.

## Play with it

- **Click anything on the page yourself.** Your click is a real step. Jev has to deal with what
  you did.
- **Throw a pop-up** at it mid-task.
- **Distraction** and **Step** sliders change the dial and the pace live.
- **Show Jev's mind** toggles the probability rings. **Pause** then **Step** holds each page for a
  moment so you can read the rings before the cursor moves.
- Next task, Pause, Step, Reset.

## The honest dial

`distraction` (0 to 1) adds cookie walls, pop-ups, decoy buttons, upsells and **layout shifts**. A
layout shift lands between reading the page and clicking it: a pop-up opens, or a sponsored row
pushes the results down, and the click goes to the old spot and hits whatever is there now. That is
how real web pages break real agents. Nothing else is random.

Measured with the offline stand-in over 300 bookings at each level:

| `distraction` | bookings exactly right | steps per booking | clicks lost per booking |
|---|---|---|---|
| 0.00 | 100% | 10.0 | 0.0 |
| 0.25 (default) | 94% | 11.5 | 0.7 |
| 0.50 | 92% | 13.2 | 1.5 |
| 0.75 | 85% | 14.9 | 2.2 |
| 1.00 | 81% | 17.2 | 3.3 |

## Anatomy

```
jev-browser/
  harness.json               # DSH manifest (engine: claude)
  AGENTS.md                  # tells the agent how to write tasks and what to report
  skills/browser/SKILL.md    # the task-writing and verification craft
  template/site.json         # the starter tasks and dials
  toolchain/
    jev.mjs                  # the Jev client (real TypeSafe API, or an offline stand-in)
    check.mjs                # validates site.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs               # loopback server + the step loop
    sim.mjs                  # the site: pages, elements with rectangles, layout shifts, scoring
    mock.mjs                 # the offline stand-in (reads only the page text)
    kit.mjs                  # loopback-only HTTP/SSE server helpers
    studio.js                # the browser window, the cursor, the rings
    jev-hud.js               # the "Jev live mind" panel
  test/viewer.test.mjs
```

## Jev, honestly

With `TYPESAFE_API_KEY` set, every step is a real call to `POST /v1/systemone`. Without a key the
harness runs on a deterministic local stand-in that reads the same page text and answers the same
questions, so the demo works offline. The pane badges that mode `MOCK`. The stand-in exercises the
plumbing. It is not Jev's judgement.

The site, the flights, the prices and the people are made up. Nothing is booked anywhere and no real
website is touched. The times shown are this demo's pace, not a benchmark of any product.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- The idea of a decision model choosing the next browser action from the page's elements comes from
  the open-source browser agents the community built around Jev. This harness is an independent,
  from-scratch demo on a synthetic site and uses none of their code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- Built by Autonomous for the OpenHarness store.
