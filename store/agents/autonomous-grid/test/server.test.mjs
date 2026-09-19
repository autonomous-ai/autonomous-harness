import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewer } from '../viewer.mjs';
import { assemble } from '../lib/telemetry.mjs';
import { config, reads } from './fixtures.mjs';

test('viewer serves its real app and SSE, blocks mutations and never serves workspace secrets',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'grid-viewer-'));
  let fail=false;
  const viewer=createViewer({workspace,intervalMs:50,collect:async()=>{if(fail)throw new Error('secret token');return {...assemble(config,reads),machines:[],operations:[]};}});
  const port=await viewer.start();t.after(async()=>{await viewer.close();await rm(workspace,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/id="connections"/);assert.match(page.headers.get('content-security-policy'),/default-src 'self'/);
  for(const asset of ['app.css','app.js'])assert.equal((await fetch(`${base}/${asset}`)).status,200);
  assert.equal((await fetch(`${base}/api/snapshot`,{method:'POST',body:'delete everything'})).status,405);
  assert.equal((await fetch(`${base}/api/snapshot`,{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(`${base}/grid-fleet.json`)).status,404);
  assert.equal((await fetch(`${base}/.harness/grid/../secret`)).status,404);
  const blocked=await new Promise(resolve=>{request(base,{headers:{host:'attacker.test'}},res=>{res.resume();resolve(res.statusCode);}).end();});assert.equal(blocked,403);
  const abort=new AbortController();const events=await fetch(`${base}/events`,{signal:abort.signal});const reader=events.body.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/event: snapshot/);assert.match(chunk,/Mac Studio/);abort.abort();
  fail=true;await new Promise(resolve=>setTimeout(resolve,90));const stale=await (await fetch(`${base}/api/snapshot`)).json();assert.equal(stale.status,'unavailable');assert.ok(stale.nodes.every(n=>n.stale));assert.doesNotMatch(JSON.stringify(stale),/secret token/);
});
