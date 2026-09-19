#!/usr/bin/env node
// Compile dependency-free, editable single-file starters. No build is needed after installation.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const source = new URL("./experiences/", import.meta.url);
export const experiences = [
  {
    id: "generative-art",
    path: "sketch",
    title: "FIELDWORK — Generative Art",
    name: "FIELDWORK",
    glyph: "≋",
  },
  {
    id: "creative-direction",
    path: "board",
    title: "FORME — Creative Direction",
    name: "FORME",
    glyph: "F",
  },
  {
    id: "lab-bench",
    path: "bench",
    title: "SIGNAL — Lab Bench",
    name: "SIGNAL / LAB",
    glyph: "∿",
  },
  {
    id: "music-studio",
    path: "piece",
    title: "AFTERHOURS — Music Studio",
    name: "AFTERHOURS",
    glyph: "Ⅱ",
  },
  {
    id: "game-master",
    path: "game",
    title: "RELAY — Game Master",
    name: "RELAY / ARENA",
    glyph: "◇",
  },
  {
    id: "drone-pilot",
    path: "flight",
    title: "VECTOR — Drone Pilot",
    name: "VECTOR / FLIGHT",
    glyph: "↗",
  },
  {
    id: "voxel-worlds",
    path: "world",
    title: "TIDELANDS — Voxel Worlds",
    name: "TIDELANDS",
    glyph: "▧",
  },
];
export async function build({ check = false } = {}) {
  const read = (name) => readFile(new URL(name, source), "utf8");
  const [core, css, common, checker] = await Promise.all([
    read("core.mjs"),
    read("common.css"),
    read("common.js"),
    read("check-template.mjs"),
  ]);
  let drift = false;
  for (const exp of experiences) {
    const [model, style, body, app] = await Promise.all(
      ["mjs", "css", "html", "js"].map((ext) => read(`${exp.id}.${ext}`)),
    );
    const modelJS = [core, model]
      .join("\n")
      .replace(/^import .*?;\n/gm, "")
      .replace(/^export /gm, "");
    const appJS = [common, app].join("\n");
    if (/<\/script/i.test(modelJS + appJS))
      throw new Error(`${exp.id}: inline script closing tag in source`);
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light"><title>${exp.title}</title>
<!-- Built by store/tools/build-experiences.mjs. Edit this file freely in your workspace. -->
<style>${css}\n${style}</style></head><body>
<header class="masthead"><div class="identity"><span class="mark" aria-hidden="true">${exp.glyph}</span>${exp.name}</div>
<form class="seed-form" id="seed-form"><label for="seed">Seed</label><input id="seed" aria-label="Seed" maxlength="128" autocomplete="off" spellcheck="false"><button type="submit">Apply</button><button id="next-seed" type="button" title="Next seed">↗ Next</button></form></header>
${body}<div class="toast" id="toast" role="status"></div>
<script id="harness-model">\n'use strict';\n${modelJS}\n</script>
<script>\n'use strict';\n${appJS}\n</script></body></html>\n`;
    const out = new URL(
      `../agents/${exp.id}/template/${exp.path}/index.html`,
      import.meta.url,
    );
    if (check) {
      if ((await readFile(out, "utf8")) !== html) {
        console.error(`Out of date: ${fileURLToPath(out)}`);
        drift = true;
      }
    } else await writeFile(out, html);
    const checkDir = new URL(
      `../agents/${exp.id}/template/tools/`,
      import.meta.url,
    );
    const checkFile = new URL("check.mjs", checkDir);
    const checkSource = `const CONFIG = ${JSON.stringify({ id: exp.id, artifact: `${exp.path}/index.html` })};\n${checker}`;
    if (check) {
      if ((await readFile(checkFile, "utf8")) !== checkSource) {
        console.error(`Out of date: ${fileURLToPath(checkFile)}`);
        drift = true;
      }
    } else {
      await mkdir(checkDir, { recursive: true });
      await writeFile(checkFile, checkSource);
    }
  }
  if (drift) process.exitCode = 1;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await build({ check: process.argv.includes("--check") });
