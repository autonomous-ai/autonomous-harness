import { random, clamp, lerp } from "./core.mjs";
export function flightCourse(seed, count = 12) {
  const r = random(seed, "gates"),
    phase = r() * 6.28;
  return Array.from({ length: count }, (_, i) => ({
    x: Math.sin(i * 0.62 + phase) * 17,
    y: 13 + Math.sin(i * 0.85 + phase) * 5,
    z: 45 + i * 42,
    radius: 6,
    index: i,
  }));
}
export function flightStart() {
  return {
    x: 0,
    y: 13,
    z: 0,
    vx: 0,
    vy: 0,
    speed: 22,
    next: 0,
    passed: 0,
    missed: 0,
    steps: 0,
    time: 0,
    finished: false,
    crashed: false,
  };
}
export function flightStep(state, course, input = {}, dt = 1 / 60) {
  const s = { ...state };
  if (s.finished || s.crashed) return s;
  const target = course[Math.min(s.next, course.length - 1)];
  const auto = input.autopilot !== false;
  const desiredX = auto
    ? clamp((target.x - s.x) * 2, -15, 15)
    : (input.x || 0) * 14;
  const desiredY = auto
    ? clamp((target.y - s.y) * 2, -10, 10)
    : (input.y || 0) * 10;
  s.vx = lerp(s.vx, desiredX, 1 - Math.exp(-dt * 4));
  s.vy = lerp(s.vy, desiredY, 1 - Math.exp(-dt * 4));
  s.speed = lerp(
    s.speed,
    input.brake ? 7 : input.boost ? 34 : 22,
    1 - Math.exp(-dt * 3),
  );
  s.x = clamp(s.x + s.vx * dt, -65, 65);
  s.y += s.vy * dt;
  s.z += s.speed * dt;
  s.steps++;
  s.time = s.steps / 60;
  if (s.y < 1.5) {
    s.crashed = true;
    s.y = 1.5;
    return s;
  }
  s.y = Math.min(48, s.y);
  if (s.next < course.length && s.z >= target.z) {
    if (Math.hypot(s.x - target.x, s.y - target.y) <= target.radius) s.passed++;
    else s.missed++;
    s.next++;
  }
  if (s.z >= course.at(-1).z + 25) s.finished = true;
  return s;
}
export function flyAutopilot(seed) {
  const course = flightCourse(seed);
  let state = flightStart();
  for (let i = 0; i < 6000 && !state.finished && !state.crashed; i++)
    state = flightStep(state, course);
  return state;
}
