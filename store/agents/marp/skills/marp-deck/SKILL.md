---
name: marp-deck
description: Write a keynote-grade slide deck in Marp Markdown (deck.md) — the structure of a great talk, the copy rules, the two keynote themes and their slide classes, offline art (wallpapers, charts, device frames), the check, and the export.
---

# marp-deck

A deck here is a **keynote**: black or white, one idea per slide, type you can read from the back
of the room, and a picture whenever a picture says it better. This skill is the whole craft. Read
it once, then write.

## 1. The shape of a keynote

Every talk, whatever the subject, follows this arc. Use it as the outline; drop what the talk does
not need, never reorder what it keeps.

| # | Slide | Class | What it does |
|---|-------|-------|--------------|
| 1 | Opening | `hero` | The promise, in a sentence the audience will repeat. A wallpaper behind it. |
| 2 | The world today | `statement` | The problem, felt from the audience's seat. No product yet. |
| 3 | So we asked | `statement` | The question that led to the idea. Tension, not answer. |
| 4 | The idea | `section` | The answer, named. A wallpaper. This is the reveal. |
| 5 | Three pillars | `pillars` | What makes it work. Three names, three lines. Never four. |
| 6 | See it | `image` | The product, the prototype, the screen — full bleed or in a device frame. |
| 7 | The number | `number` | One figure, made human. "1,000 songs in your pocket", not "5 GB". |
| 8 | Proof | `chart` or `quote` | A chart from real numbers, or one voice who tried it. |
| 9 | Available | `closing` | When, where, how much. Plain. |
| 10 | One more thing | `omt` | Optional. Only if there is really one more thing. |
| 11 | Close | `hero` | The promise again, shorter. The wallpaper from slide 1. |

Ten slides for a ten-minute talk. A longer talk repeats 2–8 per act. A shorter one keeps 1, 4, 5,
7, 11. Section openers (`section`) mark each act.

## 2. Copy: write like the person on stage

- **The headline is the sentence you would say out loud.** Eight words or fewer. If it needs a
  comma, it is two slides.
- **Say what it does for someone, not what it is.** Benefit, then feature — if the feature is
  needed at all.
- **One idea per slide.** The check warns above 40 words; a keynote slide usually has fewer than
  15. Everything else goes in the speaker notes.
- **Numbers made human.** Convert to something a person can feel: time saved a day, songs in a
  pocket, cups of coffee. Round it. One number per slide.
- **Threes.** Three pillars, three reasons, three words. Not two, not five.
- **Verbs, plain words, no jargon.** No "leverage", "seamless", "robust", "solution". No
  adjectives that do not earn their place. No exclamation marks.
- **Tension, then release.** Problem, question, answer. The reveal slide is short; the audience
  finishes the sentence.
- **Speaker notes carry the argument** (`<!-- notes -->` under a slide). The slides carry the punch.
  Write the notes as spoken sentences, two to five per slide, so the presenter can read them cold.
- **Never a bulleted paragraph on a slide.** If a list is unavoidable, it is three lines of three
  to five words each. The themes render lists as a clean stack with hairlines, no bullets.

## 3. Design: two themes, one accent, nothing else

Front matter — pick one theme for the whole deck:

```markdown
---
marp: true
theme: keynote-dark      # or keynote-light. Never both in one deck.
paginate: true
---
```

- `keynote-dark` — black, white type. The keynote. Use it unless the talk is about paper, light,
  health, or the user asks for white.
- `keynote-light` — white, near-black type. Airy, daytime.

Rules the themes assume:

- **Huge type, generous space.** Headlines up to 132px. Do not shrink text to fit; cut words.
- **One image per slide at most.** Full bleed (`![bg](…)`) or centred (`![w:1000](…)`). No image
  next to a paragraph.
- **Art is generated, not found.** No clip art, no stock photos, no emoji, no icons. Wallpapers
  for hero/section/closing, charts for numbers, device frames for screens (section 4). A photo
  the user supplies goes full bleed or in a frame.
- **One accent colour per deck**, `#2997ff` by default (links, chart bars). Change it only with a
  reason, then keep it.
- **Consistency is the design.** Same overline style, same positions, same wallpaper palette
  through the deck. Pick a palette on slide 1 and stay with it.

### The slide classes

Set one per slide with a scoped directive on the slide's first line, then the content:

```markdown
<!-- _class: hero -->
![bg](assets/hero.svg)
# The best way to give a talk.
Now on every Mac.
```

