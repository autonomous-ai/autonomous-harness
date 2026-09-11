# CI/CD

Three workflows, all under [`.github/workflows/`](../.github/workflows/).

| File | Runs when | Does |
|---|---|---|
| `ci.yml` | every pull request against `main`; on demand | `npm ci` → `npx tsc --noEmit` → `npx vitest run`, i.e. `make cli-test` |
| `release.yml` | a pushed `v*_cli` tag; on demand | bundles and publishes the CLI, then verifies the published bytes |
| `production-be-build.yaml` | a pushed `v*_api` tag | builds `backend/Dockerfile.k8s` and pushes it to GCR |

`ci.yml` and `release.yml` are modelled on the ones in `autonomous-harness-desktop` and share that
repo's release infrastructure: the same GCS bucket (`s3-autonomous-upgrade-3`), the same service
account, the same "the tag is the version" rule, the same annotated-tag release notes, and the same
`metadata_path` dry run. What follows is only what is specific to this repo.

## Why the tag suffixes

Both release triggers live in one repo, so each one has to be unmistakable: `v0.1.72_cli` publishes
the CLI and `v1.4.0_api` builds the backend image. `release.yml` strips both the `v` and the `_cli`
before anything treats the string as a version — the suffix is a routing marker for the trigger and
never reaches the manifest, the release title or the daemon's self-update comparison.

## Setup

### Public-repo ground rules

This repo is public and takes fork pull requests, which puts one hard line through the middle of CI:

- **`ci.yml` has no access to any secret, and must keep it.** It is triggered by `pull_request`, never
  `pull_request_target` — a fork's PR therefore runs with a read-only `GITHUB_TOKEN` and an empty
  secrets context, which is the only safe way to execute a stranger's code. Never add a secret to
  `ci.yml`, and never switch its trigger; a step that needs a credential belongs in a separate
  workflow gated on something a maintainer does.
- **Both release workflows are reachable only by a tag push**, which requires write access. Fork PRs
  cannot run them and cannot read their credentials.
- **Anything interpolated into a `run:` block goes through `env:` first.** Git allows quotes,
  backticks and `$()` in a ref name, so `${{ github.ref_name }}` written inline in a shell script is
  a command-injection primitive. `release.yml` routes every such value through `env:` and reads it as
  `"$REF_NAME"`.

### GCP credentials: workload identity federation

`release.yml` authenticates to GCP with **Workload Identity Federation** — no long-lived
service-account key. The job presents its own GitHub OIDC token, GCP validates it against a provider
that is pinned to this org, and hands back a token that expires in an hour. There is nothing to leak
and nothing to rotate.

**The release bucket and the backend's container registry are in different GCP projects**, and that
shapes the setup. It does *not* mean two pools: a pool in one project can be granted impersonation on
a service account in another — the project number inside the pool's resource name is the pool's,
never the service account's. So one pool and one provider serve both, and only the service account
differs:

```
        ONE pool + provider (pick either project as home)
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
  SA in the bucket project    SA in autonomous-ecm
  storage.objectAdmin         artifactregistry.writer / gcr bucket writer
  secret GCP_SERVICE_ACCOUNT  secret GCP_SERVICE_ACCOUNT_GCR
       used by release.yml         used by production-be-build.yaml
```

Provision it from a laptop with an owner-ish `gcloud` login — **once per service account**, not once
per project. The second run reuses the first run's pool:

The script and the full runbook live in **`autonomous-ai/github-templates`**, because every repo that
calls those templates needs them:

```bash
git clone https://github.com/autonomous-ai/github-templates && cd github-templates
gcloud auth login

# 1. pool, provider, and the release identity in the bucket's project
GITHUB_REPO=autonomous-harness GCP_PROJECT=<bucket-project> ENVIRONMENT=release \
  bash scripts/setup-gcp-wif.sh

# 2. the image-push identity in the registry's project, against that same pool
GITHUB_REPO=autonomous-harness GCP_PROJECT=autonomous-ecm POOL_PROJECT=<bucket-project> \
  SA_NAME=gha-autonomous-harness-gcr SECRET_NAME=GCP_SERVICE_ACCOUNT_GCR \
  bash scripts/setup-gcp-wif.sh
```

