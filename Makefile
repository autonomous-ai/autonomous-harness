# Convenience targets for this repository.
#
# Pass extra arguments to a target's script via ARGS, e.g.:
#   make install-cli ARGS="--no-restart"
#   make upload-cli  ARGS="0.1.0"

.PHONY: cli-test install-cli upload-cli

## cli-test: typecheck + run the CLI test suite.
cli-test:
	cd cli && npx tsc --noEmit && npx vitest run

## install-cli: bundle the CLI from THIS working tree and install it into ~/.harness/cli — the local dev
## loop, nothing published. Restarts the daemon on the new bytes. Self-update stays ON: the build is
## labelled with the published version, which the release you are level with cannot outrank, so your bytes
## survive until a NEWER version ships — then it lands. ARGS="--no-updates" to pin instead.
install-cli:
	bash cli/scripts/install-cli.sh $(ARGS)

## upload-cli: bump version -> bundle -> publish the CLI. MAINTAINER ONLY — it writes to the release
## bucket, so it needs an authenticated `gsutil` with write access (plus node/npm for the bundle step).
## Running daemons pick the new version up within ~1 min.
upload-cli:
	bash cli/scripts/upload-cli.sh $(ARGS)
