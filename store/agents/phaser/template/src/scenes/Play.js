/**
 * The starter game: a paddle, a ball, four rows of bricks. Every pixel is drawn with Graphics and
 * baked into a texture in `preload`, so the project needs no image files at all.
 *
 * Keyboard (after the click on the title screen) or the on-screen pad, which works without focus.
 */
import Phaser from 'phaser';
import { touchPad } from '../touch.js';

const COLS = 10;
const ROWS = 4;
const BRICK_W = 84;
const BRICK_H = 26;
const ROW_COLOURS = [0xff6b6b, 0xffd166, 0x06d6a0, 0x4cc9f0];
const BALL_SPEED = 380;
const PADDLE_SPEED = 620;

export default class Play extends Phaser.Scene {
    constructor() {
        super('Play');
    }

    preload() {
        // Procedural art: one Graphics object, baked into the textures the game uses.
        const g = this.add.graphics();
        g.fillStyle(0xe9ecf5, 1).fillRoundedRect(0, 0, 120, 18, 9);
        g.generateTexture('paddle', 120, 18);
        g.clear();
        g.fillStyle(0xffffff, 1).fillCircle(9, 9, 9);
        g.generateTexture('ball', 18, 18);
        ROW_COLOURS.forEach((colour, i) => {
            g.clear();
            g.fillStyle(colour, 1).fillRoundedRect(0, 0, BRICK_W, BRICK_H, 5);
            g.generateTexture(`brick${i}`, BRICK_W, BRICK_H);
        });
        g.destroy();
    }

    create() {
        const { width, height } = this.scale;
        this.score = 0;
        this.lives = 3;
        this.launched = false;

        this.paddle = this.physics.add.image(width / 2, height - 108, 'paddle');
        this.paddle.setImmovable(true).setCollideWorldBounds(true);
        this.paddle.body.setAllowGravity(false);

        this.ball = this.physics.add.image(width / 2, height - 130, 'ball');
        this.ball.setCollideWorldBounds(true).setBounce(1, 1);
        this.ball.body.onWorldBounds = true;

        this.bricks = this.physics.add.staticGroup();
        const left = (width - COLS * (BRICK_W + 8) + 8) / 2 + BRICK_W / 2;
        for (let row = 0; row < ROWS; row += 1) {
            for (let col = 0; col < COLS; col += 1) {
                this.bricks.create(left + col * (BRICK_W + 8), 96 + row * (BRICK_H + 8), `brick${row}`);
            }
        }

        this.physics.add.collider(this.ball, this.paddle, this.bounceOffPaddle, undefined, this);
        this.physics.add.collider(this.ball, this.bricks, this.breakBrick, undefined, this);
        this.physics.world.on('worldbounds', (body, _up, down) => {
            if (down && body.gameObject === this.ball) this.loseLife();
        });

        this.hud = this.add.text(16, 16, '', {
            fontFamily: 'ui-monospace, monospace', fontSize: '18px', color: '#c7d0e6'
        });
        this.banner = this.add.text(width / 2, height / 2, 'SPACE to launch', {
            fontFamily: 'ui-sans-serif, sans-serif', fontSize: '28px', color: '#06d6a0'
        }).setOrigin(0.5);

        // Keyboard and the pointer pad, read together in update(): either drives the game.
        this.cursors = this.input.keyboard.createCursorKeys();
        this.keys = this.input.keyboard.addKeys('A,D,SPACE');
        this.pad = touchPad(this, { space: 'LAUNCH' });

        this.drawHud();
    }

    update(_time, delta) {
        const left = this.cursors.left.isDown || this.keys.A.isDown || this.pad.left;
        const right = this.cursors.right.isDown || this.keys.D.isDown || this.pad.right;
        const step = (PADDLE_SPEED * delta) / 1000;
        if (left) this.paddle.x -= step;
        if (right) this.paddle.x += step;
        this.paddle.x = Phaser.Math.Clamp(this.paddle.x, 60, this.scale.width - 60);
        this.paddle.body.updateFromGameObject();

        if (!this.launched) {
            this.ball.setPosition(this.paddle.x, this.paddle.y - 22);
            if (this.cursors.space.isDown || this.keys.SPACE.isDown || this.pad.space) this.launch();
        }
    }

    launch() {
        this.launched = true;
        this.banner.setText('');
        this.ball.setVelocity(Phaser.Math.Between(-140, 140), -BALL_SPEED);
    }

    bounceOffPaddle(ball, paddle) {
        // Where on the paddle it lands decides the angle — the one rule that makes it a game.
        const offset = Phaser.Math.Clamp((ball.x - paddle.x) / 60, -1, 1);
        ball.setVelocity(offset * BALL_SPEED * 0.9, -Math.abs(ball.body.velocity.y) || -BALL_SPEED);
    }

    breakBrick(ball, brick) {
        brick.destroy();
        this.score += 10;
        this.drawHud();
        if (this.bricks.countActive() === 0) this.finish('CLEARED — click to play again');
    }

    loseLife() {
        this.lives -= 1;
        this.drawHud();
        if (this.lives <= 0) {
            this.finish('GAME OVER — click to play again');
            return;
        }
        this.launched = false;
        this.ball.setVelocity(0, 0);
        this.banner.setText('SPACE to launch');
    }

    finish(message) {
        this.launched = false;
        this.ball.setVelocity(0, 0);
        this.ball.setVisible(false);
        this.banner.setText(message);
        this.input.once('pointerdown', () => this.scene.restart());
    }

    drawHud() {
        this.hud.setText(`SCORE ${String(this.score).padStart(4, '0')}    LIVES ${this.lives}`);
    }
}
