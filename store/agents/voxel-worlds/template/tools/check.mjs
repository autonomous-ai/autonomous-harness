const CONFIG = {"id":"voxel-worlds","artifact":"world/index.html"};
// Compiled into each workspace's tools/check.mjs. Tests the model in the ACTUAL edited HTML.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { resolve, dirname } from "node:path";

const args = process.argv.slice(2),
  i = args.indexOf("--seeds");
const count = i === -1 ? 32 : Number(args[i + 1]);
if (!Number.isInteger(count) || count < 1 || count > 1000)
  throw new Error("--seeds must be an integer from 1 to 1000");
const artifact = resolve(CONFIG.artifact);
const html = await readFile(artifact, "utf8");
const script = html.match(
  /<script id="harness-model">([\s\S]*?)<\/script>/,
)?.[1];
if (!script)
  throw new Error(
    'Keep the pure model in <script id="harness-model"> so this checker can exercise the actual artifact.',
  );
const expressions = {
  "generative-art": `const m=artModel(SEED);const p=artPaths(m);({state:m,valid:p.length>0&&p.flat().every(([x,y])=>Number.isFinite(x)&&Number.isFinite(y)),metrics:{paths:p.length,palette:m.palette}})`,
  "creative-direction": `const m=directionModel(SEED);const ratio=contrast(m.colors[0],m.colors[1]);({state:m,valid:ratio>=4.5,metrics:{direction:m.name,contrast:ratio}})`,
  "lab-bench": `const p=experiment(SEED),e=treatmentEffect(p);({state:p,valid:p.length>1&&p.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))&&Number.isFinite(e.low)&&e.low<=e.high,metrics:{samples:p.length,effect:e.difference,interval:[e.low,e.high]}})`,
  "music-studio": `const s=musicScore(SEED),r=renderMusic(s);({state:Array.from(r.samples),valid:r.peak>.001&&r.peak<=.95&&r.samples.every(Number.isFinite),metrics:{seconds:r.duration,peak:r.peak,rms:r.rms}})`,
  "game-master": `const m=arenaMatch(SEED),s=m.history.at(-1);({state:m,valid:m.history.length>1&&m.history.length<=10000&&s.units.every(u=>u.hp>=0&&u.x>=0&&u.x<m.map.w&&u.y>=0&&u.y<m.map.h),metrics:{turns:s.turn,score:s.score,winner:m.winner}})`,
  "drone-pilot": `const s=flyAutopilot(SEED);({state:s,valid:s.finished&&!s.crashed&&s.passed===flightCourse(SEED).length,metrics:{seconds:s.time,passed:s.passed,missed:s.missed}})`,
  "voxel-worlds": `const w=voxelWorld(SEED);let p={...w.spawn,vy:0,grounded:true};const clear=playerFits(w,p.x,p.y,p.z);for(let t=0;t<120;t++)p=movePlayer(w,p,{forward:1});({state:Array.from(w.blocks),valid:clear&&playerFits(w,p.x,p.y,p.z),metrics:{blocks:w.blocks.filter(Boolean).length,walkDistance:Math.hypot(p.x-w.spawn.x,p.z-w.spawn.z)}})`,
};
const expression = expressions[CONFIG.id];
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const results = [];
for (let seed = 0; seed < count; seed++) {
  const run = () =>
    vm.runInNewContext(
      `${script}\n${expression}`,
      { SEED: String(seed) },
      { timeout: 10000 },
    );
  try {
    const first = run(),
      second = run(),
      signature = digest(first.state),
      repeat = digest(second.state);
    results.push({
      seed,
      ok: first.valid && signature === repeat,
      signature,
      metrics: first.metrics,
    });
  } catch (error) {
    results.push({ seed, ok: false, error: error.message });
  }
}
const passed = results.filter((r) => r.ok).length;
const report = {
  spec: 1,
  harness: CONFIG.id,
  artifact: CONFIG.artifact,
  checkedAt: new Date().toISOString(),
  modelChecks: { passed, total: count },
  scope:
    "Pure model invariants and same-process repeatability. Browser interaction, layout, listening and export review still required.",
  results,
};
const out = resolve(".harness/model-check.json");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + "\n");
console.log(
  `${CONFIG.id}: ${passed}/${count} model checks passed. Report: ${out}`,
);
console.log(report.scope);
if (passed !== count) process.exitCode = 1;
