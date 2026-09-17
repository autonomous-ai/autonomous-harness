/**
 * The game. 960×540, scaled to FIT the pane, two scenes: the click-to-play gate and the game.
 *
 * The Harness pane is a webview that has no keyboard focus until something inside it is clicked,
 * so the first scene is always a gate — see scenes/Title.js. Keep that shape in every game.
 */
import Phaser from 'phaser';
import Title from './scenes/Title.js';
import Play from './scenes/Play.js';

export const WIDTH = 960;
export const HEIGHT = 540;

export default new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-container',
    width: WIDTH,
    height: HEIGHT,
    backgroundColor: '#0b0d12',
    scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    physics: {
        default: 'arcade',
        arcade: { gravity: { x: 0, y: 0 }, debug: false }
    },
    scene: [Title, Play]
});
