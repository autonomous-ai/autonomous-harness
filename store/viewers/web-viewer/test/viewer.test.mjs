import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createHtmlViewer } from '../viewer.mjs';

let root, workspace, server, base;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'openharness-html-'));
  workspace = join(root, 'workspace');
  await cp(fileURLToPath(new URL('../../../examples/hello-world/template', import.meta.url)), workspace, { recursive: true });
  await mkdir(join(workspace, 'pages'));
  await writeFile(join(workspace, 'pages', 'demo.html'), '<h1>A nested page</h1>');
  await writeFile(join(workspace, 'pages', 'style.css'), 'h1 { color: green; }');
  await writeFile(join(workspace, '.env'), 'PRIVATE=do-not-serve');
  await writeFile(join(root, 'outside.txt'), 'outside the workspace');
  await symlink(join(root, 'outside.txt'), join(workspace, 'outside.txt'));
  await symlink(join(workspace, '.env'), join(workspace, 'hidden.txt'));
  server = await createHtmlViewer(workspace);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('serves the actual Hello World page and a sandboxed preview shell', async () => {
  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /sandbox="allow-scripts"/);
  const page = await fetch(base + '/files/index.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Hello, world!/);
  const css = await fetch(base + '/files/pages/style.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(await css.text(), /green/);
  assert.match(await (await fetch(base + '/files/pages/demo.html')).text(), /nested page/);
});

test('a workspace edit notifies the live preview and serves the new content', { timeout: 5000 }, async () => {
  const stop = new AbortController();
  try {
    const response = await fetch(base + '/events', { signal: stop.signal });
    const reader = response.body.getReader();
    await reader.read(); // Connected; the subscription exists before the write.
    await writeFile(join(workspace, 'index.html'), '<h1>Hello, Ada!</h1>');
    let events = '';
    while (!events.includes('event: change')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      events += new TextDecoder().decode(value);
    }
    assert.match(await (await fetch(base + '/files/index.html')).text(), /Hello, Ada!/);
  } finally { stop.abort(); }
});

test('rejects traversal, private files, and symlinks that escape or expose hidden files', async () => {
  for (const path of ['/files/%2e%2e%2foutside.txt', '/files/.env', '/files/outside.txt', '/files/hidden.txt', '/files/pages', '/files/%00']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/files/%ZZ')).status, 400);
});

test('is read-only and refuses a non-loopback Host header', async () => {
  assert.equal((await fetch(base + '/files/index.html', { method: 'POST', body: 'replace' })).status, 405);
  assert.equal((await fetch(base + '/files/index.html', { method: 'HEAD' })).status, 200);
  const status = await new Promise((resolve, reject) => {
    const req = request(base, { headers: { host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('shows a recoverable empty state before a page exists', async () => {
  const missing = await fetch(base + '/files/later.html');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No preview yet/);
  await writeFile(join(workspace, 'later.html'), '<p>Now ready</p>');
  assert.match(await (await fetch(base + '/files/later.html')).text(), /Now ready/);
});
