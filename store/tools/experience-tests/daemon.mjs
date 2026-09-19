// Optional integration check against a running local Harness daemon. No prompts are sent.
// HARNESS_MACHINE_ID=<local machine id> node store/tools/experience-tests/daemon.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { experiences } from "../build-experiences.mjs";

const machineId = process.env.HARNESS_MACHINE_ID;
if (!machineId)
  throw new Error(
    "Set HARNESS_MACHINE_ID to the local machine registered with Harness.",
  );
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(
  process.env.EXPERIENCE_OUTPUT || join(repo, "work/experience-evidence"),
);
await mkdir(output, { recursive: true });
const socket = new WebSocket("ws://127.0.0.1:18473/api/local-ws");
const pending = new Map(),
  frames = [],
  results = [];
function waitFor(label, predicate, timeout = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - start > timeout)
        return reject(new Error("Timed out: " + label));
      setTimeout(tick, 100);
    };
    tick();
  });
}
function send(type, payload) {
  socket.send(JSON.stringify({ type, payload }));
}
function request(type, payload, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const requestId = randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(type + " timed out"));
    }, timeout);
    pending.set(requestId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    send(type, { ...payload, requestId });
  });
}
socket.addEventListener("message", (event) => {
  const frame = JSON.parse(event.data);
  const handler = pending.get(frame.payload?.requestId);
  if (handler && frame.type.endsWith("_result")) {
    pending.delete(frame.payload.requestId);
    handler(frame.payload);
  } else frames.push(frame);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let browser;
try {
  send("machine_select", { machineId, localProtocolVersion: 1 });
  await waitFor("daemon handshake", () =>
    frames.find((f) => f.type === "connected"),
  );
  const list = await request("dsh_list", {});
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    channel: process.env.BROWSER_EXECUTABLE ? undefined : "chrome",
    headless: true,
  });
  for (const exp of experiences) {
    const dsh = "autonomous/" + exp.id;
    assert.ok(
      list.dsh?.find((entry) => entry.id === dsh && entry.installed),
      dsh + " must be installed first",
    );
    const workspace = await mkdtemp(join(tmpdir(), "harness-daemon-check-"));
    let agentId, page;
    try {
      const created = await request(
        "agent_create",
        {
          engine: "claude",
          dsh,
          cwd: workspace,
          creationId: randomBytes(12).toString("hex"),
        },
        60000,
      );
      if (created.agent?.id) agentId = created.agent.id;
      assert.equal(
        created.state,
        "created",
        JSON.stringify({ error: created.error, failure: created.failure }),
      );
      frames.push({ type: "agent_synced", payload: { agent: created.agent } });
      const agent = await waitFor(
        exp.id + " ready viewer",
        () =>
          frames
            .map((f) => f.payload?.agent)
            .find(
              (a) =>
                a?.id === agentId && a.viewerUrl && a.launch?.state === "ready",
            ),
        120000,
      );
      assert.equal(
        new URL(agent.viewerUrl).searchParams.get("file"),
        exp.path + "/index.html",
      );
      const verdict = JSON.parse(
        await readFile(join(workspace, ".harness/verdict.json"), "utf8"),
      );
      assert.equal(verdict.artifact, exp.path + "/index.html");
      assert.equal(verdict.ready, false);
      assert.match(
        await readFile(join(workspace, "AGENTS.md"), "utf8"),
        /Shipped experience/,
      );
      const actual = await readFile(
        join(workspace, exp.path, "index.html"),
        "utf8",
      );
      assert.equal(
        actual,
        await readFile(
          join(
            repo,
            "store/agents",
            exp.id,
            "template",
            exp.path,
            "index.html",
          ),
          "utf8",
        ),
      );
      page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(agent.viewerUrl);
      await page
        .frameLocator("#preview")
        .locator("body[data-ready=true]")
        .waitFor();
      const revision = "daemon-" + exp.id;
      await writeFile(
        join(workspace, exp.path, "index.html"),
        actual.replace("<body>", `<body data-revision="${revision}">`),
      );
      await page
        .frameLocator("#preview")
        .locator(`body[data-ready=true][data-revision="${revision}"]`)
        .waitFor();
      assert.deepEqual(errors, []);
      results.push({
        name: exp.id,
        ok: true,
        checks: [
          "daemon create",
          "engine ready",
          "template materialized",
          "agent instructions",
          "honest initial verdict",
          "installed viewer routing",
          "browser ready",
          "live file reload",
        ],
      });
      console.log("PASS daemon " + exp.id);
    } finally {
      await page?.close();
      if (agentId) {
        const deleted = await request("agent_delete", { agentId });
        assert.equal(deleted.deleted, true);
        await waitFor("temporary agent deleted", () =>
          frames.find(
            (f) => f.type === "agent_deleted" && f.payload?.agentId === agentId,
          ),
        );
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }
} finally {
  await browser?.close();
  socket.close();
  await writeFile(
    join(output, "daemon-results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}
