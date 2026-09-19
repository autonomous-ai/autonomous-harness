import { random } from "./core.mjs";
export const artPalettes = [
  {
    name: "Estuary",
    paper: "#f1ecdf",
    colors: ["#203c36", "#527863", "#9cab86", "#d87746", "#e2b65f"],
  },
  {
    name: "Ultramarine",
    paper: "#efebe2",
    colors: ["#132d6c", "#355bb5", "#6e99b3", "#e24f32", "#d59b75"],
  },
  {
    name: "After the rain",
    paper: "#e9e6ee",
    colors: ["#332852", "#79658d", "#ac8992", "#cf805c", "#354d52"],
  },
  {
    name: "Ember",
    paper: "#201e23",
    colors: ["#edbe7f", "#e67a53", "#ad4248", "#69787b", "#ad9a83"],
  },
];
export function artModel(
  seed,
  { density = 120, curl = 55, mode = "contours", palette } = {},
) {
  const rnd = random(seed, "composition");
  return {
    seed: String(seed),
    density,
    curl,
    mode,
    palette:
      palette ?? Math.floor(random(seed, "palette")() * artPalettes.length),
    phases: Array.from({ length: 5 }, () => rnd() * Math.PI * 2),
    frequency: 1.4 + rnd() * 1.8,
    tilt: (rnd() - 0.5) * 0.22,
  };
}
export function artPaths(model) {
  const { density, curl, phases: p, frequency: f, mode } = model;
  const paths = [];
  for (let i = 0; i < density; i++) {
    const u = i / (density - 1),
      path = [];
    for (let j = 0; j <= 140; j++) {
      const v = j / 140;
      if (mode === "orbits") {
        const theta = v * Math.PI * 2;
        const radius =
          50 + u * 385 + Math.sin(theta * 3 + p[0]) * (curl * 0.6) * u;
        path.push([
          500 + Math.cos(theta) * radius,
          580 + Math.sin(theta) * radius * 1.25,
        ]);
      } else {
        const wave =
          Math.sin(v * f * Math.PI + p[0] + u * 2.6) * Math.sin(u * Math.PI);
        const wave2 =
          Math.cos(v * Math.PI * 3 + p[1]) * Math.sin(u * Math.PI) * 0.27;
        if (mode === "dunes")
          path.push([
            70 + v * 860,
            170 + u * 890 + (wave + wave2) * curl * 2.1,
          ]);
        else
          path.push([
            80 + u * 840 + (wave + wave2) * curl * 2.2,
            80 + v * 1070 + (u - 0.5) * model.tilt * 400,
          ]);
      }
    }
    paths.push(path);
  }
  return paths;
}
