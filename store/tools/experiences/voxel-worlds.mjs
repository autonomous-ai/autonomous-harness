import { random, clamp } from "./core.mjs";
export const blockTypes = [
  null,
  { name: "Grass", color: [0.4, 0.58, 0.31] },
  { name: "Earth", color: [0.48, 0.34, 0.23] },
  { name: "Stone", color: [0.51, 0.55, 0.53] },
  { name: "Sand", color: [0.81, 0.74, 0.54] },
  { name: "Timber", color: [0.43, 0.29, 0.17] },
  { name: "Canopy", color: [0.25, 0.47, 0.27] },
  { name: "Water", color: [0.24, 0.52, 0.59] },
  { name: "Cedar", color: [0.68, 0.46, 0.28] },
  { name: "Lantern", color: [1, 0.74, 0.32] },
];
export function blockAt(world, x, y, z) {
  if (x < 0 || y < 0 || z < 0 || x >= world.w || y >= world.h || z >= world.d)
    return 0;
  return world.blocks[(y * world.d + z) * world.w + x];
}
export function putBlock(world, x, y, z, id) {
  if (x < 0 || y < 0 || z < 0 || x >= world.w || y >= world.h || z >= world.d)
    return false;
  world.blocks[(y * world.d + z) * world.w + x] = id;
  return true;
}
export function solidBlock(id) {
  return id !== 0 && id !== 7;
}
export function groundAt(world, x, z) {
  for (let y = world.h - 1; y >= 0; y--)
    if (solidBlock(blockAt(world, Math.floor(x), y, Math.floor(z))))
      return y + 1;
  return 0;
}
export function voxelWorld(seed) {
  const world = {
      seed: String(seed),
      w: 48,
      h: 28,
      d: 48,
      blocks: new Uint8Array(48 * 28 * 48),
    },
    r = random(seed, "terrain"),
    phase = r() * 6.28,
    phase2 = r() * 6.28;
  for (let z = 0; z < world.d; z++)
    for (let x = 0; x < world.w; x++) {
      const radius = Math.hypot((x - 24) / 25, (z - 24) / 26);
      let height = clamp(
        Math.floor(
          5 +
            (1 - radius) * 9 +
            Math.sin(x * 0.23 + phase) * 1.6 +
            Math.cos(z * 0.24 + phase2) * 1.6,
        ),
        2,
        15,
      );
      if (z > 16 && Math.abs(x - (22 + Math.sin(z * 0.2) * 3)) < 1.6)
        height = Math.min(height, 5);
      for (let y = 0; y < Math.max(height, 6); y++)
        putBlock(
          world,
          x,
          y,
          z,
          y >= height
            ? 7
            : y === height - 1
              ? height < 8
                ? 4
                : 1
              : y > height - 4
                ? 2
                : 3,
        );
    }
  const pad = (cx, cz, radius, height) => {
    for (let z = cz - radius; z <= cz + radius; z++)
      for (let x = cx - radius; x <= cx + radius; x++)
        for (let y = 0; y < world.h; y++)
          putBlock(world, x, y, z, y < height ? (y === height - 1 ? 1 : 2) : 0);
  };
  const spawnHeight = Math.max(8, groundAt(world, 31, 35));
  pad(31, 35, 3, spawnHeight);
  const hutHeight = Math.max(8, groundAt(world, 31, 25));
  pad(31, 25, 4, hutHeight);
  for (let x = 28; x <= 34; x++)
    for (let z = 22; z <= 27; z++) {
      putBlock(world, x, hutHeight, z, 8);
      for (let y = 1; y <= 3; y++)
        if (
          (x === 28 || x === 34 || z === 22 || z === 27) &&
          !(z === 27 && x === 31 && y <= 2) &&
          !((x === 28 || x === 34) && z === 24 && y === 2)
        )
          putBlock(world, x, hutHeight + y, z, 5);
      putBlock(world, x, hutHeight + 4, z, 8);
      if (x > 28 && x < 34) putBlock(world, x, hutHeight + 5, z, 8);
    }
  putBlock(world, 30, hutHeight + 3, 26, 9);
  const towerHeight = groundAt(world, 14, 16);
  for (let y = towerHeight; y < towerHeight + 7; y++)
    for (let x = 13; x <= 15; x++)
      for (let z = 15; z <= 17; z++)
        putBlock(world, x, y, z, y === towerHeight + 6 ? 9 : 4);
  // A graded three-block-wide trail connects the cabin floor to the shore.
  for (let z = 28; z <= 37; z++)
    for (let x = 30; x <= 32; x++) {
      const height = Math.round(
        hutHeight + 1 + ((spawnHeight - hutHeight - 1) * (z - 28)) / 9,
      );
      for (let y = 0; y < world.h; y++)
        putBlock(world, x, y, z, y < height ? (y === height - 1 ? 4 : 2) : 0);
    }
  const trees = random(seed, "trees");
  for (let i = 0; i < 65; i++) {
    const x = 3 + Math.floor(trees() * 42),
      z = 3 + Math.floor(trees() * 42),
      y = groundAt(world, x, z);
    if (
      y < 8 ||
      y > 15 ||
      blockAt(world, x, y - 1, z) !== 1 ||
      (x > 26 && x < 37 && z > 19)
    )
      continue;
    for (let j = 0; j < 4; j++) putBlock(world, x, y + j, z, 5);
    for (let dy = 2; dy <= 5; dy++)
      for (let dx = -2; dx <= 2; dx++)
        for (let dz = -2; dz <= 2; dz++)
          if (
            Math.abs(dx) + Math.abs(dz) + (dy === 5 ? 1 : 0) < 4 &&
            blockAt(world, x + dx, y + dy, z + dz) === 0
          )
            putBlock(world, x + dx, y + dy, z + dz, 6);
  }
  world.spawn = {
    x: 31.5,
    y: groundAt(world, 31, 29) + 0.03,
    z: 29.5,
    yaw: -0.65,
    pitch: -0.18,
  };
  return world;
}
export function raycastWorld(world, origin, direction, max = 7) {
  let previous;
  for (let d = 0; d <= max; d += 0.035) {
    const p = {
      x: Math.floor(origin.x + direction.x * d),
      y: Math.floor(origin.y + direction.y * d),
      z: Math.floor(origin.z + direction.z * d),
    };
    const id = blockAt(world, p.x, p.y, p.z);
    if (solidBlock(id)) return { ...p, id, previous, distance: d };
    previous = p;
  }
  return null;
}
export function playerFits(world, x, y, z) {
  for (const dx of [-0.24, 0.24])
    for (const dz of [-0.24, 0.24])
      for (const dy of [0.001, 0.85, 1.65])
        if (
          solidBlock(
            blockAt(
              world,
              Math.floor(x + dx),
              Math.floor(y + dy),
              Math.floor(z + dz),
            ),
          )
        )
          return false;
  return true;
}
export function movePlayer(world, player, input, dt = 1 / 60) {
  const p = { ...player };
  const speed = input.sprint ? 6 : 3.8;
  let dx =
      Math.sin(p.yaw) * (input.forward || 0) +
      Math.cos(p.yaw) * (input.right || 0),
    dz =
      Math.cos(p.yaw) * (input.forward || 0) -
      Math.sin(p.yaw) * (input.right || 0);
  const length = Math.max(1, Math.hypot(dx, dz));
  dx = (dx / length) * speed * dt;
  dz = (dz / length) * speed * dt;
  const swimming =
    blockAt(world, Math.floor(p.x), Math.floor(p.y + 0.3), Math.floor(p.z)) ===
    7;
  for (const [axis, delta] of [
    ["x", dx],
    ["z", dz],
  ]) {
    const n = clamp(
        p[axis] + delta,
        0.3,
        (axis === "x" ? world.w : world.d) - 0.3,
      ),
      x = axis === "x" ? n : p.x,
      z = axis === "z" ? n : p.z;
    if (playerFits(world, x, p.y, z)) p[axis] = n;
    else if (
      (p.grounded || swimming) &&
      playerFits(world, x, p.y + (swimming ? 1.3 : 1.05), z)
    ) {
      p[axis] = n;
      p.y += swimming ? 1.3 : 1.05;
    }
  }
  if (input.jump && (p.grounded || swimming)) p.vy = 6;
  p.vy = (p.vy || 0) - 16 * dt;
  if (swimming && p.y < 5.85) p.vy = Math.max(p.vy, (5.85 - p.y) * 5);
  const nextY = p.y + p.vy * dt;
  if (playerFits(world, p.x, nextY, p.z)) {
    p.y = nextY;
    p.grounded = false;
  } else {
    if (p.vy < 0) {
      p.grounded = true;
      p.y = Math.ceil(nextY);
    }
    p.vy = 0;
  }
  if (p.y < 0) {
    Object.assign(p, world.spawn, { vy: 0, grounded: true });
  }
  return p;
}

