# Convenience targets for this repository.
#
# Pass extra arguments to a target's script via ARGS, e.g.:
#   make install-cli ARGS="--no-restart"
#   make upload-cli  ARGS="0.1.0"

.PHONY: cli-test install-cli upload-cli release-cli release-backend release-desktop remote-machine

## cli-test: typecheck + run the CLI test suite.
cli-test:
	cd cli && npx tsc --noEmit && npx vitest run

## release-cli: tag this commit vX.Y.Z_cli and push the tag — CI bundles the CLI, publishes it to
## GCS, and cuts the GitHub Release. The version is bumped from max(last git tag, live
## metadata.json's `cli` key). The `_cli` suffix is a tag-trigger marker only (see cli/RELEASE.md);
## it never appears in the published version. ARGS="--dry-run" to preview.
release-cli:
	bash cli/scripts/release-cli.sh $(ARGS)

## release-backend: tag this commit vX.Y.Z_api and push the tag — CI builds the backend's Docker
## image and rolls it out. ARGS=minor|major|X.Y.Z to bump differently, ARGS=--dry-run to preview.
## See backend/scripts/release-be.sh.
release-backend:
	bash backend/scripts/release-be.sh $(ARGS)

## release-desktop: tag this commit vX.Y.Z_desktop and push the tag — CI builds both macOS builds
## and both Linux architectures, publishes to GCS, and cuts the GitHub Release. The version is bumped
## from max(last git tag, live harness/desktop/metadata.json). ARGS="--dry-run" to preview,
## ARGS="--minor" for a forced-update minor bump, ARGS="X.Y.Z" for an explicit version. The by-hand
## escape hatches (upload-desktop, upload-desktop-linux, upload-node-runtime) live in desktop/Makefile.
release-desktop:
	bash desktop/scripts/release-desktop.sh $(ARGS)

## install-cli: bundle the CLI from THIS working tree and install it into ~/.harness/cli — the local dev
## loop, nothing published. Restarts the daemon on the new bytes. Self-update stays ON: the build is
## labelled with the published version, which the release you are level with cannot outrank, so your bytes
## survive until a NEWER version ships — then it lands. ARGS="--no-updates" to pin instead.
install-cli:
	bash cli/scripts/install-cli.sh $(ARGS)

## upload-cli: bump version -> bundle -> publish the CLI. MAINTAINER ONLY — it writes to the release
## bucket, so it needs an authenticated `gcloud storage` (or gsutil) with write access on it, plus
## node/npm for the bundle step.
## Running daemons pick the new version up within ~1 min.
upload-cli:
	bash cli/scripts/upload-cli.sh $(ARGS)

## remote-machine: drive a SECOND harness machine in Docker, so the app's remote path (relay ->
## another machine's daemon) can be tested from one laptop. ARGS picks the step:
##   make remote-machine ARGS=build   -> bundle this tree + build the image
##   make remote-machine ARGS=up      -> start the box
##   make remote-machine ARGS=login   -> SSO on the box (interactive)
##   make remote-machine ARGS=link    -> let this Mac's relay reach it
##   make remote-machine ARGS=verify  -> what each remote agent is ACTUALLY running on
##   make remote-machine ARGS=destroy -> throw it away (prints how to drop the machine record)
## See cli/docker/remote-machine/README.md.
remote-machine:
	bash cli/scripts/remote-machine.sh $(ARGS)
