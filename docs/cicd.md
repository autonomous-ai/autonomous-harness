# CI/CD

Two workflows, both under [`.github/workflows/`](../.github/workflows/).

| File | Runs when | Does |
|---|---|---|
| `ci.yml` | every pull request against `main`; on demand | `npm ci` → `npx tsc --noEmit` → `npx vitest run`, i.e. `make cli-test` |
| `release.yml` | a pushed `v*` tag; on demand | bundles and publishes the CLI, then verifies the published bytes |

They are modelled on the ones in `autonomous-harness-desktop` and share that repo's release
infrastructure: the same GCS bucket (`s3-autonomous-upgrade-3`), the same `GCP_SA_KEY` service
account, the same "the tag is the version" rule, the same annotated-tag release notes, and the same
`metadata_path` dry run. What follows is only what is specific to the CLI.

## Setup

One secret, in **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `GCP_SA_KEY` | the JSON key of the service account with object read/write on `s3-autonomous-upgrade-3` |

GitHub does not share secrets between repositories. This is the *same credential* the desktop repo
uses, but it has to exist here as well — either added to this repo or promoted to an organization
secret scoped to both. Nothing else is needed: there is no signing identity and no notarization,
because the artifacts are two JavaScript files whose integrity is the sha256 in the manifest.

`ci.yml` needs no secret at all, which is what makes it safe to run on a fork's pull request.

## Cutting a release

```bash
make release                       # bump the patch, tag, push — CI does the rest
make release ARGS="--dry-run"      # print the version it would cut and the notes, do nothing
make release ARGS="0.2.0"          # release an explicit version
```

`cli/scripts/release-cli.sh` works out the next version as `max(last git tag, live metadata.json's cli
key)`, refuses to publish anything that isn't strictly newer than what's live, and refuses an empty
release message before tagging. See [`cli/RELEASE.md`](../cli/RELEASE.md) for the full rundown,
including local installs and manual publishing.

The manual fallback, for when `make release` itself can't be used:

```bash
# What is live right now — the next tag is one above this. Someone may have released by hand.
curl -fsS https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/cli/metadata.json

git tag -a vX.Y.Z --cleanup=verbatim -F notes.md
git push origin vX.Y.Z
```

**Check the manifest first, and never re-use a version.** Uploading over `harness/cli/<version>/`
replaces bytes whose sha256 some machine may already have recorded, and a daemon that sees the
manifest and the object disagree refuses the update and stays where it is — silently.

The tag **is** the version, and the tag *message* is the release notes — a lightweight tag is
rejected rather than published with the commit subject as its notes. Left to itself
`cli/scripts/upload-cli.sh` reads the current version out of the remote manifest and adds one, so
what published would depend on when the job ran; CI passes the version explicitly instead.

Then, in order: `version` validates `X.Y.Z` · `preflight` proves the GCS credential · `tests` runs
the full suite · `publish` bundles, uploads and verifies · `github-release` creates the release from
the tag message.

## What "publish" actually means here

`harness/cli/metadata.json` is polled by **every running daemon every 60 seconds**
(`ADAPTER_UPDATE_URL` / `ADAPTER_UPDATE_CHECK_MS` in `cli/src/config/env.ts`). There is no download
page and no user clicking install: a minute after the manifest moves, the fleet is running the new
bytes. That is the difference from the desktop release, and it is what the extra care is sized
against.

Two consequences worth knowing before you push a tag:

- **There is no undo.** `selfUpdate.ts` only moves forward. A bad release is rolled back by
  publishing a *higher* version containing the older code — never by deleting the new one, which
  leaves every daemon pointed at a 404.
- **A green job is not a green release.** `upload-cli.sh` checks the bundle before uploading;
  `publish` then does what a daemon does — fetches the manifest, downloads both URLs, checks each
  sha256 and size against the manifest, and runs `node cli.js version` on the downloaded bytes. Those
  catch a different class of failure (a half-written manifest, a bad `Cache-Control`, an object in
  the wrong place), and `selfUpdate.ts` would refuse them silently: every daemon simply keeps the
  version it has, and the release looks fine.

## Dry run

**Actions → Release → Run workflow**, with `metadata_path` = `harness/cli/metadata-test.json`. No
daemon polls that file, so nothing self-updates.

The *artifacts* still go to their real home, `harness/cli/<version>/` — that path is hardcoded in
`upload-cli.sh`, and these workflows do not edit the release scripts. So use an unmistakable version
(`9.9.9`) and delete `gs://s3-autonomous-upgrade-3/harness/cli/9.9.9/` afterwards.

Expect `>> could not read remote metadata` in the log: `METADATA_PATH` points at a file that does
not exist yet, and that line is only the auto-bump's input. The version that publishes is the one
you typed.

## The Node pin

`ci.yml` has a single step whose whole job is to print `node-version=22.23.2`, and `release.yml`
reads it back through `needs.tests.outputs.node-version`. A release therefore cannot be bundled on a
runtime the suite did not run on.

The number is not a taste in Node versions. It is the **managed runtime** the shipped CLI actually
executes on: `harness/runtime/metadata.json` serves node v22.23.2 for `darwin-arm64`, `darwin-x64`,
`linux-x64` and `linux-arm64`, `install.sh` unpacks it under `~/.harness/runtime`, and the launcher
names that binary absolutely — the user's own node, if any, never runs the bundle. Bump it together
with `make upload-node-runtime` in `autonomous-harness-desktop`, never on its own.

`package.json`'s `engines: node >=20` is a different statement: the floor a third party may run the
package on. A floor is not a pin.

## npm, not pnpm

CI installs with `npm ci` against `cli/package-lock.json`, because every build path in this repo
shells out to `npm run bundle` — `install-cli.sh`, `upload-cli.sh`, `remote-machine.sh`. npm's
lockfile is the one the released bytes are built from.

That also makes `npm ci` a gate rather than a chore: it fails when `package-lock.json` and
`package.json` disagree.

`cli/pnpm-lock.yaml` is tracked too, and until now nothing kept it in step. On 2026-09-09
`bonjour-service` was added to `package.json` with only `package-lock.json` updated; `main` went
green, and `make install-cli` then died at `Could not resolve "bonjour-service"` on every machine
whose `node_modules` came from pnpm. `ci.yml` now runs `pnpm install --frozen-lockfile
--lockfile-only` before anything else, which resolves in about five seconds, installs nothing and
fails naming the dependency that drifted. So: if you touch `package.json`, update **both**
lockfiles.
