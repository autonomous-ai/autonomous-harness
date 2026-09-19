# Jev Shopper

**Jev, TypeSafe's System One model, is the buyer in a made-up shop.** A few products stream prices.
On every tick Jev reads the whole board and answers two typed questions in one call: which product
is the best buy right now (with a probability for every product), and whether the signal is strong
enough to spend. When Jev says spend and its pick is far enough under its usual price, an order goes
in. It lands one tick later, at the price it finds then.

**The shop, the products and the prices are made up. The money is paper.** This is a demo of a fast
decision loop. It is not shopping advice and not trading advice.

This is a harness for OpenHarness. The agent on the right edits `shopper.json`. The viewer on the
left runs the shop and asks Jev for a call on every tick.

## The pane

- **The price board.** One card per product with a live price chart that scrolls at 60 frames a
  second. The dashed line is the product's usual price (its own average over the last 60 ticks). The
  dotted green line is the deal bar. The green area is money saved against the usual price.
- **The spotlight.** A lamp swings to the product Jev calls the best buy right now. Every other card
  gets a faint beam whose brightness is Jev's probability for it, so you see the runner-up too.
- **Jev's mind on every card.** A probability bar per product, from the same answer.
- **Purchase stamps.** When an order lands the card is stamped BOUGHT with the price paid and what it
  saved. Coins burst out of the card. Small marks along the bottom of a chart show when the spotlight
  was on that product.
- **The hidden fair price.** Each product has a fair price Jev cannot see: list price, a slow trend,
  and now and then a real sale. What Jev reads is that price plus noise. Tick "show the hidden fair
  price" to see both and judge Jev's calls yourself.
- **The top bar.** Decisions per second, saved against usual and cost so far, large. Also buys, the
  share of deal calls Jev got right, and the budget left.
- **The rail.** The shared "Jev live mind" panel, the exact text Jev reads, receipts, and how it
  works.

A round ends when the budget cannot buy anything more, or after 240 ticks. The result stays up for
about three seconds, then a new round starts with a new seed. The shop never stops.

## Things to try in the pane

- **Click a product** to start a flash sale on it: a deep price cut that lasts a few seconds. Watch
  the spotlight swing over and the order go in.
- **Budget** slider: more or less paper money for the round.
- **Price noise** slider: the honest difficulty dial. See below.
- **Speed** slider: ticks per second.
- **+ Add a product** puts another made-up product stream on the board (up to 8). The **×** on a
  card takes it off (down to 2).
- **Pause**, **Step** and **Reset**.

The sliders and the add and remove buttons override `shopper.json` while you play. The next edit to
`shopper.json`, or Reset, puts the file back in charge.

## The difficulty dial, measured

`vol` is price noise: a fresh random wobble on every tick, on top of the hidden fair price. A real
sale stays for a while. A wobble is gone one tick later, and an order lands one tick after the call,
so buying a wobble saves nothing. The more noise, the harder it is to tell a deal from a wobble.
Nothing random is added to Jev's decision. Measured on the offline stand-in over 1,500 ticks, two
seeds:

| `vol` | deal calls right | buys saved against the usual price |
|---|---|---|
| 0.01 | 100% | 16.2% |
| 0.03 (template) | 97 to 98% | 15.8 to 16.1% |
| 0.08 | 76 to 89% | 10.3 to 11.8% |
| 0.15 | 51 to 55% | 2.6 to 3.6% |
| 0.30 | 48 to 57% | 2.5 to 4.8% |

"Deal calls right" only counts ticks when a real sale of 5% or more was on, and asks whether Jev's
pick was the truly cheapest product against its usual price. The test suite proves the dial.

## Anatomy

```
jev-shopper/
  harness.json              # manifest (engine: claude)
  AGENTS.md                 # tells the agent how to shape shopper.json
  skills/shopper/SKILL.md   # shop design and how to check it
  template/shopper.json     # a starter shop
  toolchain/
    jev.mjs                 # the Jev client (real TypeSafe API, or a deterministic offline stand-in)
    check.mjs               # validates shopper.json
    viewer.sh setup.sh doctor.sh init-workspace.sh
  viewer/
    viewer.mjs              # loopback server, the shopping loop, the controls, the verdict
    sim.mjs                 # the made-up shop: fair prices, sales, noise (seeded, no I/O)
    index.html studio.js studio.css base.css jev-hud.js
  test/viewer.test.mjs
```

## `shopper.json`

| key | range | meaning |
|---|---|---|
| `title`, `description` | text | shown in the pane |
| `products[]` | 2 to 8 | `name`, list `price`, and an optional `drift` (-0.05 to 0.05 per tick) |
| `vol` | 0 to 0.5 | price noise per tick. The difficulty dial |
| `tickMs` | 60 to 5000 | milliseconds per tick, one Jev call per tick |
| `cash` | 1 and up | the paper budget for a round |
| `minDeal` | 0.01 to 0.4 | how far under its usual price a product must be before Jev may buy |
| `seed` | 0 and up | makes the shop repeatable |
| `style` | text | Jev's brief. It is part of the text Jev reads |

A bad JSON edit never stops the shop. It keeps running on the last good file and shows the error.

## Jev, honestly

The viewer calls `POST /v1/systemone` when `TYPESAFE_API_KEY` is set. Without a key it uses the
deterministic offline stand-in in `toolchain/jev.mjs`, and the pane shows a MOCK badge. The stand-in
reads only the text Jev would read: each product's price now, how far that is from its own average,
and its last six prices. It never sees the hidden fair price. It is there to prove the plumbing, not
to stand for Jev's judgement. Cost in the pane is what live Jev would charge for the same tokens.

The controls: `POST /control` with `pause`, `start`, `reset`, `tick` (`{"n": 500}` runs 500 ticks
at once, tests use it so they never wait), `flash` (`name`), `add`, `remove` (`name`), and `set`
(`key`: `vol`, `cash`, `tickMs` or `minDeal`). The server only answers on loopback.

## Credit and stewardship

- **Jev** is the work of **TypeSafe AI** (typesafe.ai). This harness is an OpenHarness wrapper that
  only calls the public API. It contains no TypeSafe code.
- **OpenHarness** (Autonomous) is MIT-licensed. This wrapper is MIT too (see `LICENSE`).
- Built by Autonomous for the OpenHarness store.