See `WORKLOAD-IDENTITY.md` in that repo for what each step does and how the failures present.

It creates the pool, the provider, a dedicated service account, and the IAM binding that lets *only*
this repo impersonate it — then prints the two values to add under **Settings → Secrets and variables
→ Actions → Secrets**:

| Secret | Value | Used by |
|---|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<pool-project-number>/locations/global/workloadIdentityPools/github/providers/github` | both |
| `GCP_SERVICE_ACCOUNT` | `gha-autonomous-harness@<bucket-project>.iam.gserviceaccount.com` | `release.yml` |
| `GCP_SERVICE_ACCOUNT_GCR` | `gha-autonomous-harness-gcr@autonomous-ecm.iam.gserviceaccount.com` | `production-be-build.yaml` |

The provider is one value for both — they share a pool. Only the service account is per project, and
the number in the provider path is the **pool's** project, which is the mistake worth not making.

Neither is truly sensitive — a provider resource name and a service-account email are public
identifiers, useless without a matching OIDC token — but they are secrets so that everything CI
authenticates with lives in one place. The cost is that GitHub will not show you the value again
after you save it, and both are masked as `***` in logs, so a typo in the provider path surfaces as
an auth failure rather than something you can read off the run. Keep a copy of what the script
printed.

**The provider's `--attribute-condition` is the control that matters.** A provider created without one
trusts every repository on GitHub: anyone could push a workflow to their own repo, mint an OIDC token
and exchange it against yours. The script sets

```
assertion.repository_owner == 'autonomous-ai' && assertion.event_name != 'pull_request'
```

and refuses to proceed if it finds an existing provider with an empty condition. A fork of this public
repo has a different owner, so the first clause stops the obvious attack — fork it, add a workflow,
mint a token. The second is belt as well as braces (GitHub does not grant `id-token: write` to a
fork's pull request) but it is the clause that survives somebody later adding a PR-triggered job by
mistake. The per-service-account binding then narrows it to one repo. All of it is required; no single
layer is enough.

Pass `ENVIRONMENT=release` (as above) and the binding becomes an exact match on
`repo:autonomous-ai/autonomous-harness:environment:release`, so the credential only exists for a job
that declares `environment: release`. That is how you put **required reviewers in front of the
credential**, which is worth doing here for the reason spelled out under
[What "publish" actually means](#what-publish-actually-means-here): the manifest this job writes is
polled by every running daemon every 60 seconds. If you take that option, add `environment: release`
to the `preflight` and `publish` jobs and configure the environment's reviewers in repo settings.

### Cutover, and finishing it

The auth steps try WIF when the `GCP_WORKLOAD_IDENTITY_PROVIDER` secret is set and fall back to the
old `GCP_SA_KEY` secret when it is not, so provisioning GCP and switching CI are not the same deploy.
That fallback is temporary. Once one release has gone green on WIF:

1. Delete the `GCP_SA_KEY` secret from this repo and from any organization-level scope.
2. Delete the key itself, so a copy that leaked earlier is dead:
   ```bash
   gcloud iam service-accounts keys list   --iam-account=<old-sa> --project=<project>
   gcloud iam service-accounts keys delete <KEY_ID> --iam-account=<old-sa> --project=<project>
   ```
3. Delete the two `credentials_json` fallback steps from `release.yml`, and the `HAS_WIF` job
   variables that only exist to switch between the two paths.

A key that is still valid is still a liability even when nothing uses it.

### `gcloud storage`, not `gsutil`

`gsutil` is a standalone Python tool that only understands gcloud's user and service-account-*key*
credentials. It cannot use the external-account credential federation issues, so every `gsutil` call
in a WIF-authenticated job fails while the identical `gcloud storage` call succeeds. `upload-cli.sh`
prefers `gcloud storage` and keeps `gsutil` only as a fallback for an old local SDK — which it warns
about, because that path cannot work in CI.

### The backend image build

`production-be-build.yaml` delegates the build to `autonomous-ai/github-templates`. It calls
**`docker-build-and-push-v2.yaml`** — a clone of the long-standing `docker-build-and-push.yaml` with
federation, SHA-pinned actions, no caller value spliced into a shell, and deploy secrets as BuildKit
mounts instead of build args.

**A clone, because one of those changes is not backwards compatible.** Moving
`SECRET_DEPLOY_GITHUB_TOKEN` and friends out of `build-args` silently empties them for any Dockerfile
still reading the `ARG`, and that template is shared with `autonomous-code`, `ecm-web` and
`autonomous-harness-backend`. The original is untouched and still theirs; they migrate when they
choose, and v1 can be deleted once the last one has. Nothing this repo does can break their builds.

It shares `release.yml`'s provider secret but takes its **own** service account, because the registry
is in a different project from the release bucket — hence `GCP_SERVICE_ACCOUNT_GCR`. Grant that one
image push in the registry's project:

```bash
# Artifact Registry (preferred)
gcloud artifacts repositories add-iam-policy-binding <REPO> --location=<LOC> --project=autonomous-ecm \
  --member="serviceAccount:gha-autonomous-harness-gcr@autonomous-ecm.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
