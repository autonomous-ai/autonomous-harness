# Third-party notices

## CircuitJS1

- **Upstream** <https://github.com/pfalstad/circuitjs1> · **Home** <https://www.falstad.com/circuit/>
- **Authors** Paul Falstad (the original Java applet) and Iain Sharp (the GWT port), with the
  contributors named in the upstream README.
- **Licence** GNU General Public License, version 2 — the full text is in `LICENSE-circuitjs1`
  (upstream's `COPYING.txt`, copied unchanged).

### What this repository contains of it

- **The nine circuits in `skills/circuitjs/examples/`**, copied verbatim from upstream's
  `src/com/lushprojects/circuitjs1/public/circuits/` at commit
  `5bdb1296ce6a82f79515f4f1dd1b9a86e03236f7`. They are part of CircuitJS1 and remain under GPL-2.0.
  `skills/circuitjs/examples/README.md` says where each came from.
- **Nothing else.** No CircuitJS1 source and no compiled output is committed here.

### What `toolchain/setup.sh` fetches, and from where

At install time, into `upstream/` (gitignored), pinned in `VERSIONS`:

- The static files and GWT public resources, from the source tarball at the commit above.
- The compiled GWT module (`circuitjs1.nocache.js`, its `*.cache.js` permutations, and the
  `gwt/clean/` theme the module injects at startup) from
  <https://pfalstad.github.io/circuitjs1/>, which is the project's own CI build of its `dev` branch
  (`.github/workflows/deploy-pages.yml`) and the hosted development version the upstream README
  points people at. Upstream commits no compiled output and cuts no releases, and compiling GWT
  needs a JDK 8 and the GWT 2.8.2 SDK — not something to do during an install.

### What is changed

Nothing on disk. The pane serves `upstream/war/circuitjs.html` with two edits applied in memory as
it is sent: the web-app manifest link is made relative (upstream's points at an absolute
`/circuit/` path on falstad.com) and the service-worker registration is dropped, because the files
are already local and a cache in front of them can only serve something stale. The service worker
itself is not downloaded. See the comment at the top of `viewer.mjs`.

## LZString

`upstream/war/lz-string.min.js` arrives with CircuitJS1's `war/` directory. © 2013 pieroxy, MIT.
