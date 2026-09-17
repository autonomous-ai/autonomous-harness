# Third-party notices

**three.js** 0.186.0 — [mrdoob/three.js](https://github.com/mrdoob/three.js), MIT License,
copyright © 2010-2026 three.js authors. Not vendored: installed from npm by `setup.sh` at the exact
version in `package.json` / `package-lock.json`, served unmodified from `node_modules/three` (its
`build/` and `examples/jsm/` — the glTF, Draco and KTX2 loaders, the meshopt decoder, the
postprocessing passes and shaders, RoomEnvironment). The license text is in `LICENSE-three`.

three.js's `examples/jsm/libs/` carry their own notices inside `node_modules/three` (the Draco
decoder, Apache-2.0, Google; the meshopt decoder, MIT, Arseny Kapoulkine; the Basis Universal
transcoder, Apache-2.0, Binomial). They are served as shipped, only when a model needs them.

Earlier versions of this package used Google's `<model-viewer>` (Apache-2.0); it is no longer a
dependency.
