import { random } from "./core.mjs";
export const directions = [
  {
    name: "Coastal modern",
    brand: "LOW TIDE",
    line: "Less noise. More horizon.",
    note: "Mineral tones, generous space and a quietly expressive serif. A direction for places you want to stay.",
    colors: ["#163f3c", "#f1ebd9", "#d16a3d", "#b4c8b0", "#d9bb8d"],
    type: "Georgia",
    mood: "Warm / deliberate / grounded",
  },
  {
    name: "Electric editorial",
    brand: "OFF HOURS",
    line: "For the hours that are yours.",
    note: "Acid yellow interrupts midnight ink. Dense typography and an oversized orbit turn every application into a signal.",
    colors: ["#1d2448", "#f2eee4", "#d5ef53", "#b3aff0", "#d85a43"],
    type: "Arial",
    mood: "Direct / restless / independent",
  },
  {
    name: "Botanical archive",
    brand: "FERN & FORM",
    line: "A slower kind of growth.",
    note: "Botanical silhouettes and archival paper meet deep wine. An old-world serif gives the living forms room to breathe.",
    colors: ["#4e2834", "#f0e7d5", "#a1b287", "#d5a093", "#b7af7e"],
    type: "Georgia",
    mood: "Organic / curious / considered",
  },
];
export function directionModel(seed, index, lockedColors) {
  const choice =
    index ?? Math.floor(random(seed, "direction")() * directions.length);
  return {
    ...directions[choice],
    colors: lockedColors ?? [...directions[choice].colors],
    index: choice,
    seed: String(seed),
    angle: random(seed, "layout")() * 80 - 40,
  };
}
export function luminance(hex) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
export function contrast(a, b) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function xml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}
export function brandSVG(model, brand = model.brand) {
  const [ink, paper, accent, secondary] = model.colors;
  const motif =
    model.index === 2
      ? Array.from(
          { length: 11 },
          (_, i) =>
            `<ellipse cx="${480 + Math.sin(i * 2.4) * 130}" cy="${190 + i * 39}" rx="125" ry="34" fill="${i % 2 ? accent : secondary}" transform="rotate(${i % 2 ? -35 : 35} ${480 + Math.sin(i * 2.4) * 130} ${190 + i * 39})"/>`,
        ).join("")
      : `<circle cx="520" cy="360" r="210" fill="${accent}"/>` +
        Array.from(
          { length: 18 },
          (_, i) =>
            `<ellipse cx="510" cy="390" rx="${80 + i * 9}" ry="${205 - i * 8}" fill="none" stroke="${model.index === 0 ? ink : secondary}" stroke-width="2" transform="rotate(${model.angle} 510 390)"/>`,
        ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 900"><rect width="800" height="900" fill="${paper}"/><text x="52" y="62" fill="${ink}" font-family="Arial,sans-serif" font-size="13" letter-spacing="5">INDEPENDENT BY NATURE / ${xml(model.seed.slice(0, 12))}</text>${motif}<text x="50" y="740" textLength="695" lengthAdjust="spacingAndGlyphs" fill="${ink}" font-family="${model.type},serif" font-size="88" font-weight="${model.index === 1 ? 700 : 400}">${xml(brand.slice(0, 28))}</text><line x1="52" y1="785" x2="748" y2="785" stroke="${ink}"/><text x="52" y="827" fill="${ink}" font-family="Arial,sans-serif" font-size="20">${xml(model.line)}</text><text x="52" y="864" fill="${ink}" font-family="monospace" font-size="10" letter-spacing="2">AN EXPLORATION BY FORME — ${xml(model.name.toUpperCase())}</text></svg>`;
}
