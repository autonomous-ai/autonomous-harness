# Third-party notices

**CAD Viewer** — part of `cadgen`, from [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad).
MIT License, copyright 2026 Thompson Labs LLC (Jake Fitzgerald, earthtojake). Not vendored: installed from PyPI by `setup.sh` at the version
in `CADGEN_VERSION`, and run unmodified. The upstream license text is in `LICENSE-cadgen`.

**What the pane changes.** Nothing in the installed package. `pane_client.py` copies the bundled
client (`cadgen/_runtime/viewer`) next to this file and adds one line to the copy's `index.html`, a
`Content-Security-Policy` meta tag (`connect-src 'self' blob: data:`) so the page makes no requests
off loopback; `viewer.sh` serves that copy with cadgen's `--dist` option. Every script, stylesheet
and asset in it is the release's own.
