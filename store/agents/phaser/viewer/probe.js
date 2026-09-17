// Injected into the game page by the Harness pane, before the game's own entry module. It imports
// the same `phaser` the game does, so it can see each Phaser.Game as it boots and hand it to the
// frame (pause, debug bodies, restart a scene, return to a scene after a reload). Outside that
// frame it does nothing.
import Phaser from 'phaser';

let host = null;
try { host = window.parent !== window ? window.parent.__harnessFrame : null; } catch { host = null; }

if (typeof host === 'function' && Phaser && Phaser.Game && !Phaser.Game.prototype.__harnessPatched) {
  const boot = Phaser.Game.prototype.boot;
  Phaser.Game.prototype.boot = function (...args) {
    const result = boot.apply(this, args);
    try { host('boot', { game: this, Phaser }); } catch { /* the frame went away */ }
    return result;
  };
  Object.defineProperty(Phaser.Game.prototype, '__harnessPatched', { value: true });
}
