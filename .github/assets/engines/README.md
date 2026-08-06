# Engine marks

Third-party product marks, vendored so the README renders without a runtime network dependency. They
identify which agents Harness works with — nominative use, no endorsement implied or claimed.

**Do not recolor or redraw these.** If a mark is wrong or its owner wants it changed or removed, open
an issue and it comes out.

| File | Source | SHA-256 |
|---|---|---|
| `cursor.png` | Cursor's official `CUBE_2D_DARK.svg`, <https://cursor.com/brand>, rendered to transparent PNG | `2e9f8c157ce6ef7a57c2c6ac451033035779ab07b142b7313ec5d301f5489802` |
| `codex.png` | The transparent Codex product mark bundled as `codex-app-ga-logo--UgmJjKM.png` in the official `com.openai.codex` macOS app v`26.602.30954` | `8e82b26c98a10e45798ce48124515720657f7735fb8d0853b3f087eaa8a6b74e` |
| `opencode.png` | OpenCode's transparent dark-background square mark, pinned from `anomalyco/opencode` commit `e3471526f4c71b2c4ee00117e125e179da01e6e2` | `44d24a1c9e7e2af1f6551bd808b1330e2493e233a173c5930b300b70290e1b57` |
| `pi.png` | An 800×800 PNG rendering of Pi's official compact badge, <https://pi.dev/favicon.svg> | `b158ff280646a073c163e8cfc71b85cec40b6f89e7a47dd99a5b7838eb86081c` |
| `hermes.png` | Hermes Agent's official 32×32 favicon, pinned from `NousResearch/hermes-agent` commit `d71033a4077a6dfdcdb42c9e9eeab4c41e4a7012` | `0cad9cd8f57639ffd60fe1ff2e6cb722bca4fc1bf8e9137068dba4b2f3abc989` |
| `commandcode.png` | Command Code's official ⌘ mark — the 48×48 RGBA frame of <https://commandcode.ai/favicon.ico>, downloaded 2026-07-28 | `0c81f1fea24a52e38e12cba2b4a79563a251124414ab8ef065eee8f02480e554` |
| `devin.png` | Devin's official mark — the 48×48 RGBA frame of <https://devin.ai/favicon.ico>, downloaded 2026-07-28 | `553815811d5fa3586672b2ba2f04d61de49bec786d7f71ad4ba5d011aae825ca` |
| `muse.png` | The Meta mark from the official lockup SVG at `static.xx.fbcdn.net/rsrc.php/y3/r/y6QsbGgc866.svg` — wordmark paths dropped, glyph rasterised to 104×104, gradient kept | `d7c4568f992e60f6d42a7a819a5a782d479cbfd9ad2bc11e69c82b35b8a5d8fe` |
| `claude.png` | Anthropic's Claude mark. **Provenance not recorded upstream** — copied from `autonomous-code` `apps/orangepi/web/public/assets/engine-icons/claude.png` | `e5e9580efbb048a1…` (see `shasum -a 256`) |

Two open items, recorded rather than left implicit:

- **`muse.png`** — Meta's brand terms route logo usage through their Brand Review. It was vendored
  for in-app engine identification on the project owner's decision; a public README is a more visible
  use than an in-app badge, and that decision should be confirmed rather than inherited.
- **`claude.png`** — the only mark here with no upstream source line. It needs one, pulled from
  Anthropic's brand page, before this table can claim to be complete.

Copies of the same files live in `autonomous-code` at `apps/web/public/engine-icons/` and
`apps/orangepi/web/public/assets/engine-icons/`, where a script converts them to the 20×20 LVGL
ARGB8888 maps the device uses. Change them together.
