import assert from "node:assert/strict";
import { test } from "node:test";
import { random, hash, normal, clamp, lerp } from "../experiences/core.mjs";
import { artModel, artPaths } from "../experiences/generative-art.mjs";
import {
  directions,
  directionModel,
  contrast,
  brandSVG,
} from "../experiences/creative-direction.mjs";
import {
  experiment,
  stats,
  regression,
  treatmentEffect,
  csvRows,
} from "../experiences/lab-bench.mjs";
import {
  musicScore,
  scoreEvents,
  renderMusic,
  wavFile,
} from "../experiences/music-studio.mjs";
import {
  arenaMap,
  arenaPath,
  arenaMatch,
  arenaTournament,
} from "../experiences/game-master.mjs";
import {
  flightCourse,
  flightStart,
  flightStep,
  flyAutopilot,
} from "../experiences/drone-pilot.mjs";
import {
  voxelWorld,
  blockAt,
  putBlock,
  solidBlock,
  groundAt,
  raycastWorld,
  playerFits,
  movePlayer,
  importWorld,
} from "../experiences/voxel-worlds.mjs";

test("named random streams repeat exactly and remain independent", () => {
  const a = random("42", "a"),
    b = random("42", "a"),
    c = random("42", "b");
  const aa = Array.from({ length: 100 }, a);
  assert.deepEqual(aa, Array.from({ length: 100 }, b));
  assert.notDeepEqual(aa, Array.from({ length: 100 }, c));
  assert.ok(aa.every((x) => x >= 0 && x < 1));
  assert.equal(hash("42"), hash("42"));
  assert.ok(Number.isFinite(normal(random("n"))));
  assert.equal(clamp(10, 0, 5), 5);
  assert.equal(lerp(0, 10, 0.5), 5);
});
test("art census: 100 seeds, three techniques, bounded finite geometry, identical re-render inputs", () => {
  const signatures = new Set();
  for (let seed = 0; seed < 100; seed++)
    for (const mode of ["contours", "dunes", "orbits"]) {
      const m = artModel(seed, { mode }),
        paths = artPaths(m);
      assert.deepEqual(m, artModel(seed, { mode }));
      assert.equal(paths.length, 120);
      assert.ok(
        paths
          .flat()
          .every(
            ([x, y]) =>
              Number.isFinite(x) &&
              Number.isFinite(y) &&
              x > -500 &&
              x < 1500 &&
              y > -500 &&
              y < 1700,
          ),
      );
      signatures.add(JSON.stringify(m.phases));
    }
  assert.equal(signatures.size, 100);
});
test("brand directions have readable ink, reproducible layouts, palette locks and escaped SVG text", () => {
  for (const d of directions)
    assert.ok(contrast(d.colors[0], d.colors[1]) >= 7, d.name);
  assert.equal(contrast("#000000", "#ffffff"), 21);
  for (let seed = 0; seed < 100; seed++)
    assert.deepEqual(directionModel(seed), directionModel(seed));
  const m = directionModel(2, 1, ["#000000", "#ffffff", "#ff0000", "#00ff00"]);
  assert.equal(m.index, 1);
  assert.equal(m.colors[0], "#000000");
  assert.match(
    brandSVG(m, '<script> & "test"'),
    /&lt;script&gt; &amp; &quot;test&quot;/,
  );
  assert.doesNotMatch(brandSVG(m, "<script>"), /<script>/);
  assert.match(brandSVG(directionModel(1, 2)), /<ellipse/);
});
test("bench statistics are computed from the data, including exact known fits", () => {
  assert.deepEqual(stats([]), { n: 0, mean: 0, variance: 0, sd: 0 });
  assert.equal(stats([1, 2, 3]).variance, 1);
  const fit = regression([
    { x: 0, y: 2 },
    { x: 1, y: 5 },
    { x: 2, y: 8 },
  ]);
  assert.equal(fit.slope, 3);
  assert.equal(fit.intercept, 2);
  assert.equal(fit.r2, 1);
  assert.deepEqual(regression([]), { slope: 0, intercept: 0, r2: 1 });
  const p = [
    { group: 0, x: 0, y: 1 },
    { group: 0, x: 1, y: 3 },
    { group: 1, x: 0, y: 5 },
    { group: 1, x: 1, y: 7 },
  ];
  const e = treatmentEffect(p);
  assert.equal(e.difference, 4);
  assert.ok(e.low < 4 && e.high > 4);
  for (let seed = 0; seed < 100; seed++) {
    const points = experiment(seed);
    assert.deepEqual(points, experiment(seed));
    assert.equal(points.filter((p) => p.group === 0).length, 60);
    assert.ok(points.every((p) => Number.isFinite(p.y)));
  }
  const baseline = experiment(12, { effect: 0 }),
    effect = experiment(12, { effect: 20 });
  for (let i = 0; i < baseline.length; i++)
    assert.ok(
      Math.abs(effect[i].y - baseline[i].y - (baseline[i].group ? 20 : 0)) <
        1e-10,
    );
  assert.equal(csvRows(experiment(1)).trim().split("\n").length, 121);
});
test("music score is repeatable, finite, musical events are in bounds and edits affect the score", () => {
  for (let seed = 0; seed < 100; seed++) {
    const s = musicScore(seed),
      r = scoreEvents(s);
    assert.deepEqual(s, musicScore(seed));
    for (let track = 0; track < 5; track++)
      assert.ok(
        r.events.some((e) => e.track === track),
        `seed ${seed}, track ${track}`,
      );
    assert.ok(
      r.events.every(
        (e) => e.time >= 0 && e.time < r.duration && e.note > 0 && e.note < 128,
      ),
    );
  }
  const s = musicScore(1),
    muted = scoreEvents(s, { muted: [true, true, true, true, true] });
  assert.equal(muted.events.length, 0);
});
test("audio census: 16 full arrangements have signal, headroom and exact same-seed PCM; WAV header is valid", () => {
  for (let seed = 0; seed < 16; seed++) {
    const rendered = renderMusic(musicScore(seed));
    assert.ok(rendered.peak > 0.1 && rendered.peak <= 0.9);
    assert.ok(rendered.rms > 0.005);
    assert.ok(rendered.samples.every(Number.isFinite));
  }
  const a = renderMusic(musicScore(42)),
    b = renderMusic(musicScore(42));
  assert.deepEqual(a.samples, b.samples);
  const bytes = wavFile(a.samples, a.sampleRate),
    view = new DataView(bytes);
  assert.equal(view.getUint32(24, true), 22050);
  assert.equal(view.getUint32(40, true), a.samples.length * 2);
  assert.equal(bytes.byteLength, 44 + a.samples.length * 2);
});
test("arena census: 100 maps finish with legal positions, consistent scoring and exact replays", () => {
  for (let seed = 0; seed < 100; seed++) {
    const m = arenaMatch(seed);
    assert.equal(m.history.length, 73);
    assert.deepEqual(m, arenaMatch(seed));
    for (const state of m.history) {
      assert.ok(state.score.every((n) => Number.isInteger(n) && n >= 0));
      assert.ok(
        state.units.every(
          (u) =>
            u.x >= 0 &&
            u.x < 11 &&
            u.y >= 0 &&
            u.y < 9 &&
            u.hp >= 0 &&
            u.hp <= 3 &&
            !m.map.walls.some(([x, y]) => u.x === x && u.y === y),
        ),
      );
    }
    for (const r of m.map.relays)
      assert.ok(arenaPath(m.map, { x: 0, y: 4 }, r).length > 0);
  }
  assert.deepEqual(
    arenaPath(
      {
        ...arenaMap(1),
        walls: [
          [1, 0],
          [0, 1],
        ],
      },
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    ),
    [],
  );
  const t = arenaTournament(42, { coral: "hunt", teal: "control" });
  assert.equal(t.ember + t.tide + t.draws, 32);
});
test("drone census: autopilot clears all 12 gates on 100 seeds with a finite, repeatable fixed-step flight", () => {
  for (let seed = 0; seed < 100; seed++) {
    const s = flyAutopilot(seed);
    assert.ok(s.finished, `seed ${seed}`);
    assert.equal(s.passed, 12, `seed ${seed}`);
    assert.equal(s.missed, 0);
    assert.equal(s.crashed, false);
    assert.deepEqual(s, flyAutopilot(seed));
  }
});
test("manual drone input steers, braking slows, ground impact terminates and misses are counted", () => {
  const c = flightCourse(42);
  let s = flightStart();
  for (let i = 0; i < 120; i++)
    s = flightStep(s, c, { autopilot: false, x: 1, y: 0, brake: true });
  assert.ok(s.x > 10 && s.speed < 8);
  for (let i = 0; i < 300 && !s.crashed; i++)
    s = flightStep(s, c, { autopilot: false, y: -1 });
  assert.ok(s.crashed);
  assert.deepEqual(flightStep(s, c), s);
  s = flightStart();
  for (let i = 0; i < 400; i++)
    s = flightStep(s, c, { autopilot: false, x: 1 });
  assert.ok(s.missed > 0);
});
test("voxel census: 32 worlds are deterministic, spawn clear and can be walked without entering solid blocks", () => {
  for (let seed = 0; seed < 32; seed++) {
    const w = voxelWorld(seed);
    assert.deepEqual(w.blocks, voxelWorld(seed).blocks);
    let p = { ...w.spawn, vy: 0, grounded: true };
    assert.ok(playerFits(w, p.x, p.y, p.z), `spawn ${seed}`);
    const start = { ...p };
    for (let i = 0; i < 100; i++) {
      p = movePlayer(w, p, { forward: 1 });
      assert.ok(playerFits(w, p.x, p.y, p.z), `walk ${seed}, ${i}`);
    }
    assert.ok(
      Math.hypot(start.x - p.x, start.z - p.z) > 0.5,
      `movement ${seed}`,
    );
  }
});
test("voxel targeting and edits use real blocks; jump and world bounds hold", () => {
  const w = { w: 10, h: 10, d: 10, blocks: new Uint8Array(1000) };
  for (let x = 0; x < 10; x++)
    for (let z = 0; z < 10; z++) putBlock(w, x, 0, z, 3);
  assert.equal(groundAt(w, 5, 5), 1);
  assert.equal(groundAt(w, 30, 30), 0);
  assert.equal(blockAt(w, -1, 0, 0), 0);
  assert.equal(putBlock(w, 50, 50, 50, 3), false);
  assert.equal(solidBlock(7), false);
  putBlock(w, 5, 2, 5, 8);
  const hit = raycastWorld(w, { x: 5.5, y: 2.5, z: 8 }, { x: 0, y: 0, z: -1 });
  assert.equal(hit.id, 8);
  assert.deepEqual(hit.previous, { x: 5, y: 2, z: 6 });
  putBlock(w, hit.x, hit.y, hit.z, 0);
  assert.equal(
    raycastWorld(w, { x: 5.5, y: 2.5, z: 8 }, { x: 0, y: 0, z: -1 }),
    null,
  );
  let p = { x: 3, y: 1, z: 3, yaw: 0, vy: 0, grounded: true };
  p = movePlayer(w, p, { jump: true });
  assert.ok(p.y > 1);
  for (let i = 0; i < 240; i++) p = movePlayer(w, p, { forward: 1 });
  assert.ok(p.z < 10);
  assert.ok(Math.abs(p.y - 1) < 0.01);
});

test("saved worlds restore exact blocks and reject corrupt imports", () => {
  const w = voxelWorld("save");
  const data = {
    format: "tidelands-1",
    seed: w.seed,
    size: [48, 28, 48],
    blocks: Array.from(w.blocks),
    player: w.spawn,
    timeOfDay: 0.3,
  };
  const restored = importWorld(data);
  assert.deepEqual(restored.world.blocks, w.blocks);
  assert.deepEqual(restored.world.spawn, w.spawn);
  assert.equal(restored.timeOfDay, 0.3);
  assert.throws(() => importWorld({ ...data, blocks: [999] }));
  assert.throws(() => importWorld({ ...data, player: { ...w.spawn, y: -1 } }));
  assert.throws(() => importWorld(null));
});
