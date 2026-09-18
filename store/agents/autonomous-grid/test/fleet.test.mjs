import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, DEFAULT_CONFIG, execute, invocation, operations, runTracked, validateConfig } from '../lib/fleet.mjs';

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
