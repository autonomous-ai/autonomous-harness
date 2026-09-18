import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectWorkspace, initializeWorkspace, readStatus } from '../lib/connect.mjs';
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
test('fresh initialization follows a reachable active remote selection, not the template local mode',async t=>{
  const {dir,profilePath}=await setup(t),calls=[];
  const runJson=async(_host,mode,args)=>{calls.push([mode,...args]);return {ok:true,value:args[0]==='mode'?{mode:'remote'}:args[0]==='use'?{active:'my-fleet'}:[]};};
  const {config}=await initializeWorkspace(dir,{profilePath,discover,runJson});
  assert.equal(config.mode,'remote');assert.equal(config.grid,'my-fleet');
  assert.deepEqual(calls,[['local','mode'],['remote','use'],['remote','engines','my-fleet']]);
});
test('an unreachable active grid and ambiguous inventory never silently select old home',async t=>{
  const {dir,profilePath}=await setup(t);
  const runJson=async(_host,mode,args)=>args[0]==='mode'?{ok:true,value:{mode:'remote'}}:args[0]==='use'?{ok:true,value:{active:'broken'}}:args[0]==='engines'?{ok:false,error:'unreachable'}:{ok:true,value:mode==='local'?[{grid:'home'}]:[{grid:'working'},{grid:'other'}]};
  const result=await initializeWorkspace(dir,{profilePath,discover,runJson});
  assert.equal(result.config.grid,null);assert.equal(result.connection.candidates.length,3);
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
  const fail={profilePath,discover,runJson:async()=>({ok:false,error:'Grid unreachable'})};
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
