import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, cliDetail, DEFAULT_CONFIG, execute, gridJson, gridSelect, invocation, operations, runTracked, validateConfig } from '../lib/fleet.mjs';

const temporary = async t => { const dir=await mkdtemp(join(tmpdir(),'grid-harness-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; };
test('inventory accepts explicit targets and refuses duplicates, SSH options and malformed paths',()=>{
  const config=validateConfig({...DEFAULT_CONFIG,machines:[{id:'gpu',transport:'ssh',host:'me@gpu-box',port:2222}]});
  assert.equal(config.controller,'gpu');
  for(const machines of [[{id:'a',transport:'ssh',host:'-oProxyCommand=evil'}],[{id:'a',transport:'ssh',host:'host; touch /tmp/oops'}],[{id:'a',transport:'local'},{id:'a',transport:'local'}],[{id:'a',transport:'local',gridHome:'relative'}]])assert.throws(()=>validateConfig({...DEFAULT_CONFIG,machines}));
});
test('local forwarding preserves quotes, spaces, shell syntax and exit status without evaluating it',async t=>{
  const dir=await temporary(t),script=join(dir,'record.mjs');
  await writeFile(script,'console.log(JSON.stringify(process.argv.slice(2)));process.exit(7)');
  const args=[script,'pull','repo:file with spaces.gguf',"a'b",'$(touch DO_NOT_CREATE)','; exit 0'];
  const result=await execute({transport:'local',gridBinary:process.execPath},args);
  assert.equal(result.code,7);assert.equal(result.ok,false);assert.deepEqual(JSON.parse(result.stdout),args.slice(1));
});
test('SSH quotes every remote argument and retains normal host verification',()=>{
  const call=invocation({transport:'ssh',host:'studio',gridHome:"/tmp/grid's state",gridBinary:'/opt/grid bin/grid'},['chat','-m','model','$(touch /tmp/no); "hello"']);
  assert.equal(call.file,'ssh');assert.ok(call.args.includes('StrictHostKeyChecking=yes'));assert.ok(call.args.includes('BatchMode=yes'));
  assert.match(call.args.at(-1),/'\$\(touch \/tmp\/no\); "hello"'/);
  assert.match(call.args.at(-1),/grid'"'"'s state/);
});
test('thinking configuration reaches local and SSH engine startup as a fixed JSON boolean',()=>{
  assert.equal(invocation({transport:'local'},['join'],{},false).env.LLAMA_ARG_CHAT_TEMPLATE_KWARGS,'{"enable_thinking":false}');
  assert.match(invocation({transport:'ssh',host:'rig'},['join'],{},true).args.at(-1),/LLAMA_ARG_CHAT_TEMPLATE_KWARGS='\{"enable_thinking":true\}'/);
  assert.equal(invocation({transport:'local'},['join'],{}).env.LLAMA_ARG_CHAT_TEMPLATE_KWARGS,undefined);
});
test('timeouts are unsuccessful even when the child handles termination and exits zero',async t=>{
  const dir=await temporary(t),script=join(dir,'hang.mjs');
  await writeFile(script,"process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)");
  const result=await execute({transport:'local',gridBinary:process.execPath},[script],{timeoutMs:200});
  assert.equal(result.code,124);assert.equal(result.ok,false);assert.match(result.error,/did not answer/);
});
test('operation records show completion but never retain model prompts or keys',async t=>{
  const dir=await temporary(t),script=join(dir,'grid');
  await writeFile(script,'#!/bin/sh\nexit 3\n',{mode:0o755});
  const result=await runTracked(dir,{id:'local',transport:'local',gridBinary:script},'local',['chat','-m','test','private-user-prompt','--api-key','private-secret'],{inherit:false});
  assert.equal(result.code,3);
  const rows=await operations(dir);assert.equal(rows.length,1);assert.equal(rows[0].phase,'failed');assert.equal(rows[0].command,'grid chat');
  assert.doesNotMatch(JSON.stringify(rows),/private-/);
});
test('invalid and abandoned operation files cannot crash the viewer',async t=>{
  const dir=await temporary(t);
  await atomicJson(join(dir,'.harness/grid/operations/a.json'),{id:'a',phase:'running',pid:2147483647,startedAt:'2026-09-18T00:00:00Z'});
  await atomicJson(join(dir,'.harness/grid/operations/b.json'),{unrelated:true});
  const rows=await operations(dir);assert.equal(rows.length,1);assert.equal(rows[0].phase,'interrupted');
});

test('failed Grid reads repeat the CLI reason instead of a bare exit code', async t => {
  const dir = await temporary(t), file = join(dir, 'grid');
  // A dead relay: JSON envelope plus a human line on stderr, exit 1 — the shape the
  // real CLI prints when a grid_url no longer resolves.
  await writeFile(file, '#!/bin/sh\necho \'{"error": {"code": null, "message": "Could not reach grid forge: [Errno 8] nodename nor servname provided, or not known"}}\' >&2\necho "Could not reach grid forge: [Errno 8] nodename nor servname provided, or not known" >&2\nexit 1\n', { mode: 0o755 });
  const result = await gridJson({ transport: 'local', gridBinary: file }, 'remote', ['engines', 'forge']);
  assert.equal(result.ok, false);
  assert.match(result.error, /grid engines failed \(1\): Could not reach grid forge/);
});

test('error envelopes on success and plain stderr lines are surfaced, tokens are not', async t => {
  const dir = await temporary(t), file = join(dir, 'grid');
  await writeFile(file, '#!/bin/sh\necho \'{"error": "relay refused https://host.test/relay?token=secret-value"}\'\nexit 0\n', { mode: 0o755 });
  const reported = await gridJson({ transport: 'local', gridBinary: file }, 'remote', ['models', 'forge']);
  assert.equal(reported.ok, false);
  assert.match(reported.error, /grid models reported: relay refused/);
  assert.doesNotMatch(reported.error, /secret-value/);
  assert.match(reported.error, /token=…/);
  assert.equal(cliDetail('', ''), null);
  assert.equal(cliDetail('{"error": {"message": "boom"}}', ''), 'boom');
  assert.equal(cliDetail('noise', 'last human line'), 'last human line');
});
test('gridSelect runs the write form of use as a plain command and confirms it by reading the selection back',async()=>{
  // `grid use <name> --json` prints a sentence, not JSON — parsed as JSON, every successful switch
  // from the viewer read as "did not return valid JSON". The write is plain; the read confirms.
  const machine={id:'local',transport:'local'},ran=[];
  const run=async(_m,args)=>{ran.push(args);return {ok:true,code:0,stdout:'active grid for remote mode: autonomous.ai\n',stderr:''};};
  const readJson=async(_m,_mode,args)=>{ran.push(['json',...args]);return {ok:true,value:{mode:'remote',active:'autonomous.ai'}};};
  assert.deepEqual(await gridSelect(machine,'remote','autonomous.ai',{},{run,readJson}),{ok:true,active:'autonomous.ai'});
  assert.deepEqual(ran,[['--remote','use','autonomous.ai'],['json','use']]);
  // The CLI accepted the name but ended up somewhere else: said, not hidden.
  const elsewhere=await gridSelect(machine,'remote','other',{},{run,readJson});
  assert.equal(elsewhere.ok,false);assert.match(elsewhere.error,/active grid is autonomous\.ai, not other/);
  // A failed write is a failure, with the exit code, before any read.
  const failed=await gridSelect(machine,'remote','x',{},{run:async()=>({ok:false,code:2,stdout:'',stderr:'no such grid'}),readJson:async()=>{throw new Error('must not read');}});
  assert.equal(failed.ok,false);assert.match(failed.error,/grid use failed \(2\)/);
});
