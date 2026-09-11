# Environment Setup Missing-Only UI — Design QA

## Evidence

- Source visual truth:
  - `/var/folders/ct/7rts83zj1fbc0tsh73wpt4_80000gp/T/codex-clipboard-2hdxTE.png`
  - `/var/folders/ct/7rts83zj1fbc0tsh73wpt4_80000gp/T/codex-clipboard-rSVFNm.png`
  - User-approved direction: Step 2 keeps only the readiness checklist; Step 3 lists only dependencies that are still missing.
- Implementation screenshots:
  - `/tmp/harness-env-step2-missing-only.png`
  - `/tmp/harness-env-step3-missing-only.png`
- Side-by-side comparisons:
  - `/tmp/harness-env-step2-comparison.png`
  - `/tmp/harness-env-step3-comparison.png`
- Source pixels: `1712 x 1452` (Step 2), `1664 x 1398` (Step 3).
- Implementation pixels and CSS viewport: `1600 x 1200`, device pixel ratio `1.0`.
- Comparison normalization: both sides scaled to `800px` width and top-aligned on a `800 x 700` canvas.
- State: macOS dark theme; system tools, Harness CLI, and Grid CLI ready; Homebrew and tmux missing.

## Findings

- No actionable P0, P1, or P2 findings.
- Step 2 preserves the existing hierarchy, checklist grouping, status colors, sidebar, and footer while removing the redundant numbered installation plan.
- Step 3 preserves the existing mode selector and warning treatment while reducing the install plan to the two missing dependencies. Ready Apple tools, Harness CLI, and Grid CLI are not shown.
- Automatic and Manual modes derive their rows and commands from the same missing-item model, avoiding mismatched instructions.

## Required Fidelity Surfaces

- Fonts and typography: existing application text styles, weights, line heights, wrapping, and hierarchy are preserved. The Flutter golden-test renderer uses block glyphs in the captured artifact, so textual correctness is additionally covered by widget assertions.
- Spacing and layout rhythm: card width, padding, row rhythm, sidebar proportions, footer position, radii, and borders remain aligned with the existing setup flow. Removing redundant content creates the intended shorter Step 2 and Step 3 layouts without overflow.
- Colors and visual tokens: existing dark surfaces, blue accent, semantic green/red states, amber terminal notice, borders, and muted text tokens are reused.
- Image quality and asset fidelity: the screen contains no raster illustration or product-image assets; existing Material icons remain unchanged.
- Copy and content: Step 2 now says ready items stay untouched. Step 3 states the exact missing count, shows only missing items, and treats final verification as a short hint instead of an install step.

## Focused Comparison

No additional crop was needed: the complete checklist, missing-only plan, mode selector, warning, verification hint, and footer CTA are all visible and distinguishable in the full-view comparisons. Widget tests verify exact labels and command visibility where golden-test font rasterization is not readable.

## Comparison History

- Initial source finding: Step 2 repeated every dependency in a numbered plan after already showing the complete readiness checklist; Step 3 repeated ready dependencies and their commands.
- Fix: removed the Step 2 plan, introduced readiness metadata for Homebrew/tmux/Linux packages, and generated Automatic/Manual Step 3 content only from missing dependencies.
- Post-fix evidence: Step 2 ends after the checklist and notice; Step 3 contains only Homebrew and tmux for the captured state. No actionable visual mismatch remains.

## Implementation Checklist

- [x] Remove redundant Step 2 numbered plan.
- [x] Show only missing dependencies in Automatic mode.
- [x] Show only missing commands in Manual mode.
- [x] Hide the admin-terminal notice when no missing item needs Terminal.
- [x] Keep final verification as a non-numbered hint.
- [x] Verify missing-only behavior with widget tests.

## Follow-up Polish

- None required for this scope.

final result: passed
