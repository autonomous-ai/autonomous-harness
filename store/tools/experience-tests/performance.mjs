import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHtmlViewer } from "../../viewers/web-viewer/viewer.mjs";
import { experiences } from "../build-experiences.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(
  process.env.EXPERIENCE_OUTPUT || join(repo, "work/experience-evidence"),
);
await mkdir(output, { recursive: true });
const software = process.env.SOFTWARE_WEBGL === "1";
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  channel: process.env.BROWSER_EXECUTABLE ? undefined : "chrome",
  headless: true,
  args: software
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : [],
});
const percentile = (a, p) =>
  [...a].sort((x, y) => x - y)[
    Math.min(a.length - 1, Math.floor(a.length * p))
  ];
const results = [];
try {
  for (const exp of experiences) {
    const ws = await mkdtemp(join(tmpdir(), "experience-latency-"));
    await cp(join(repo, "store/agents", exp.id, "template"), ws, {
      recursive: true,
    });
    const server = await createHtmlViewer(ws);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`,
      artifact = exp.path + "/index.html",
      path = join(ws, artifact),
      source = await readFile(path, "utf8");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    try {
      const requests = [];
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        const res = await fetch(base + "/files/" + artifact);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.arrayBuffer();
        if (i >= 10) requests.push(performance.now() - start);
      }
      await page.goto(base + "/?file=" + encodeURIComponent(artifact));
      await page
        .frameLocator("#preview")
        .locator("body[data-ready=true]")
        .waitFor();
      const paints = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await writeFile(
          path,
          source.replace("<body>", `<body data-revision="${i}">`),
        );
        await page
          .frameLocator("#preview")
          .locator(`body[data-ready=true][data-revision="${i}"]`)
          .waitFor();
        const frame = page.frames().find((f) => f.url().includes("/files/"));
        await frame.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        paints.push(performance.now() - start);
      }
      const result = {
        name: exp.id,
        requestMedianMs: percentile(requests, 0.5),
        requestP95Ms: percentile(requests, 0.95),
        writeToPaintMedianMs: percentile(paints, 0.5),
        writeToPaintMaxMs: Math.max(...paints),
        paintSamples: paints,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await page.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await rm(ws, { recursive: true, force: true });
    }
  }
} finally {
  const version = browser.version();
  await browser.close();
  await writeFile(
    join(output, "performance.json"),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        browser: version,
        headless: true,
        softwareWebGL: software,
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
