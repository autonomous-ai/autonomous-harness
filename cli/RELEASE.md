# Releasing the CLI

Running daemons self-update from a public GCS bucket (`src/lib/selfUpdate.ts`). Releasing is pushing a
tag: `.github/workflows/release.yml` bundles the CLI, publishes it to that bucket, and cuts the GitHub
Release. **The tag IS the version — CI never bumps.**

```bash
make release                       # bump the patch, tag, push — CI does the rest
make release ARGS="--dry-run"      # print the version it would cut and the notes, do nothing
make release ARGS="0.2.0"          # release an explicit version
make release ARGS="--notes-file notes.md"   # hand-written release notes
```

Nothing is built locally and no GCS credentials are needed: the only things `cli/scripts/release-cli.sh`
touches are git and a public HTTPS read of the manifest. See [`../docs/cicd.md`](../docs/cicd.md) for
what the release workflow itself does, step by step.

**Why the version comes from two places.** `cli/scripts/release-cli.sh` takes the highest of the last
git tag and the version published under the `cli` key of `harness/cli/metadata.json`. Publishing by
hand (`make upload-cli`, below) bumps from the manifest and tags nothing, so the two can drift — a
maintainer who runs it, or a scratch publish that slipped, leaves the manifest ahead of the last tag.
Bumping from tags alone there would produce a version LOWER than what's already served — every daemon
refuses it (`shouldUpdate` / `semverGt` in `src/lib/selfUpdate.ts`) while the release still reports
success.

Unlike `autonomous-harness-desktop`'s `make release`, there is no `--minor` flag: `shouldUpdate` is a
plain "strictly newer" check with no major/minor-triggers-a-forced-update concept, so every release
just needs to outrank what's live.

`package.json`'s `version` field is never touched by this script; the published version is baked into
the bundle via `ADAPTER_VERSION` at build time (see `make upload-cli` below).

## Publishing by hand

`cli/scripts/upload-cli.sh` is the publishing step. CI invokes it with the version taken from the tag;
it's also reachable directly when CI cannot be:

```bash
make upload-cli                    # auto-bump (0.1.2 -> 0.1.3; 0.1.99 -> 0.2.1)
make upload-cli ARGS="0.2.0"       # explicit version
make upload-cli ARGS="--no-bump"   # rebuild and re-upload the current version
make upload-cli ARGS="--no-build"  # upload the existing dist/ artifact as-is
```

**This creates no git tag.** It bumps from the remote manifest, so the repo stops reflecting what's
published. Prefer `make release`; if you do publish by hand, cut a `make release` afterwards to bring
the tag back in line.

1. Reads the current version from the live manifest (falling back to `package.json` if the manifest is
   unreadable), then bumps or takes the version it was given.
2. Bundles with `ADAPTER_VERSION="$VERSION" npm run bundle` and asserts `node dist/cli.js version`
   reads back that exact string before uploading anything.
3. Uploads `cli.js` and `notify.mjs` to `harness/cli/<version>/`, then download-merge-reuploads
   `metadata.json` in a single write, touching only the `cli` key.

A failed build stops the release; nothing is uploaded and no version is consumed.

## Local install (no upload)

`bash cli/scripts/install-cli.sh` bundles **this working tree** into `~/.harness/cli` — the same
layout the public installer produces — and restarts the daemon on it, so `harness` on this machine
means your code without publishing anything:

```bash
make install-cli                    # bundle + install + restart the daemon
make install-cli ARGS="--no-restart"   # skip restarting the daemon
make install-cli ARGS="--no-updates"   # pin self-update off (see below)
```

Self-update stays **on** by default: the local build is labelled with the currently published version,
which the release you're level with cannot outrank, so your bytes survive until a genuinely newer
version ships — then the daemon quietly swaps back to it. `--no-updates` pins your build instead.

## GCS layout and manifest shape

```
gs://s3-autonomous-upgrade-3/harness/cli/metadata.json
gs://s3-autonomous-upgrade-3/harness/cli/<version>/cli.js
gs://s3-autonomous-upgrade-3/harness/cli/<version>/notify.mjs
```

The manifest is always read straight off the GCS origin (`CDN_ASSET_BASE_URL` in `upload-cli.sh` does
not apply to it) — it's polled every ~60s by every running daemon, and this product's CDN caps any
cacheable response at ~31 days regardless of origin headers, so it must never be CDN-fronted. The bundle
files it points at are the opposite: immutable once published, so their `url` fields point at
`cdn.autonomous.ai` instead, and are uploaded with a long `Cache-Control` on purpose.

```json
{
  "cli": {
    "version": "0.1.72",
    "url": "https://cdn.autonomous.ai/harness/cli/0.1.72/cli.js",
    "sha256": "<64 hex>",
    "size": 2103552
  }
}
```

The bucket must be public-read — that is bucket policy, not something the scripts set.

## How a running daemon self-updates

1. Polls `ADAPTER_UPDATE_URL` every `ADAPTER_UPDATE_CHECK_MS` (default 60 s) — see `src/config/env.ts`.
2. Compares the manifest's `cli.version` against its own — strictly newer only (`semverGt`), so
   republishing an old build can never downgrade a fleet.
3. Downloads `cli.js` + `notify.mjs` and verifies each sha256/size against the manifest **before**
   anything is swapped in. A mismatch is discarded.
4. Swaps the bundle in when the daemon is idle and restarts, with rollback on a bad build.

**There is no undo.** A bad release is rolled back by publishing a *higher* version containing the
older code — never by deleting the new one, which just leaves every daemon pointed at a 404. Disable
self-update on one machine with `ADAPTER_UPDATE_DISABLE=true`.

## Rolling out safely

Publish to a scratch manifest before touching the real one, then point a local build at it:

```bash
gh workflow run release.yml -f version=9.9.9 -f metadata_path=harness/cli/metadata-test.json
```

```bash
ADAPTER_UPDATE_URL=https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/cli/metadata-test.json harness start
```

No daemon polls `metadata-test.json`, so nothing self-updates from it. The *artifacts* still go to
their real home (`harness/cli/<version>/` is hardcoded in `upload-cli.sh`), so use an unmistakable
version and delete `gs://s3-autonomous-upgrade-3/harness/cli/9.9.9/` afterwards.
