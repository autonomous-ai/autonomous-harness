/**
 * The gate.
 *
 * The Harness pane is a webview, and a webview has no keyboard focus until the player clicks inside
 * it — so arrow keys do nothing until that first click. Every game therefore opens on a scene that
 * says "click to play" and waits for one `pointerdown`. That click both starts the game and hands
 * the canvas the focus its keyboard input needs. Never skip it.
 */
import Phaser from 'phaser';

export default class Title extends Phaser.Scene {
    constructor() {
        super('Title');
    }

    create() {
        const { width, height } = this.scale;

        this.add.text(width / 2, height / 2 - 90, 'BRICKS', {
            fontFamily: 'ui-sans-serif, sans-serif', fontSize: '72px', color: '#e9ecf5'
        }).setOrigin(0.5);

        this.add.text(width / 2, height / 2 - 30, 'a Phaser starter — replace it with the game you were asked for', {
            fontFamily: 'ui-sans-serif, sans-serif', fontSize: '18px', color: '#6b7794'
        }).setOrigin(0.5);

        const hint = this.add.text(width / 2, height / 2 + 50, 'Click to play', {
            fontFamily: 'ui-sans-serif, sans-serif', fontSize: '30px', color: '#06d6a0'
        }).setOrigin(0.5);
        this.tweens.add({ targets: hint, alpha: 0.2, duration: 700, yoyo: true, repeat: -1 });

        this.add.text(width / 2, height - 56, '←  →  or  A  D   move    ·    SPACE   launch', {
            fontFamily: 'ui-monospace, monospace', fontSize: '16px', color: '#6b7794'
        }).setOrigin(0.5);

        // One click anywhere in the canvas: it starts the game AND gives the pane keyboard focus.
        this.input.once('pointerdown', () => this.scene.start('Play'));
    }
}
