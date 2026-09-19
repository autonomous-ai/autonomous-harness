import { random, normal, clamp } from "./core.mjs";
export function experiment(seed, { count = 120, effect = 12, noise = 9 } = {}) {
  const xRng = random(seed, "temperature"),
    noiseRng = random(seed, "measurement");
  return Array.from({ length: count }, (_, i) => {
    const group = i % 2,
      x = 15 + xRng() * 70;
    return {
      id: i + 1,
      group,
      x,
      y: 28 + x * 0.48 + effect * group + normal(noiseRng) * noise,
    };
  });
}
export function stats(values) {
  const n = values.length,
    mean = n ? values.reduce((a, b) => a + b, 0) / n : 0;
  const variance =
    n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance, sd: Math.sqrt(variance) };
}
export function regression(points) {
  const x = stats(points.map((p) => p.x)),
    y = stats(points.map((p) => p.y));
  const xx = points.reduce((a, p) => a + (p.x - x.mean) ** 2, 0);
  const xy = points.reduce((a, p) => a + (p.x - x.mean) * (p.y - y.mean), 0);
  const slope = xx ? xy / xx : 0,
    intercept = y.mean - slope * x.mean;
  const ss = points.reduce((a, p) => a + (p.y - y.mean) ** 2, 0);
  const residual = points.reduce(
    (a, p) => a + (p.y - intercept - slope * p.x) ** 2,
    0,
  );
  return { slope, intercept, r2: ss ? clamp(1 - residual / ss, 0, 1) : 1 };
}
export function treatmentEffect(points) {
  const a = stats(points.filter((p) => p.group === 0).map((p) => p.y));
  const b = stats(points.filter((p) => p.group === 1).map((p) => p.y));
  const difference = b.mean - a.mean,
    se = Math.sqrt(
      a.variance / Math.max(1, a.n) + b.variance / Math.max(1, b.n),
    );
  return {
    a,
    b,
    difference,
    low: difference - 1.96 * se,
    high: difference + 1.96 * se,
  };
}
export function csvRows(points) {
  return (
    "sample,group,temperature_c,yield_percent\n" +
    points
      .map(
        (p) =>
          `${p.id},${p.group ? "treatment" : "control"},${p.x.toFixed(6)},${p.y.toFixed(6)}`,
      )
      .join("\n") +
    "\n"
  );
}
