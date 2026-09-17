---
name: harness-phaser
description: "Use this skill first in a Harness Phaser workspace. The project layout, the Vite dev-server pane and its live reload, the webview keyboard-focus rule (click-to-play gate and on-screen touch buttons), procedural art with no asset files, and .harness/verdict.json. Triggers on: Harness, the pane, dev server, keyboard focus, click to play, touch buttons, verdict, workspace layout, new game."
---

# harness-phaser
> How a Phaser game is built inside a Harness workspace: where the files go, what the pane is, why
> the first scene must wait for a click, and what the verdict checks.

**Related skills:** ../game-setup-and-config/SKILL.md, ../scenes/SKILL.md,
../input-keyboard-mouse-touch/SKILL.md, ../graphics-and-shapes/SKILL.md, ../scale-and-responsive/SKILL.md

## The workspace

```
index.html          loaded by the pane; script tag → /src/main.js
vite.config.mjs     960×540 FIT, base './', build.outDir 'out/dist', cacheDir '.vite'
src/main.js         new Phaser.Game({...}) — config and the scene list. The entry; keep the name.
src/scenes/*.js     one class per file, `export default class X extends Phaser.Scene`
src/touch.js        touchPad(scene, labels) → on-screen controls
public/             served at the root: /style.css, and any real asset files
out/dist/           the production build, written by the verdict. Generated; never edit.
node_modules        a SYMLINK to the Harness package's shared install. Never npm install here.
.harness/verdict.json   the pane header. Written by the verdict script only.
```

Phaser is **4.2.1**, loaded as a module: `import Phaser from 'phaser';` at the top of every file
that names it. There is no global `Phaser` and no `<script src>`.

## The pane is a Vite dev server

Harness runs `vite --port <port> --strictPort --host 127.0.0.1` in the workspace and shows it beside
the terminal. That means:

- **Saving a file reloads the game.** No build step, no refresh, no URL to print. A module with
  `export default class ... extends Phaser.Scene` reloads through a full page reload, which restarts
  the game from the first scene — expected, and the reason the first scene should be cheap.
- **Never start a second server** (`npm run dev`, `vite preview`, `python -m http.server`). The port
  is taken and the pane is already pointed at it.
- **A blank pane is a JavaScript error**, not a Phaser problem. Run the verdict: the Vite build
  reports the same error with a file and a line.

## Keyboard focus: the rule that makes or breaks the game

The pane is a **WKWebView**. It does not receive key events until the player clicks inside it. A
game that starts straight into `update()` reading `cursors.left.isDown` looks broken — it draws, it
just never moves.

Every game therefore opens on a gate:

```js
export default class Title extends Phaser.Scene {
    constructor() { super('Title'); }

    create() {
        const { width, height } = this.scale;
        this.add.text(width / 2, height / 2 - 40, 'SPACE RUNNER', {
            fontFamily: 'ui-sans-serif, sans-serif', fontSize: '64px', color: '#e9ecf5'
        }).setOrigin(0.5);
        const hint = this.add.text(width / 2, height / 2 + 50, 'Click to play', {
            fontFamily: 'ui-sans-serif, sans-serif', fontSize: '30px', color: '#06d6a0'
        }).setOrigin(0.5);
        this.tweens.add({ targets: hint, alpha: 0.2, duration: 700, yoyo: true, repeat: -1 });
        this.add.text(width / 2, height - 56, '←  →   move    ·    SPACE   jump', {
            fontFamily: 'ui-monospace, monospace', fontSize: '16px', color: '#6b7794'
        }).setOrigin(0.5);

        // The click starts the game AND gives the webview its keyboard focus.
        this.input.once('pointerdown', () => this.scene.start('Play'));
    }
}
```

The prompt must say **click**, not "press any key" — a key press cannot arrive yet. Put the controls
on the title screen too: the pane is where the user reads them.

### On-screen controls, always worth adding

Pointer input needs no focus at all, so a pad makes the game playable before the click and on a
phone. `src/touch.js` in the template:

```js
import { touchPad } from '../touch.js';

create() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys('A,D,SPACE');
    this.pad = touchPad(this, { space: 'JUMP' });   // { space: null } for no action button
}

update() {
    const left  = this.cursors.left.isDown  || this.keys.A.isDown || this.pad.left;
    const right = this.cursors.right.isDown || this.keys.D.isDown || this.pad.right;
    const jump  = this.cursors.space.isDown || this.keys.SPACE.isDown || this.pad.space;
}
```

Each button is a `Rectangle` with `setInteractive()` and `pointerdown`/`pointerup`/`pointerout`
handlers flipping a boolean, at `setScrollFactor(0).setDepth(1000)` so a moving camera leaves it
alone. Write your own variant when the game needs a different set (a d-pad, two action buttons).

Also avoid keys the browser keeps: Cmd/Ctrl combinations, F-keys, Tab. Arrows, WASD, space, Z/X and
Enter are all free.

## Art without asset files

A fresh workspace has no images and needs none. Draw once, bake to a texture, use it like any other:

```js
preload() {
    const g = this.add.graphics();
    g.fillStyle(0xffd166, 1).fillRoundedRect(0, 0, 48, 48, 8);
    g.fillStyle(0x0b0d12, 1).fillCircle(16, 18, 4).fillCircle(32, 18, 4);
    g.generateTexture('player', 48, 48);
    g.destroy();                      // one Graphics object, cleared and reused, then dropped
}

create() {
    this.player = this.physics.add.image(120, 300, 'player');
}
```

`generateTexture` goes through the Canvas API, so gradients (`fillGradientStyle`) do not survive it —
use flat fills, or a `Gradient` game object instead. Shapes (`this.add.rectangle`, `.circle`,
`.triangle`, `.star`) are fine for HUD and background, but a physics body is happier on an image.
Real assets, when the user supplies them, go in `public/` and load as `/name.png`.

## The verdict

```sh
python3 "$PHASER_TOOLCHAIN/verdict.py"             # after every change
python3 "$PHASER_TOOLCHAIN/verdict.py" --no-build  # a fast pass; leaves Build unverified
```

It writes `.harness/verdict.json` and prints the same thing. Three phases:

| Phase | What it means |
|---|---|
| **Write** | `src/main.js` exists and a file declares a scene |
| **Build** | `vite build --outDir out/dist` succeeded — the compile check; a syntax error, a bad import or an unresolved module becomes a finding with its file and line |
| **Play** | a scene has a `create()` and the game handles input; a missing click-to-play gate is an `info`, not a failure |

`ready` is true when it builds and something would respond to the player. Run it after every pass,
not at the end: the header is how the user sees progress. Never write the file by hand.
