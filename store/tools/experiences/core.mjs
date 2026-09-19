// Shared deterministic primitives. Domain models use named streams so unrelated edits stay stable.
export function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function random(seed, stream = "main") {
  let a = hash(`${seed}:${stream}`);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const lerp = (a, b, t) => a + (b - a) * t;
export const pick = (items, rng) => items[Math.floor(rng() * items.length)];
export function normal(rng) {
  return (
    Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) *
    Math.cos(2 * Math.PI * rng())
  );
}
