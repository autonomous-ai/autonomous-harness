# Engine marks

Third-party product marks, vendored so the README renders without a runtime network dependency. They
identify which agents Harness works with — nominative use, no endorsement implied or claimed.

**Do not recolor or redraw these.** If a mark is wrong or its owner wants it changed or removed, open
an issue and it comes out.

## These are normalised display copies

Upstream files range from 104×104 to 1024×1024, so at one `height=` they rendered at wildly different
visual sizes. Each file here is trimmed of fully transparent margin, scaled so its longest side is
448px, and centred on a 512×512 transparent canvas. Aspect ratio and colour are untouched; only the
canvas and the scale changed. 512 is ≥2× the 72px the README renders them at, so they stay sharp on
a retina display.

**The SHA-256 column is the *upstream* file each was derived from, not the file in this directory.**

| File | Upstream source | Source px | Upstream SHA-256 |
|---|---|---|---|
| `claude.png` | Claude's official app icon — <https://claude.ai/apple-touch-icon.png>, fetched 2026-08-06 | 180 | `dcc58271920750441afd420268045addb593ee01e68b4e05a13f7eface7e65d3` |
| `hermes.png` | Hermes Agent's official app icon, `NousResearch/hermes-agent` `apps/desktop/assets/icon.png` @ `main`, fetched 2026-08-06 | 1024 | `d60d164e24fdcf6532133b8ea43c77a201e4b9e9dbc396187b58d51d8590ef52` |
| `commandcode.png` | Command Code's official ⌘ mark — <https://commandcode.ai/apple-touch-icon.png>, fetched 2026-08-06 | 180 | `f3a50e2d93b0a50b937cf47f1a98c01274cc8bb660eef7a7e10b6a77fd9af771` |
| `devin.png` | Cognition's official mark — the `CognitionAI` GitHub organisation avatar at `?size=512`, fetched 2026-08-06 | 460 | `41a5f292dae99b5046e69bcfe8808b00376daf9b62c68b53e8fa975b75be1f1d` |
| `cursor.png` | Cursor's official `CUBE_2D_DARK.svg`, <https://cursor.com/brand>, rendered to transparent PNG | 532 | `2e9f8c157ce6ef7a57c2c6ac451033035779ab07b142b7313ec5d301f5489802` |
| `opencode.png` | OpenCode's transparent dark-background square mark, pinned from `anomalyco/opencode` commit `e3471526f4c71b2c4ee00117e125e179da01e6e2` | 600 | `44d24a1c9e7e2af1f6551bd808b1330e2493e233a173c5930b300b70290e1b57` |
| `pi.png` | An 800×800 PNG rendering of Pi's official compact badge, <https://pi.dev/favicon.svg> | 800 | `b158ff280646a073c163e8cfc71b85cec40b6f89e7a47dd99a5b7838eb86081c` |
| `codex.png` | The transparent Codex product mark bundled as `codex-app-ga-logo--UgmJjKM.png` in the official `com.openai.codex` macOS app v`26.602.30954` | 104 | `8e82b26c98a10e45798ce48124515720657f7735fb8d0853b3f087eaa8a6b74e` |
| `muse.png` | The Meta mark from the official lockup SVG at `static.xx.fbcdn.net/rsrc.php/y3/r/y6QsbGgc866.svg` — wordmark paths dropped, glyph rasterised to 104×104, gradient kept | 104 | `d7c4568f992e60f6d42a7a819a5a782d479cbfd9ad2bc11e69c82b35b8a5d8fe` |
| `amp.png` | Amp's official app icon — the `apple-touch-icon` the site itself declares, <https://ampcode.com/app-icon.png?v=3>, fetched 2026-08-07 | 512 | `e5fc0d1178674b80c0dcbbf9811787b44df91f865fac9cd3ef44bb13ef728018` |
| `kilo.png` | Kilo's official mark SVG, <https://kilo.ai/favicon/favicon.svg?v=2>, rendered to a 512px PNG — see the note below | 512 | `03a348a04c622938a278d803cbb6333819de855d2b3127de8e412fd261db3701` |
| `grok.png` | SpaceXAI symbol, the WHITE transparent variant, <https://media.x.ai/v1/website/spacexai-symbol-white-transparent-0c31957f.png>, fetched 2026-08-19 — composited on a black tile, see the note below | 600 | `56357e60b43284734c58e06596be038c58d7fd1a9bea7325d21a107a44ea4b47` |
| `copilot.png` | GitHub's official Copilot octicon, <https://raw.githubusercontent.com/primer/octicons/main/icons/copilot-48.svg>, fetched 2026-08-19 — rendered white, see the note below | 48 (SVG) | `d94b7a94a4c23816b02285f53eca6386429b67522271483fa0f18ab3596617dc` |
| `agy.png` | Antigravity's official gradient "A" mark — the logo the site itself declares, <https://antigravity.google/assets/image/antigravity-logo.png>, fetched 2026-08-18 | 200 | `8f0b95d2d21dbf930b4d100e2fdc4505673e900a731aa56ea633a4b59c312799` |

