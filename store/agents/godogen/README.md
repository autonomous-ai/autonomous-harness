# Godogen · Game Studio

A Babylon.js game workspace using [Godogen](https://github.com/htdt/godogen)'s game-making workflow
and asset-generation skill. Claude Code runs in the agent pane; Game Viewer builds the workspace
on each save in the other pane.

The starter, **Alpine Drift**, is a small playable snowboarding course. Orbit the mountain in
Explore, then switch to Play: steer, jump, collect gates, reach the finish, and restart. Its
geometry is procedural; opening and changing the starter needs no asset-service account.

The macOS desktop app can show this viewer locally or from a linked remote machine. Remote viewing
requires the forwarding-capable Harness CLI on both computers; older remote CLIs show update
guidance. The viewer remains interactive, including Play and workspace build controls.

## Use

```sh
harness dsh install autonomous/godogen
```

Open Godogen in New Harness and describe the game you want to make. For example:

> Turn this mountain into an autumn forest. Keep the snowboard controls, add a jump ramp,
> and make the gates easier to see.

The agent saves small steps, updates the progress message, and checks its work. Builds become
versions only after the browser reports a rendered scene. An error keeps the previous working
game visible. While you play or inspect an older version, a new version waits behind **View update**.
The studio log has activity, versions, imported assets, and **Export game**, which writes the
selected playable build to a new folder under `out/`.

## What is installed

- Godogen's pinned upstream instructions and asset skill, fetched into `upstream/` and rendered
  into `runtime/`. This wrapper targets Godogen's **Babylon.js** workflow; it does not install
  Godot or Bevy.
- Pinned Babylon.js, TypeScript, and Vite, local to this package.
- The shared `autonomous/game-viewer` dependency, reused if another harness already installed it.

Setup uses the machine's Node or Harness's managed Node; Node 22.12 or newer is required. Its
small Node publisher renders the same Babylon/Claude documents as upstream's publisher, without
requiring Python or rsync to install the starter. Git and network access are needed at install.
Subsequent starter builds use local dependencies.

Generated art is optional. Godogen's asset-generation tools have their own Python dependencies,
provider credentials, and charges. The agent must establish the provider budget before using them.
No provider call is required or made by setup.

## Develop

```sh
harness dsh check "$PWD/store/agents/godogen"
harness dsh install "$PWD/store/viewers/game-viewer" --link
harness dsh install "$PWD/store/agents/godogen" --link
```

The workspace contains `src/main.ts`, `src/style.css`, `index.html`, and `studio.json`.
`npm run check` checks TypeScript; `npm run build` writes a standalone build to `dist/`.
Use relative asset URLs so each revision and exported game can run independently.

The `studio` skill documents the viewer bridge and progress file. The viewer owns
`.harness/verdict.json`; a successful render is a preview check, not proof that every game rule
works. Play-test the controls, goal, failure, and restart after changing behavior.

Versions and dependencies are in [VERSIONS](VERSIONS) and [package-lock.json](package-lock.json).

### Browser checks

From this package after setup:

```sh
npm ci
npm run test:browser
npx playwright install webkit
GODOGEN_BROWSER=webkit npm run test:browser
```

The test creates a disposable workspace and viewer. It exercises controls, a full game loop,
live source edits, build and runtime failures, version retention, export, and a narrow layout.
Screenshots go to ignored `test-results/`. Chrome is used if installed on macOS; otherwise
run `npx playwright install chromium` first. `GAME_VIEWER_DIR` can point at a separate viewer
checkout; by default the test uses the sibling package in this repository. Browser tooling is
a development dependency and is omitted by normal harness installation.

## Credit and stewardship

[Godogen](https://github.com/htdt/godogen) is Alex Ermolov's project, licensed under MIT. Its
instructions and asset-generation tools are fetched unchanged at the commit in `VERSIONS`.
[LICENSE-godogen](LICENSE-godogen) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) preserve
its credit.

OpenHarness contributors wrote this wrapper, Game Viewer, and the Alpine Drift starter. This is
an independent integration, not an upstream endorsement. Wrapper issues belong in OpenHarness;
Godogen issues belong upstream. Upstream maintainers are welcome to take over the package or
move it into a repository they maintain.
