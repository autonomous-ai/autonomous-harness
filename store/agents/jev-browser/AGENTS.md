# Jev Browser in OpenHarness

On the left is a small made-up travel site inside a browser window, and **Jev operates it by
itself**. Jev is TypeSafe's System One model. It never sees the screen. Each step the page is written
out as text and Jev picks ONE element out of the list, a new list every step. A booking takes a few
seconds. Every booking is checked against its task.

On the right, you edit `site.json`. This is the ONLY file you edit. The viewer watches it and starts
again from the first task the moment you save.

## The site file

```jsonc
{
  "title": "Jev Browser",
  "description": "One line about this run.",
  "site": "SkyHop",              // the made-up site's name, shown in the tab and the URL
  "stepMs": 170,                 // one Jev decision per step. 40 to 2000.
  "distraction": 0.25,           // 0 to 1. Cookie walls, pop-ups, decoys, layout shifts. THE DIAL.
  "flights": 7,                  // result rows per search. 4 to 9.
  "maxSteps": 45,                // a task fails if it takes more steps. 12 to 200.
  "seed": 11,
  "style": "How Jev should work, in plain words. It is the first line of the text Jev reads.",
  "tasks": [                     // 1 to 40 bookings, run in order, then again with new flights
    { "from": "SFO", "to": "JFK", "day": "Friday", "pick": "cheapest", "nonstop": true,
      "name": "Ada Park", "email": "ada@example.com", "bags": 1 }
  ]
}
```

`pick` is `cheapest`, `earliest` or `latest`. `bags` is 0 to 3. Airport codes are up to 4 letters.
Names and emails are made up. Use `example.com` addresses.

## Your job

Write bookings that are fun to watch, then find out where Jev breaks.

- **Write the tasks.** Mix the three `pick` rules, nonstop and not, and different bag counts, so
  the right flight is a different row each time and the passenger page needs different clicks.
- **Set the dial.** At `distraction` 0 every booking should come out exactly right in about ten
  steps. Raise it and clicks start landing in the wrong place because the page moved between
  reading and clicking. The person can also move the slider in the pane.
- **Set the pace.** `stepMs` near 170 looks like a fast agent. 800 or more lets a person read each
  step.
- **Write the style line.** With a real key, Jev reads it on every step.
- **Report what you see.** Read `.harness/verdict.json`: bookings done, the share that were exactly
  right, steps each, and clicks lost to layout shifts. It also lists the most recent wrong bookings
  and why they were wrong. Say at which distraction the share that is right drops below 9 in 10.

Do NOT just ship the template. Every run should have its own tasks and a dial you chose on purpose.

Validate with `node "$JEV_DSH/toolchain/check.mjs"`.

## Rules

- Edit only `site.json`. Keep it valid JSON. A bad edit does not crash the demo. The pane shows the
  error and keeps running on the last good settings.
- Never edit `.harness/verdict.json`. The viewer writes it.
- The viewer is already running in the left pane. Never propose opening a browser, changing ports
  or running a second server. The "browser" in this harness is a drawing inside the pane. It never
  loads a real website.
- You can ask Jev yourself through `toolchain/jev.mjs` (`evaluate`, and the `jev.choice`,
  `jev.noul`, `jev.score` builders), for example to see which element it picks on one page.
- Without `TYPESAFE_API_KEY` the harness runs on a deterministic offline stand-in, and the pane
  says `MOCK`. It is there so the demo runs anywhere. It is not Jev's judgement, so do not describe
  its results as Jev's.
- This is a demo. The site, flights, prices and people are made up. Nothing is really booked. Do not
  present the times as a benchmark of any product.

## Definition of done

- `site.json` parses and passes `toolchain/check.mjs`.
- The pane runs your tasks without an error banner.
- You told the person what dial you chose, how many bookings come out exactly right, how many steps
  they take, and where it starts to fail.
