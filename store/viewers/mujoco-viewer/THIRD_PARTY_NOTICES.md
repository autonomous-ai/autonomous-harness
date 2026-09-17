# Third-party notices

Nothing third-party is vendored in this folder. Both dependencies are installed from npm by
`setup.sh` (`npm ci`, exact versions in `package-lock.json`) into `node_modules/`, served unmodified
by `viewer.mjs`, and never fetched from a CDN at view time.

**MuJoCo** — `@mujoco/mujoco` 3.13.0, the official WebAssembly build and JavaScript bindings of
[google-deepmind/mujoco](https://github.com/google-deepmind/mujoco). Apache License 2.0, copyright
DeepMind Technologies Limited. Text in `LICENSE-mujoco`. The single-threaded build (`mujoco.js`,
`mujoco.wasm`) is the one loaded.

**three.js** — `three` 0.186.0, [mrdoob/three.js](https://github.com/mrdoob/three.js). MIT License,
copyright 2010–2026 three.js authors. Text in `LICENSE-three`. Used: the core module and two
addons from `examples/jsm`, `controls/OrbitControls.js` and `objects/Reflector.js`.

**Approach, not code** — reading render geometry out of a compiled `MjModel` (mesh buffers addressed
through `geom_dataid`, primitives from `geom_size`) follows MuJoCo's `wasm/demo_app` (Apache-2.0) and
[zalo/mujoco_wasm](https://github.com/zalo/mujoco_wasm) (MIT, `LICENSE-mujoco-wasm`). No file from
either is copied here.

The Menagerie robots the pane shows belong to the harness that uses this viewer (see its
`LICENSE-menagerie`), not to this package.