export function importWorld(value) {
  if (
    !value ||
    value.format !== "tidelands-1" ||
    JSON.stringify(value.size) !== "[48,28,48]" ||
    !Array.isArray(value.blocks) ||
    value.blocks.length !== 48 * 28 * 48 ||
    !value.blocks.every(
      (n) => Number.isInteger(n) && n >= 0 && n < blockTypes.length,
    )
  )
    throw new Error("This file is not a valid Tidelands world.");
  const world = {
    seed: String(value.seed).slice(0, 128),
    w: 48,
    h: 28,
    d: 48,
    blocks: Uint8Array.from(value.blocks),
  };
  const p = value.player;
  if (
    !p ||
    !["x", "y", "z", "yaw", "pitch"].every((k) => Number.isFinite(p[k])) ||
    p.x < 0.3 ||
    p.x > 47.7 ||
    p.z < 0.3 ||
    p.z > 47.7 ||
    p.y < 0 ||
    p.y > 28 ||
    !playerFits(world, p.x, p.y, p.z)
  )
    throw new Error("The saved player position is invalid.");
  world.spawn = {
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: clamp(p.pitch, -1.3, 1.3),
  };
  return {
    world,
    player: { ...world.spawn, vy: 0, grounded: false },
    timeOfDay: Number.isFinite(value.timeOfDay)
      ? clamp(value.timeOfDay, 0, 1)
      : 0.32,
  };
}
