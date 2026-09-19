---
name: browser
description: Write booking tasks and set the distraction dial for Jev Browser, then measure how many bookings come out exactly right and where layout shifts start to break it.
---

# Craft: Jev Browser runs

Jev Browser is a made-up travel site that Jev operates by itself, one picked element per step. You
shape the run in `site.json`. The craft is a set of tasks that exercise every page, and a dial that
shows the real limit: a click lands where the element WAS when the page was read.

## What Jev is asked, every step

One call, three questions, all answered from the same page text:

```
action    choice  one option per element on the page right now (a new list every step)
done      noul    "Is the task already complete?"
obstacle  noul    "Is something covering the page that must be closed first?"
```

The page text is what a person could see: the task, the page name and URL, whether an overlay
covers the page, the page's text, and every element that can be acted on with its label, its value
and, for a result row's Select button, that row's details. The pane shows this text live.

## The funnel

`search` (From, To, Day, then Search flights) → `results` (pick the one right Select) →
`details` (name, email, bags, no insurance, Continue) → `review` (no Flex upgrade, Confirm).
With no distraction a booking takes about ten steps.

The booking is right only if it is the exact flight the task describes (`cheapest`, `earliest` or
`latest`, nonstop when asked), with the right name, email and bag count, and no extras.

## The dial

`distraction` adds, in order of pain: decoy buttons and links, a cookie wall on the first page,
pop-ups that open between reading and clicking, and a sponsored row that pushes the results down so
a click lands on the row above the one Jev chose. That last one makes a wrong booking that only a
careful look at the next page can catch.

| feel | distraction |
|---|---|
| clean site, every booking right | 0 |
| a normal annoying site (default) | 0.25 |
| hostile | 0.6 |
| everything moves | 1 |

## Verifying

```bash
node "$JEV_DSH/toolchain/check.mjs"
```

Then watch the pane and read `.harness/verdict.json`: bookings, share exactly right, steps each,
clicks lost to layout shifts, and the latest wrong bookings with the reason. Report the dial you
chose and where the share that is right falls below 9 in 10. The pane's MOCK badge means the offline
stand-in is driving, not the real model. Say so when you report.
