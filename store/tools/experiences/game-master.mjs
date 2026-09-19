import { random } from "./core.mjs";
export const arenaSize = { w: 11, h: 9 };
export function arenaMap(seed) {
  const r = random(seed, "terrain"),
    walls = [];
  for (let y = 1; y < 8; y++)
    if (y !== 4 && r() > 0.48) {
      walls.push([3, y], [7, 8 - y]);
    }
  return {
    ...arenaSize,
    walls,
    relays: [
      { x: 5, y: 1, name: "NORTH" },
      { x: 5, y: 4, name: "CORE" },
      { x: 5, y: 7, name: "SOUTH" },
    ],
  };
}
export function arenaPath(map, from, target, occupied = []) {
  const blocked = new Set(
    [...map.walls, ...occupied].map(([x, y]) => `${x},${y}`),
  );
  blocked.delete(`${target.x},${target.y}`);
  const queue = [{ x: from.x, y: from.y, path: [] }],
    seen = new Set([`${from.x},${from.y}`]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (p.x === target.x && p.y === target.y) return p.path;
    for (const [dx, dy] of [
      [1, 0],
      [0, -1],
      [-1, 0],
      [0, 1],
    ]) {
      const x = p.x + dx,
        y = p.y + dy,
        key = `${x},${y}`;
      if (
        x < 0 ||
        y < 0 ||
        x >= map.w ||
        y >= map.h ||
        seen.has(key) ||
        blocked.has(key)
      )
        continue;
      seen.add(key);
      queue.push({ x, y, path: [...p.path, { x, y }] });
    }
  }
  return [];
}
export function arenaMatch(
  seed,
  { coral = "control", teal = "hunt", rounds = 72 } = {},
) {
  const map = arenaMap(seed),
    rng = random(seed, "decisions"),
    units = [];
  for (let team = 0; team < 2; team++)
    for (let i = 0; i < 3; i++)
      units.push({
        id: team * 3 + i,
        team,
        x: team ? 10 : 0,
        y: 2 + i * 2,
        hp: 3,
        wait: 0,
      });
  let score = [0, 0],
    owners = [-1, -1, -1];
  const history = [];
  const snapshot = (turn, log) => ({
    turn,
    score: [...score],
    owners: [...owners],
    units: units.map((u) => ({ ...u })),
    log,
  });
  history.push(
    snapshot(0, ["Three relays. Seventy-two turns. Hold ground to score."]),
  );
  for (let turn = 1; turn <= rounds; turn++) {
    const log = [];
    const order = turn % 2 ? [0, 3, 1, 4, 2, 5] : [3, 0, 4, 1, 5, 2];
    for (const index of order) {
      const u = units[index];
      if (u.wait) {
        u.wait--;
        if (!u.wait) {
          u.hp = 3;
          u.x = u.team ? 10 : 0;
          u.y = 2 + (u.id % 3) * 2;
        }
        continue;
      }
      const opponents = units.filter((v) => v.team !== u.team && !v.wait),
        adjacent = opponents.find(
          (v) => Math.abs(v.x - u.x) + Math.abs(v.y - u.y) === 1,
        );
      const name = u.team ? "Tide" : "Ember";
      if (adjacent) {
        adjacent.hp--;
        log.push(
          `${name} ${(u.id % 3) + 1} tags ${adjacent.team ? "Tide" : "Ember"} ${(adjacent.id % 3) + 1}.`,
        );
        if (adjacent.hp === 0) {
          adjacent.wait = 3;
          score[u.team] += 2;
          log.push(`${name} scores a knockout (+2).`);
        }
        continue;
      }
      const policy = u.team ? teal : coral;
      const occupied = units
        .filter((v) => v !== u && !v.wait)
        .map((v) => [v.x, v.y]);
      let target;
      const onRelay = map.relays.findIndex((r) => r.x === u.x && r.y === u.y);
      if (onRelay !== -1 && policy === "control") {
        log.push(
          `${name} ${(u.id % 3) + 1} holds ${map.relays[onRelay].name}.`,
        );
        continue;
      }
      if (policy === "hunt" && opponents.length && rng() < 0.56)
        target = [...opponents].sort(
          (a, b) =>
            Math.abs(a.x - u.x) +
            Math.abs(a.y - u.y) -
            (Math.abs(b.x - u.x) + Math.abs(b.y - u.y)),
        )[0];
      else {
        const candidates = map.relays.map((r, i) => ({
          ...r,
          index: i,
          cost:
            Math.abs(r.x - u.x) +
            Math.abs(r.y - u.y) +
            (owners[i] === u.team ? 7 : 0) +
            rng() * 2,
        }));
        target = candidates.sort((a, b) => a.cost - b.cost)[0];
      }
      const path = arenaPath(map, u, target, occupied);
      const next = path[0];
      if (next && !occupied.some(([x, y]) => x === next.x && y === next.y)) {
        u.x = next.x;
        u.y = next.y;
        log.push(
          `${name} ${(u.id % 3) + 1} → ${target.name || "opponent"} (${policy}).`,
        );
      }
    }
    owners = map.relays.map((r) => {
      const u = units.find((u) => !u.wait && u.x === r.x && u.y === r.y);
      return u ? u.team : -1;
    });
    owners.forEach((owner) => {
      if (owner !== -1) score[owner]++;
    });
    history.push(snapshot(turn, log.slice(-6)));
  }
  return {
    seed: String(seed),
    map,
    policies: { coral, teal },
    history,
    winner: score[0] === score[1] ? -1 : score[0] > score[1] ? 0 : 1,
  };
}
export function arenaTournament(seed, options, count = 32) {
  const wins = [0, 0, 0];
  let margins = 0;
  for (let i = 0; i < count; i++) {
    const match = arenaMatch(`${seed}/match/${i}`, options);
    wins[match.winner === -1 ? 2 : match.winner]++;
    const last = match.history.at(-1);
    margins += last.score[0] - last.score[1];
  }
  return {
    count,
    ember: wins[0],
    tide: wins[1],
    draws: wins[2],
    meanMargin: margins / count,
  };
}
