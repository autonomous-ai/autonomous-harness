import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, now, operations, PACKAGE } from './lib/fleet.mjs';
import { createCollector } from './lib/telemetry.mjs';

export function createViewer({ workspace, port = 0, intervalMs = 8000, collect = createCollector(workspace, { intervalMs }) }) {
  const clients = new Set();
  let snapshot = { spec: 1, status: 'connecting', grid: 'Your grid', nodes: [], machines: [], models: [], events: [], operations: [], history: {}, sources: {}, summary: {}, observedAt: null, pollIntervalMs: intervalMs };
  let stopped = false, pollTimer, opTimer, heartbeat;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  const json = (res, code, value) => { res.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const publish = () => {
    const body = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 256 * 1024) { client.destroy(); clients.delete(client); }
      else client.write(body);
    }
  };
  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const hosts = new Set([`127.0.0.1:${address?.port}`, `localhost:${address?.port}`, `[::1]:${address?.port}`]);
      if (!hosts.has(req.headers.host)) { json(res, 403, { error: 'Loopback requests only.' }); return; }
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('allow', 'GET, HEAD'); json(res, 405, { error: 'This viewer is read-only. Talk to the Grid agent to make changes.' }); return; }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const origin = req.headers.origin;
      if (origin && origin !== url.origin) { json(res, 403, { error: 'Cross-origin requests are not allowed.' }); return; }
      if (url.pathname === '/health') { json(res, 200, { ok: true }); return; }
      if (url.pathname === '/api/snapshot') { json(res, 200, snapshot); return; }
      if (url.pathname === '/events') {
        if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
        if (clients.size >= 32) { json(res, 503, { error: 'Too many viewer connections.' }); return; }
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        clients.add(res); res.on('close', () => clients.delete(res)); return;
      }
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };
      if (!assets[url.pathname]) { json(res, 404, { error: 'Not found' }); return; }
      const [file, contentType] = assets[url.pathname];
      const content = await readFile(join(PACKAGE, 'viewer', file));
      res.writeHead(200, { ...headers, 'content-type': contentType, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'" });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { if (!res.headersSent) json(res, 500, { error: 'The viewer could not serve this request.' }); else res.end(); }
  });
  async function poll() {
    try { snapshot = await collect(); }
    catch {
      snapshot = { ...snapshot, status: 'unavailable', nodes: snapshot.nodes.map(n => ({ ...n, stale: true })), sources: { configuration: { ok: false, error: 'Cannot refresh the fleet. Ask the agent to check grid-fleet.json and run fleet refresh.' } } };
      await atomicJson(join(workspace, '.harness', 'verdict.json'), { spec: 1, ready: false, summary: 'Grid telemetry could not refresh', findings: [{ severity: 'error', kind: 'telemetry', message: snapshot.sources.configuration.error }], updatedAt: now() }).catch(() => {});
    }
    if (stopped) return;
    publish(); pollTimer = setTimeout(poll, intervalMs);
  }
  async function pollOperations() {
    const latest = await operations(workspace).catch(() => []);
    if (!stopped && JSON.stringify(latest) !== JSON.stringify(snapshot.operations)) { snapshot = { ...snapshot, operations: latest }; publish(); }
    if (!stopped) opTimer = setTimeout(pollOperations, 1500);
  }
  return {
    server,
    start: () => new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', fail); poll(); pollOperations();
        heartbeat = setInterval(() => { for (const client of clients) client.write(': pulse\n\n'); }, 20_000);
        ok(server.address().port);
      });
    }),
    close: async () => { stopped = true; clearTimeout(pollTimer); clearTimeout(opTimer); clearInterval(heartbeat); for (const client of clients) client.end(); server.closeAllConnections(); await new Promise(done => server.close(done)); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd());
  const port = Number(process.env.HARNESS_VIEWER_PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HARNESS_VIEWER_PORT must be a port number.');
  const viewer = createViewer({ workspace, port });
  console.log(`[grid] http://127.0.0.1:${await viewer.start()}/`);
  const close = () => viewer.close().then(() => process.exit(0));
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
