/**
 * On-screen controls, for a pane used with a trackpad and for a phone.
 *
 * `touchPad(scene, { space: 'Launch' })` draws a left/right pair bottom-left and one action button
 * bottom-right, and returns `{ left, right, up, down, space }` — booleans that read like a Key's
 * `isDown`, so a scene can `this.cursors.left.isDown || this.pad.left`. Pointer-driven: no keyboard
 * focus needed, which is why it is worth having even on the desktop.
 */
import Phaser from 'phaser';

const FACE = 0x1b2030;
const EDGE = 0x3d4763;
const GLYPH = '#c7d0e6';

function button(scene, x, y, w, h, label, onDown, onUp) {
    const box = scene.add.rectangle(x, y, w, h, FACE, 0.55).setStrokeStyle(2, EDGE, 0.9);
    const text = scene.add.text(x, y, label, { fontFamily: 'ui-sans-serif, sans-serif', fontSize: '20px', color: GLYPH }).setOrigin(0.5);
    // A Shape's hit area comes from its own size, so setInteractive() needs no geometry here.
    box.setScrollFactor(0).setDepth(1000).setInteractive({ useHandCursor: true });
    text.setScrollFactor(0).setDepth(1001);
    const press = () => { box.setFillStyle(EDGE, 0.75); onDown(); };
    const release = () => { box.setFillStyle(FACE, 0.55); onUp(); };
    box.on('pointerdown', press);
    box.on('pointerup', release);
    box.on('pointerout', release);
    box.on('pointerupoutside', release);
    return box;
}

export function touchPad(scene, labels = {}) {
    const state = { left: false, right: false, up: false, down: false, space: false };
    const { width, height } = scene.scale;
    const hold = (key) => [() => { state[key] = true; }, () => { state[key] = false; }];

    button(scene, 60, height - 40, 84, 56, labels.left ?? '◀', ...hold('left'));
    button(scene, 152, height - 40, 84, 56, labels.right ?? '▶', ...hold('right'));
    if (labels.space !== null) {
        button(scene, width - 90, height - 40, 140, 56, labels.space ?? 'SPACE', ...hold('space'));
    }
    return state;
}
