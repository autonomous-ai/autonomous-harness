# A second harness machine, in a box.
#
# This exists to exercise the ONE path a single laptop cannot reach on its own: the app talking to a
# machine that is not the machine it is running on. Frames leave the desktop's local daemon, cross the
# backend relay (`cli/src/lib/remoteRelay.ts`), and are handled by the daemon in here. Nothing is
# stubbed — this container is a real machine on a real account, and the app cannot tell it apart from
# a second laptop.
#
# ## Two things about this image are load-bearing
#
# 1. **It carries the bundle from YOUR working tree, and self-update is off.** A container that
#    updated itself would pull the published release, and a feature that has not shipped yet — the
#    grid launch this rig was built to test, for one — would simply not be in it. The test would then
#    fail for a reason that has nothing to do with the code under test, which is the worst kind of
#    red. `ADAPTER_UPDATE_DISABLE=true` lives in the launcher, exactly as `install-cli.sh --no-updates`
#    writes it on a real box.
#
# 2. **Code and state are deliberately on opposite sides of the volume.** The CLI is baked at
#    `/opt/harness/cli`; the mutable state — computer id, SSO session, session registry — lives under
#    `$HOME/.harness`, which is where the volume mounts. Putting the code in its default home instead
#    would mean the volume SHADOWS `cli.js` on the second run, and the container would come up empty
#    with no obvious cause.
#
# Runs as the unprivileged `node` user (uid 1000, already in the base image) rather than root, because
# Claude Code refuses `--dangerously-skip-permissions` when it is root — and that flag is reachable
# from the app's New agent dialog, so a root container would quietly take a testable option away.
FROM node:22-bookworm-slim

# tmux: the daemon discovers and drives agents through it, so there is no agent without it.
# procps: `ps` — the CLI reads a live engine's environment to answer "which grid is this agent on?"
#   (`lib/processEnv.ts`). On Linux it reads /proc directly, but ps is what makes the same question
#   answerable by hand when a test disagrees with the daemon.
# git + ca-certificates + curl: what an engine expects to find on a developer box.
# socat: the SSO callback listener binds the container's LOOPBACK (as it should — see
#   ADAPTER_LOGIN_CALLBACK_PORT), but Docker publishes a port to the container's eth0, so nothing
#   from the host can ever reach a loopback bind. socat bridges exactly that gap, on the container
#   side, for the duration of a sign-in. Doing it here rather than teaching the CLI to bind 0.0.0.0
#   keeps a real computer's SSO callback on its own loopback, where it belongs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       tmux procps git curl ca-certificates less socat \
  && rm -rf /var/lib/apt/lists/*

# The engine under test. Pinned by the build so a rebuild is reproducible; bump it deliberately.
ARG CLAUDE_CODE_VERSION=2.1.260
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# ── The CLI, in the same shape `install-cli.sh` produces on a real box ────────────────────────────
# Built from the working tree by scripts/remote-machine.sh; see that script for the version label.
ENV ADAPTER_CLI_DIR=/opt/harness/cli
RUN mkdir -p /opt/harness/cli && printf '{"type":"module"}\n' > /opt/harness/cli/package.json
COPY dist/cli.js dist/notify.mjs /opt/harness/cli/

# The launcher, copied from `install-cli.sh --no-updates`. The pin is the point: see note 1 above.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '# Container install, PINNED. Self-update is off so this box keeps the bytes it was built with;' \
      '# see cli/docker/remote-machine/Dockerfile for why that is not optional here.' \
      'ADAPTER_UPDATE_DISABLE=true' \
      'export ADAPTER_UPDATE_DISABLE' \
      'exec node /opt/harness/cli/cli.js "$@"' \
    > /usr/local/bin/harness \
  && chmod 755 /usr/local/bin/harness

# State lives under the volume; code does not. Both halves of note 2.
ENV ADAPTER_DATA_DIR=/home/node/.harness/data
RUN mkdir -p /home/node/.harness/data && chown -R node:node /home/node/.harness

# Get Claude Code past the two first-run prompts, and nothing else.
#
# A box with no `~/.claude.json` opens on the theme picker, and then on "do you trust this folder?".
# Either one leaves the engine sitting at a prompt, which the daemon correctly reads as an agent that
# is BUSY — so `agent_retarget` refuses it and the rig cannot test the one thing it was built to test.
#
# This is the container standing in for a developer's already-used machine, not a decision being made
# on anyone's behalf. The trust entry covers exactly ONE directory: /home/node/work, which this image
# created and which only ever holds what a test puts there. That is deliberately narrower than what
# `gridLaunch.ts` refuses to do on a real computer — pre-trusting whatever folder a person happens to
# open an agent in — and the difference is the whole justification.
#
# It carries NO credential. An agent in here can reach a model only through the grid environment the
# daemon hands it at launch, which is precisely what makes this rig's answer trustworthy.
RUN mkdir -p /home/node/work \
  && printf '%s\n' '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"/home/node/work":{"hasTrustDialogAccepted":true}}}' \
     > /home/node/.claude.json \
  && chown -R node:node /home/node/.claude.json /home/node/work

COPY --chown=node:node docker/remote-machine/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

USER node
WORKDIR /home/node
VOLUME ["/home/node/.harness"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
