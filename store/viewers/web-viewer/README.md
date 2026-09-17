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

HTML, CSS, images, and classic JavaScript scripts are supported. The preview uses a sandboxed iframe
with scripts enabled but no same-origin access; it cannot read the viewer shell. Features requiring
a same-origin application, such as module imports, fetch, and local storage, need their own app
server/viewer. Absolute asset paths should use `/files/`; ordinary relative asset paths work directly.

The server is read-only, bound to `127.0.0.1`, and rejects paths and symlinks outside the workspace.
Dotfiles and `node_modules` are not served or watched for reloads. Individual files are limited to
32 MiB. This is a local preview, not a production web server.

## Credit and stewardship

Built for OpenHarness by its contributors. MIT; no third-party runtime packages.
