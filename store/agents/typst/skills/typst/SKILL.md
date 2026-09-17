---
name: typst
description: Write documents in Typst — papers, spec sheets, reports, letters, slides — compile them to PDF with the pinned typst binary, read its diagnostics, and keep the pane current. Use for any request that ends in a PDF or a printed page.
---

# typst

Typst is a markup-based typesetting system: Markdown-like text with a real scripting layer
(`#let`, functions, `#table`, `#figure`, `#math`), compiled to PDF in milliseconds. The compiler is
`$TYPST` (pinned; `$TYPST --version`). Never install another.

## Compile, always through the verdict

```bash
python3 "$TYPST_TOOLCHAIN/verdict.py"            # main.typ → out/main.pdf, verdict, diagnostics
python3 "$TYPST_TOOLCHAIN/verdict.py" paper.typ  # another file → out/paper.pdf
$TYPST compile --root . main.typ out/main.pdf     # the raw compiler, when you need its flags
$TYPST watch --root . main.typ out/main.pdf       # recompile on save (run in the background)
```

The verdict is what the pane header shows. Typst's own errors and warnings come back with
`file:line:col`; fix errors first, then warnings.

## The language, the parts that matter

- **Text and structure**: `= Heading`, `== Sub`, `*bold*`, `_italic_`, `- list`, `+ numbered`, `#link()`.
- **Set rules** at the top: `#set page(paper: "a4", margin: 2cm)`, `#set text(font: "…", size: 11pt)`,
  `#set heading(numbering: "1.")`, `#set par(justify: true)`.
- **Tables**: `#table(columns: (auto, 1fr, auto), align: (left, left, right), table.header([*A*], …), …)`.
- **Figures**: `#figure(image("assets/plot.png", width: 80%), caption: [What it shows]) <fig-plot>` and
  `@fig-plot` to reference it.
- **Math**: `$x^2 + y^2 = z^2$` inline, `$ E = m c^2 $` on its own line; `#math.equation(numbering: "(1)")`.
- **Code**: fenced ```` ```py ```` blocks are highlighted.
- **Variables and functions**: `#let price = 12.5`, `#let row(name, qty) = [#name — #qty]`.
- **Slides**: `#set page(paper: "presentation-16-9")` and `#pagebreak()` between slides.
- **Bibliography**: `#bibliography("refs.bib")` with `@key` citations.

## Rules

- Images and data live under `assets/`, referenced relatively; a missing image is a compile error.
- Fonts: name system fonts (`"Helvetica Neue"`, `"Georgia"`) or ship a `.ttf` under `fonts/` and pass
  `--font-path fonts`. Typst falls back silently if a font is missing — check the PDF.
- One document per `.typ` at the workspace root; shared pieces go in `lib/*.typ` and are `#import`ed.
- Save early: the first compile within a minute, then refine. The pane redraws on every save.
