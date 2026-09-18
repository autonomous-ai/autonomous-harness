import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectWorkspace, initializeWorkspace, pickPrivateGrid, readStatus } from '../lib/connect.mjs';
import { atomicJson, DEFAULT_CONFIG, gridJson, readConfig } from '../lib/fleet.mjs';
import { createCollector } from '../lib/telemetry.mjs';

async function setup(t, config=DEFAULT_CONFIG) {
  const dir=await mkdtemp(join(tmpdir(),'grid-startup-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await atomicJson(join(dir,'grid-fleet.json'),config);
  return {dir,profilePath:join(dir,'defaults.json')};
}
const discover=async()=>[{id:'host-id',machineId:'host-id',name:'This computer',transport:'local',current:true},{id:'gpu-id',machineId:'gpu-id',name:'GPU rig',transport:'harness'}];
test('a fresh workspace reuses the remembered remote fleet and imports machines',async t=>{
  const {dir,profilePath}=await setup(t);
  await atomicJson(profilePath,{...DEFAULT_CONFIG,mode:'remote',grid:'working-fleet'});
  const result=await initializeWorkspace(dir,{profilePath,discover,runJson:async()=>{throw new Error('must not choose a different CLI default');}});
  assert.equal(result.config.grid,'working-fleet');assert.equal(result.config.mode,'remote');assert.equal(result.config.machines.length,2);
  assert.equal(result.config.controller,'local');assert.equal(result.config.machines[0].name,'This computer');
  assert.equal(result.connection.source,'remembered fleet');
});
test('the private grid is recognised from the sign-in: email slug, eight hex, permissioned-public, exactly one',()=>{
  const rows=[{grid:'autonomous.ai',type:'private-domain'},{grid:'tuan-dev-991371e4',type:'permissioned-public'},{grid:'tuan-dev-11111111',type:'domain-restricted'},{grid:'BBB',type:'domain-restricted'}];
  assert.equal(pickPrivateGrid('Tuan.Dev@autonomous.ai',rows),'tuan-dev-991371e4');
  assert.equal(pickPrivateGrid('someone@x.io',rows),null);
  assert.equal(pickPrivateGrid('tuan.dev@x.io',[...rows,{grid:'tuan-dev-aaaaaaaa',type:'permissioned-public'}]),null,'two matches are nobody\'s answer');
});
test('fresh initialization follows the CLI\'s active selection when there is one',async t=>{
  const {dir,profilePath}=await setup(t),calls=[];
  const ls={remote:[{grid:'autonomous.ai',type:'private-domain'},{grid:'tuan-dev-991371e4',type:'permissioned-public'}],local:[{grid:'home'}]};
  const runJson=async(_host,mode,args)=>{calls.push([mode,...args]);return {ok:true,value:args[0]==='mode'?{mode:'remote'}:args[0]==='use'?{mode:'remote',active:'autonomous.ai'}:args[0]==='ls'?ls[mode]:[]};};
  const selected=[];const select=async(_host,mode,grid)=>{selected.push([mode,grid]);return {ok:true,active:grid};};
  const {config,connection}=await initializeWorkspace(dir,{profilePath,discover,runJson,select,email:async()=>'tuan.dev@autonomous.ai'});
  assert.equal(config.grid,'autonomous.ai');assert.equal(connection.source,'Grid selection');
  assert.deepEqual(calls.filter(c=>c[1]==='engines'),[['remote','engines','autonomous.ai']]);
  assert.deepEqual(selected,[],'an existing selection is never rewritten');
});
test('with no selection yet, the signed-in user\'s own private grid is chosen AND selected, so the CLI agrees',async t=>{
  const {dir,profilePath}=await setup(t),calls=[];
  const ls={remote:[{grid:'autonomous.ai',type:'private-domain'},{grid:'tuan-dev-991371e4',type:'permissioned-public'}],local:[{grid:'home'}]};
  const runJson=async(_host,mode,args)=>{calls.push([mode,...args]);return {ok:true,value:args[0]==='mode'?{mode:'remote'}:args[0]==='use'?{mode:'remote',active:null}:args[0]==='ls'?ls[mode]:[]};};
  const selected=[];const select=async(_host,mode,grid)=>{selected.push([mode,grid]);return {ok:true,active:grid};};
  const {config,connection}=await initializeWorkspace(dir,{profilePath,discover,runJson,select,email:async()=>'tuan.dev@autonomous.ai'});
  assert.equal(config.mode,'remote');assert.equal(config.grid,'tuan-dev-991371e4');assert.equal(connection.source,'your private grid');
  // Selected through the WRITE path (`grid use <name>`, prose answer), never through the JSON
  // reader — that call form printed a sentence, and parsing it as JSON was what reported every
  // successful switch as a failure.
  assert.deepEqual(selected,[['remote','tuan-dev-991371e4']]);
  assert.ok(!calls.some(c=>c[1]==='use'&&c.length===3),'the JSON reader never runs the write form of use');
});
test('the collector follows a changed selection on its next poll',async t=>{
  const {dir}=await setup(t);
  await writeFile(join(dir,'grid-fleet.json'),JSON.stringify({spec:1,mode:'remote',grid:'autonomous.ai',controller:'this',machines:[{id:'this',name:'here',transport:'local'}]}));
  let active='autonomous.ai';const asked=[];
  const runJson=async(_host,_mode,args)=>{asked.push(args);if(args[0]==='use')return {ok:true,value:{mode:'remote',active}};return {ok:true,value:[]};};
  const collect=createCollector(dir,{runJson});
  assert.equal((await collect()).grid,'autonomous.ai');
  active='tuan-dev-991371e4';
  assert.equal((await collect()).grid,'tuan-dev-991371e4');
  assert.equal((await readConfig(dir)).grid,'tuan-dev-991371e4');
  assert.ok(asked.some(a=>a[0]==='engines'&&a[1]==='tuan-dev-991371e4'),'the new grid is what gets polled');
});
test('no private grid and an ambiguous inventory selects nothing and tells the agent to ask',async t=>{
  const {dir,profilePath}=await setup(t);
  const runJson=async(_host,mode,args)=>args[0]==='mode'?{ok:true,value:{mode:'remote'}}:args[0]==='engines'?{ok:false,error:'unreachable'}:{ok:true,value:mode==='local'?[{grid:'home'}]:[{grid:'working'},{grid:'other'}]};
  const result=await initializeWorkspace(dir,{profilePath,discover,runJson,email:async()=>'someone@x.io'});
  assert.equal(result.config.grid,null);assert.equal(result.connection.candidates.length,3);assert.match(result.connection.message,/Ask the user which fleet/);
  let calls=0;const snapshot=await createCollector(dir,{runJson:async()=>{calls++;throw new Error('do not contact a default grid');}})();
  assert.equal(calls,0);assert.equal(snapshot.status,'unconfigured');assert.deepEqual(snapshot.nodes,[]);
});
test('an existing explicit workspace keeps its selection and preferences',async t=>{
  const {dir,profilePath}=await setup(t,{...DEFAULT_CONFIG,grid:'isolated-local',preferences:{...DEFAULT_CONFIG.preferences,keepFreeMemoryGb:12}});
  await atomicJson(profilePath,{...DEFAULT_CONFIG,mode:'remote',grid:'different'});
  const {config}=await initializeWorkspace(dir,{profilePath,discover:async()=>[],runJson:async()=>{throw new Error('must not rediscover');}});
  assert.equal(config.grid,'isolated-local');assert.equal(config.mode,'local');assert.equal(config.preferences.keepFreeMemoryGb,12);
});
test('connect verifies service before changing workspace or remembered defaults',async t=>{
  const {dir,profilePath}=await setup(t);
  // `select` stubbed: the real one runs `grid use` on this machine, which a test must never do.
  const fail={profilePath,discover,runJson:async()=>({ok:false,error:'Grid unreachable'}),select:async(_h,_m,grid)=>({ok:true,active:grid})};
  await assert.rejects(connectWorkspace(dir,{mode:'remote',grid:'broken',remember:true},fail),/unreachable/);
  assert.equal((await readConfig(dir)).grid,null);await assert.rejects(readFile(profilePath),{code:'ENOENT'});
  const ok={...fail,runJson:async()=>({ok:true,value:[{name:'node',api_key:'must-not-save'}]})};
  await connectWorkspace(dir,{mode:'remote',grid:'working',remember:true},ok);
  assert.equal((await readConfig(dir)).grid,'working');assert.equal(JSON.parse(await readFile(profilePath)).machines.length,2);
  assert.doesNotMatch(await readFile(profilePath,'utf8'),/must-not-save|api_key/);
});
test('status reads the viewer observation without network and distinguishes fresh, stale and another grid',async t=>{
  const {dir}=await setup(t,{...DEFAULT_CONFIG,mode:'remote',grid:'working'}),time=Date.now();
  const snapshot={spec:1,scope:JSON.stringify(['remote','working','local']),status:'live',grid:'working',mode:'remote',observedAt:new Date(time).toISOString(),models:[{id:'running-model'}],nodes:[{name:'node',online:true,stale:false}],history:{privateHistory:[]}};
  await atomicJson(join(dir,'.harness/grid/snapshot.json'),snapshot);
  const fresh=await readStatus(dir,time+5000);assert.equal(fresh.fresh,true);assert.equal(fresh.status,'live');assert.equal(fresh.models[0].id,'running-model');assert.equal('history' in fresh,false);
  const stale=await readStatus(dir,time+45000);assert.equal(stale.fresh,false);assert.equal(stale.status,'stale');assert.equal(stale.nodes[0].stale,true);
  await atomicJson(join(dir,'grid-fleet.json'),{...DEFAULT_CONFIG,grid:'different'});
  const different=await readStatus(dir,time);assert.equal(different.status,'connecting');assert.deepEqual(different.models,[]);
});
test('Grid network denials explain the approval boundary rather than claiming a dead engine',async t=>{
  const {dir}=await setup(t),file=join(dir,'grid');
  await writeFile(file,'#!/bin/sh\necho "Could not reach grid home: [Errno 1] Operation not permitted"\nexit 1\n',{mode:0o755});
  const result=await gridJson({transport:'local',gridBinary:file},'local',['models','home']);
  assert.equal(result.ok,false);assert.match(result.error,/scoped network approval/);assert.match(result.error,/fleet status/);
});
