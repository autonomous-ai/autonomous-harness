# Third-party notices

The Doc Viewer vendors nothing into the repository. `setup.sh` installs one npm package into
`node_modules/` from the lockfile, and the server serves its files to the pane unmodified.

## pdfjs-dist 6.3.289

[PDF.js](https://github.com/mozilla/pdf.js), Mozilla Foundation. Apache License 2.0 (`LICENSE-pdfjs`,
and `node_modules/pdfjs-dist/LICENSE`). Used: `build/` and `legacy/build/` (the library and its
worker), `web/` and `legacy/web/` (the viewer components and their stylesheet).

Resources shipped inside the same package, served on demand when a PDF needs them, each under its
own licence file in `node_modules/pdfjs-dist/`:

| Folder | What | Licence |
|---|---|---|
| `cmaps/` | Adobe CMap resources (CJK text) | BSD-3-Clause, Adobe Systems (`cmaps/LICENSE`) |
| `standard_fonts/` | Foxit fonts, for the 14 standard PDF fonts when a PDF does not embed them | BSD-style, PDFium Authors (`LICENSE_FOXIT`) |
| `standard_fonts/` | Liberation Sans | Liberation Font License: GPLv2 with the font exception (`LICENSE_LIBERATION`) |
| `wasm/` | OpenJPEG, JBIG2 (PDFium) and qcms decoders | BSD-2-Clause, BSD-style, MIT (`LICENSE_*`) |
| `iccs/` | a CMYK ICC profile | CC0 1.0 (`iccs/LICENSE`) |

The fonts are only ever handed to pdf.js inside the pane on this machine, to draw a PDF that asked
for them.
