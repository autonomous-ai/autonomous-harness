# Provenance

## `skills/` — 28 skills vendored from phaserjs/phaser

Everything under `skills/` except `skills/harness-phaser/` is **Phaser Studio's own agent skills,
copied verbatim** — not edited, not reworded, not reordered.

| | |
|---|---|
| Source | <https://github.com/phaserjs/phaser> — the `skills/` directory at the repository root |
| Branch | `master` |
| Commit | `02d8931b626d9764c133cbb3fbf99966c03c757c` (2026-08-21) |
| Licence | MIT — Copyright (c) 2026 Richard Davey, Phaser Studio Inc. (`LICENSE-phaser`) |
| Files | 28 `SKILL.md`, plus the `references/REFERENCE.md` that seven of them carry |

They are vendored rather than fetched at install because the MIT licence permits it and because a
harness that works offline after `harness dsh install` is better than one that does not.

To refresh them against a newer Phaser:

```sh
git clone --filter=blob:none --no-checkout --depth 1 https://github.com/phaserjs/phaser.git /tmp/phaser
cd /tmp/phaser && git sparse-checkout init --cone && git sparse-checkout set skills && git checkout
cd -
find skills -mindepth 1 -maxdepth 1 -type d ! -name harness-phaser -exec rm -rf {} +
cp -R /tmp/phaser/skills/. skills/
```

then update `SKILLS_COMMIT` in `VERSIONS` and the commit in the table above.

`skills/harness-phaser/` is ours (MIT, `LICENSE`): the workspace, the pane, keyboard focus, the
verdict. It is the only skill in this package that Phaser Studio did not write.

## `template/` — the shape of phaserjs/template-vite

`template/` follows <https://github.com/phaserjs/template-vite> (MIT, Phaser Studio) — the same
`index.html` / `src/main.js` / `vite.config` layout and the same `manualChunks: { phaser: ['phaser'] }`
and terser settings. The scenes, `src/touch.js`, `vite.config.mjs`'s `fs.allow` and `cacheDir`, and
the `out/dist` output directory are ours. The upstream template's `log.js` build-time ping is **not**
included: a Harness workspace stays off the network.

## `phaser` itself

Installed from npm at the version pinned in `package.json` and `VERSIONS` (`4.2.1`), unmodified.
