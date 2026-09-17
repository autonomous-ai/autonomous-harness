"""The client the pane serves: cadgen's own bundled CAD Viewer client with one line added.

    .venv/bin/python pane_client.py        # prints the directory to pass as `cadgen viewer --dist`

The pane is a page inside Harness, beside an agent, on loopback. The bundled client, at start,
asks api.github.com whether a newer text-to-cad is out and, when one is, shows an "Update" button
that links to the release — a version the pane cannot install (the package pins cadgen in
CADGEN_VERSION, and the store moves it). So the pane serves a copy of the pinned client whose
index.html carries a Content-Security-Policy keeping the page's fetches on its own origin:
`connect-src 'self' blob: data:`. Nothing else is touched — every script, style and asset is the
release's own, byte for byte — and `--dist` is cadgen's own option for serving a client directory.

The copy is made once per cadgen version, next to this file (`.pane-client-<version>/`,
gitignored), atomically, so panes starting together do not trip over each other. If the bundled
client is missing or its index.html is not the shape expected, this prints nothing and the pane
serves the bundled client unchanged.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from importlib import metadata
from pathlib import Path

CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'self' blob: data:\" />"
ANCHOR = '<meta charset="UTF-8" />'


def pane_client(here: Path) -> Path | None:
    import cadgen

    bundled = Path(cadgen.__file__).resolve().parent / "_runtime" / "viewer"
    if not (bundled / "index.html").is_file():
        return None
    version = metadata.version("cadgen")
    dest = here / f".pane-client-{version}"
    if (dest / ".harness-pane").is_file():
        return dest
    html = (bundled / "index.html").read_text(encoding="utf-8")
    if ANCHOR not in html or "Content-Security-Policy" in html:
        return None
    tmp = Path(tempfile.mkdtemp(prefix=".pane-client-tmp-", dir=here))
    try:
        shutil.copytree(bundled, tmp, dirs_exist_ok=True)
        (tmp / "index.html").write_text(html.replace(ANCHOR, f"{ANCHOR}\n    {CSP}", 1), encoding="utf-8")
        (tmp / ".harness-pane").write_text(f"cadgen {version}\n", encoding="utf-8")
        os.rename(tmp, dest)
    except OSError:
        pass  # another pane made it first, or the directory is read-only: fall through
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
    return dest if (dest / ".harness-pane").is_file() else None


def main() -> int:
    try:
        path = pane_client(Path(__file__).resolve().parent)
    except Exception as error:  # the pane must start whatever happens here
        print(f"pane client: {error}", file=sys.stderr)
        path = None
    print(path or "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