| Class | Content | Notes |
|-------|---------|-------|
| `hero` | `![bg](…)` + `# headline` + one line | Centred, 132px, no page number. Slides 1 and 11. |
| `statement` | `# one sentence` (+ one quiet line) | Left, 92px, wraps at 14 characters wide. Problem, question. |
| `section` | `![bg](…)` + `# name` | An act opener or the reveal. |
| `pillars` | `#### overline` + `## headline` + a 3-column block (below) | Three names, three lines. |
| `image` | `![bg](…)` + one caption line | Full bleed. Caption bottom-left. |
| `number` | `# 3×` + one line | 300px gradient figure. The line says what it means. |
| `chart` | `## headline` + `![](assets/chart.svg)` | Centred, chart as wide as the slide. |
| `quote` | `> the words` + `— who` | 60px, curly quotes drawn for you. |
| `closing` | `# headline` + lines | Availability: when, where, price. |
| `omt` | `# One more thing.` | Then the next slide is the thing. |
| (none) | `#### overline` + `## headline` + text or a list | The plain slide. Use rarely. |

Pillars block:

```markdown
<!-- _class: pillars -->
#### What makes it work
## Three things.

<div class="columns">
<div>

### Fast
Opens before you sit down.

</div>
<div>

### Quiet
No fans. No noise. Ever.

</div>
<div>

### Yours
Every setting, on every device.

</div>
</div>
```

Blank lines inside the `<div>`s matter: they let Markdown render inside HTML. Keep them.

Other directives you may use: `<!-- _paginate: false -->` on a slide, `![bg right:40%](…)` for a
half-image slide, `![w:800](…)`/`![h:400](…)` for a sized inline image, `<!-- _color: … -->` only
on an image slide whose picture is light. Nothing else; no inline styles, no other HTML.

## 4. Art: `art.mjs`, offline, in seconds

Every deck gets art. All of it is generated into `assets/` from the toolchain, deterministic from a
seed, no network, no accounts:

```sh
# wallpapers: gradient light on black (or --light). Palettes: aurora sunset ocean graphite spectrum
node "$MARP_TOOLCHAIN/art.mjs" wallpaper -o assets/hero.svg --palette aurora --seed 7
node "$MARP_TOOLCHAIN/art.mjs" wallpaper -o assets/reveal.svg --palette aurora --seed 12

# a chart from the talk's real numbers: bar (default) or line, in the accent colour
node "$MARP_TOOLCHAIN/art.mjs" chart -o assets/growth.svg --data "2023:12,2024:31,2025:64" --label "Teams on it" --type bar

# a screenshot or photo in a device, on a wallpaper: phone (default), laptop, window
node "$MARP_TOOLCHAIN/art.mjs" frame -o assets/demo.svg --image assets/screen.png --kind laptop --palette ocean
```

- Same palette across the deck; vary `--seed` so slides differ. Seeds 1–99 all look good.
- Charts only from numbers in the talk; never decorate. Four to six points, label the axis in
  words (`--label`). Add `--light` for `keynote-light`.
- Frames want a real image in `assets/` (PNG, JPG, WebP, SVG). Ask the user for the screenshot
  if the talk shows a product and none is there; use a wallpaper `image` slide until it arrives.
- Never reference an image that is not in the workspace. The check fails the deck.

## 5. The check

```sh
node "$MARP_TOOLCHAIN/check.mjs"            # deck.md
node "$MARP_TOOLCHAIN/check.mjs" other.md   # another file
```

Writes `.harness/verdict.json` (what the pane header shows) and prints every finding. Errors: the
deck does not render, a slide is empty, an image is missing. Warnings: over 40 words on a slide, no
image anywhere in the deck, no heading on the first slide, fewer than three slides, no `marp: true`.
Ready = no errors and at least three slides. Polish = no warnings either. The viewer runs the same
check on every save; run it yourself to read the list.

## 6. Export

```sh
"$MARP_TOOLCHAIN/node_modules/.bin/marp" deck.md --theme-set "$MARP_THEMES" --allow-local-files --no-stdin -o dist/deck.pdf
"$MARP_TOOLCHAIN/node_modules/.bin/marp" deck.md --theme-set "$MARP_THEMES" --allow-local-files --no-stdin -o dist/deck.pptx
"$MARP_TOOLCHAIN/node_modules/.bin/marp" deck.md --theme-set "$MARP_THEMES" --allow-local-files --no-stdin -o dist/deck.html
```

`--theme-set` is what makes the keynote themes real outside the viewer; without it the export falls
back to the default theme. PDF and PPTX render through a Chromium-family browser on the machine;
`toolchain/doctor.sh` says whether one is there. HTML needs nothing. `--no-stdin` matters in a tool
shell. Keynote (the app) opens the PPTX.
