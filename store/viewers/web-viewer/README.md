# Web Viewer

A small, shared viewer for static HTML projects. It serves the workspace over loopback and reloads
the preview when files change. Node.js 20+ is its only dependency.

Declare it in a harness's `harness.json`:

```json
"viewer": { "use": "autonomous/web-viewer" }
```

The default page is `index.html`. To preview another page, override the URL:

```json
"viewer": {
  "use": "autonomous/web-viewer",
  "url": "http://127.0.0.1:${port}/?file=pages/demo.html"
}
```

OpenHarness installs the viewer with the harness and reuses an existing installation. For a source
checkout before the viewer is in a released registry, link this folder first:

```bash
harness dsh check store/viewers/web-viewer
harness dsh install "$PWD/store/viewers/web-viewer" --link
```

The [Hello World harness](../../examples/hello-world/) is a complete example. Its workspace contains
plain HTML; no bundler or application server is needed. Embedded previews currently require macOS.

## Development

```bash
node --test store/viewers/web-viewer/test/*.test.mjs
HARNESS_WORKSPACE=/absolute/path/to/project HARNESS_VIEWER_PORT=4310 node store/viewers/web-viewer/viewer.mjs
```

HTML, CSS, images, JavaScript modules, sibling `fetch()` requests and `localStorage` work in the
preview. The iframe enables scripts, same-origin access, forms, pointer lock and downloads, so
interactive workspace apps behave like local apps. This is a **trusted workspace preview**:
`allow-scripts` plus `allow-same-origin` is not a security boundary from the shell. Preview only
workspace code you intend to run. Absolute asset paths should use `/files/`; relative paths work.

The shell preserves artifact query parameters (including `seed`) when files change. It offers
manual reload, pause/resume of automatic reloads, phone/tablet widths and open-in-new-tab. Missing
files recover when created, failed requests are visible, and the live connection status is explicit.

An artifact can post `{ type: 'harness:state', seed }` to its parent when its seed changes; the shell
preserves it in the URL and subsequent reloads. `{ type: 'harness:error', message }` adds a visible
error report. The seven interactive starters use this small protocol; other HTML apps need no
integration. See the [browser test guide](../../tools/experience-tests/README.md) for sibling-fetch,
storage, module, control and export regressions.

The server is read-only, bound to `127.0.0.1`, and rejects paths and symlinks outside the workspace.
Dotfiles and `node_modules` are not served or watched for reloads. Individual files are limited to
32 MiB. This is a local preview, not a production web server.

## Credit and stewardship

Built for OpenHarness by its contributors. MIT; no third-party runtime packages.