Open items, recorded rather than left implicit:

- **`copilot.png` is a monochrome icon, not a logo, and it needs the same tile Grok needed.** GitHub
  publishes the Copilot mark as an octicon whose paths inherit `currentColor`, so it ships with no
  colour at all. It is rendered at `fill="#ffffff"` — a choice of ink for a shape that has none, the
  same call Kilo's `oklch()` rewrite documents, not a recolour of a coloured mark — and then
  composited onto the 448px black tile, because white on transparent is INVISIBLE on the light theme.
  It shipped without the tile first and the row showed an empty gap; the check below now exists so the
  next one is caught before a person has to notice it. Being an SVG it rasterises at any size, so this
  one has no resolution caveat.

- **Check contrast on BOTH grounds before adding a mark.** A mark that is mostly transparent with
  near-white ink vanishes on the light theme, which is how this README is most often read from a
  browser that is not signed in. Run this over the directory:

  ```python
  # flags any mark that is >40% transparent with ink brighter than rgb(200,200,200)
  from PIL import Image; from collections import Counter; import glob
  for f in sorted(glob.glob('*.png')):
      im = Image.open(f).convert('RGBA'); c = Counter(); tr = 0
      for px in im.getdata():
          if px[3] < 20: tr += 1
          elif px[3] > 200: c[px[:3]] += 1
      trp, ink = tr * 100 // (im.width * im.height), c.most_common(1)[0][0]
      if trp > 40 and sum(ink) / 3 > 200: print(f, trp, ink)
  ```

  As of 2026-08-19 it flags `cursor.png` (63% transparent, ink `(237,236,236)`) and `opencode.png`
  (44%, `(241,236,236)`). Neither is invisible — both still read on a white page, just faintly — so
  they are recorded here rather than changed: giving a vendor's mark a ground it did not ship with is
  a decision, and it was only forced for Grok and Copilot, where the mark disappeared outright.
- **`agy.png` is a 200px source.** Antigravity publishes the bare mark only at 200×184; the 512px
  `icon.icns` inside the macOS app is an app TILE (a white rounded square with a small glyph),
  not the same class of asset as the marks here. The site logo was taken and recorded rather
  than swapped for the tile or upscaled to look bigger than it is.
- **`codex.png` and `muse.png` are still 104px sources** — fine at the 72px render, slightly soft on
  a retina display. Everything above them is 180px or better. Replace when a larger official file
  turns up; do not upscale these to fake it.
- **`muse.png`** — Meta's brand terms route logo usage through their Brand Review. It was vendored
  for in-app engine identification on the project owner's decision; a public README is a more visible
  use than an in-app badge, and that decision should be confirmed rather than inherited.
- **Light and dark themes.** Several marks are opaque tiles (Claude orange, Command Code and Pi
  black, OpenCode and Hermes white, Amp dark green) and a few are transparent glyphs. GitHub renders
  this README on both grounds; the glyphs are the ones to re-check if a theme change makes one
  disappear.

- **`grok.png` is the one mark given a ground it did not ship with.** xAI publishes the SpaceXAI
  symbol as a transparent glyph in black and in white, and neither survives both GitHub themes on its
  own: the black one measured 87% transparent and vanished on the dark ground this README is most
  often read on. The WHITE variant — pixel-identical to the copy the web app vendors, which carries a
  different SHA-256 only because it was re-encoded — is composited unchanged onto
  a 448px black tile, the same tile shape `pi.png` and `commandcode.png` already use. The mark itself
  is untouched: not recoloured, not redrawn, only placed on a ground. If xAI would rather it stood
  alone, dropping the tile is a one-line change.
- **`amp.png` is the app icon, not the bare mark.** Amp publishes both: the `apple-touch-icon` used
  here, and a transparent single-colour glyph at `/amp-mark-color.svg` (all paths `#F34E3F`, so it
  would read on either ground). The app icon was taken because it is the same class of asset as
  `claude.png` and `commandcode.png` — the icon the site itself declares — not because the glyph is
  unusable. Swapping to the glyph is a one-line change if the transparent set is ever preferred.

- **`kilo.png` comes from the SVG, not from the PNG the site declares.** Every official Kilo raster
  (`apple-touch-icon`, `android-chrome-192`, `android-chrome-512`) is a near-black glyph on a
  transparent background — measured 41% fully transparent, dominant opaque colour `(35,31,32)` — which
  is close to invisible on a dark ground and is not the yellow tile Kilo's artwork actually describes.
  The SVG holds the whole design: `<rect fill="oklch(95% 0.15 108)"/>` behind `<g fill="#000000">`.
  One token is rewritten before rasterising — `oklch(95% 0.15 108)` → `#f8f676` — because librsvg 2.60
  does not implement `oklch()` and renders the tile black without it. That is a notation change, not a
  recolour: the colour is inside sRGB (no channel clamped), so the hex is exactly the declared colour.