# legacy gcr.io, which is a GCS bucket underneath
gcloud storage buckets add-iam-policy-binding gs://artifacts.autonomous-ecm.appspot.com \
  --member="serviceAccount:gha-autonomous-harness-gcr@autonomous-ecm.iam.gserviceaccount.com" \
  --role="roles/storage.legacyBucketWriter"
```

Two identities rather than one is not ceremony here: it means a compromised image build cannot touch
the release bucket that every daemon on the fleet polls, and vice versa.

**Merge order matters.** `docker-build-and-push-v2.yaml` has to exist on `github-templates`' `main`
before this repo's caller points at it. The reverse order breaks every `v*_api` tag build until it is
fixed — though only this repo's, which is the point of the clone.

**`permissions:` belongs to the caller.** A called workflow can never hold more permission than the
caller granted it, and `id-token` is in no default set — a template that declared `id-token: write`
itself would hard-fail every caller that had not granted it. So v2 declares nothing and each caller
states what it grants, which is why `production-be-build.yaml` carries the block.

Two details worth carrying into anything else that calls these templates:

- **The `secrets` context is unreadable from a step-level `if:`.** Both here and in v2, the "use WIF
  or use the key" switch reads a job-level `env:` boolean (`HAS_WIF`, `HAS_SA_KEY`) computed from the
  secret, never the secret itself. `actionlint` catches the direct form; nothing else does.
- **A build arg a Dockerfile consumes is readable from `docker history`.** It is not a private channel
  into a build. Use `RUN --mount=type=secret` for anything that is actually a credential.

`@main` on the `uses:` line is still a moving branch reference, and that is the remaining hole: pin it
to a commit SHA once v2 has landed.

### Action pinning

Third-party actions in `release.yml` are pinned to commit SHAs with the tag in a trailing comment. A
tag is a mutable pointer: `softprops/action-gh-release@v2` runs in the job that holds
`contents: write`, and whoever can move that tag can run their own code against that token.
`actions/*` are GitHub-owned and stay on major tags.

The same argument applies to
`uses: autonomous-ai/github-templates/....yaml@main` in `production-be-build.yaml`, which is a
*moving branch* reference on a workflow that receives GCP push credentials. Pin it to a SHA and bump
it deliberately.

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

git tag -a vX.Y.Z_cli --cleanup=verbatim -F notes.md
git push origin vX.Y.Z_cli
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
