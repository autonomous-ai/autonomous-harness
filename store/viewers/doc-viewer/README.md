# Doc Viewer, a Harness viewer package

The pane for documents in [Harness](https://github.com/autonomous-ai/autonomous-harness): the PDF a
harness is writing, redrawn on every save. A harness points at it with

```json
"viewer": { "use": "autonomous/doc-viewer" }
```

and names the PDF in its verdict's `artifact` (or lets the newest `.pdf` under the workspace win).
Typst uses it; Anthropic's docx, pptx and xlsx skills can, through LibreOffice-to-PDF.

One Node file, one dependency: `viewer.mjs` serves the workspace on the loopback port Harness
hands it, renders every page with Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/) (installed
into this package by `setup.sh`, never a CDN) — scroll, zoom, page count — and pushes a reload over
server-sent events when the file changes, keeping the scroll position.

```sh
harness dsh check .           # conformance
harness dsh install . --link  # this checkout as the installed viewer
```

pdf.js is Mozilla's, Apache-2.0 (`LICENSE-pdfjs`). The wrapper is MIT, Autonomous.
