import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, createCollector, normalizeDevice, normalizeNode, safeUrl } from '../lib/telemetry.mjs';
import { atomicJson, DEFAULT_CONFIG } from '../lib/fleet.mjs';
import { config, device, reads, remoteNodes } from './fixtures.mjs';

test('remote telemetry preserves zero, missing values, correct model case and unified memory',()=>{
  const data=assemble(config,reads,null,'2026-09-18T00:00:00Z');
  assert.equal(data.status,'live');assert.equal(data.summary.enginesOnline,7);assert.equal(data.models.length,4);
  const studio=data.nodes[0];assert.equal(studio.memoryKind,'Unified memory');assert.equal(studio.memoryUsedGb,32);assert.equal(studio.temperatureC,null);assert.equal(studio.models[0],'Qwen3.5-27B');
  assert.equal(data.nodes.at(-1).memoryUsedGb,0);assert.equal(data.summary.activeRequests,null);
  assert.equal(data.endpoint,'https://grid.example.test/relay/v1');assert.equal(data.summary.answered.tokensOut,231840);
  assert.equal('tokS' in data.summary,false);
});
test('local engines stay useful when Grid exposes no GPU sensors',()=>{
  const local={...config,mode:'local'};
  const data=assemble(local,{info:{ok:true,value:{grid:'home'}},engines:{ok:true,value:[{engine:'cpu-model',where:'http://localhost:8081',models:['tiny']}]},models:{ok:true,value:[]}});
  assert.equal(data.nodes[0].online,true);assert.equal(data.nodes[0].tokS,null);assert.equal(data.nodes[0].temperatureC,null);assert.equal(data.nodes[0].memoryTotalGb,null);assert.equal(data.summary.modelsServing,1);
});
test('hosted models cannot claim local model memory; booleans are not measurements',()=>{
  const node=normalizeNode({...remoteNodes[0],plan_type:'subscription',vram_gb:256,gpu_temp_c:true,throughput_tok_s:'50'},'remote');
  assert.equal(node.memoryTotalGb,null);assert.equal(node.memoryUsedGb,null);assert.equal(node.temperatureC,null);assert.equal(node.tokS,null);
});
test('device inventory reads the GPU memory and utilization fields emitted by Grid',()=>{
  const host=normalizeDevice(config.machines[0],{gpus:[{name:'GPU',memory_total_mb:24576,memory_used_mb:1024,utilization_pct:0,temperature_c:31,power_draw_w:20}]},'now');
  assert.deepEqual(host.gpus[0],{name:'GPU',memoryGb:24,memoryUsedGb:1,utilizationPct:0,temperatureC:31,powerW:20});
});
test('dual GPU live memory uses aggregate capacity instead of single-card inventory',()=>{
  const node=normalizeNode({name:'dual4090',memory_gb:24,vram_gb:48,vram_total_mb:49128,vram_used_mb:28097,memory_used_gb:27.4},'remote');
  assert.equal(node.memoryTotalGb,49128/1024);assert.equal(node.memoryUsedGb,28097/1024);
  assert.equal(node.memoryFreeGb,(49128-28097)/1024);assert.ok(node.memoryUsedGb<node.memoryTotalGb);
});
test('a failed poll keeps stale observations, and an actual departure becomes offline',()=>{
  const before=assemble(config,reads,null,'2026-09-18T00:00:00Z');
  const failed=assemble(config,{...reads,engines:{ok:false,error:'network unavailable'}},before,'2026-09-18T00:00:08Z');
  assert.equal(failed.status,'unavailable');assert.equal(failed.nodes.length,8);assert.ok(failed.nodes.every(n=>n.stale));assert.equal(failed.history[before.nodes[0].id].length,1);
  const left=assemble(config,{...reads,engines:{ok:true,value:[]}},before,'2026-09-18T00:00:08Z');
  assert.equal(left.summary.enginesOnline,0);assert.ok(left.nodes.every(n=>n.online===false));assert.ok(left.events.some(e=>e.kind==='offline'));
  const expired=assemble(config,{...reads,engines:{ok:true,value:[]}},left,'2026-09-18T00:11:00Z');assert.equal(expired.nodes.length,0);
});
test('changing grid selection never carries another grid’s cached nodes',()=>{
  const before=assemble(config,reads);
  const changed=assemble({...config,grid:'elsewhere'},{engines:{ok:false,error:'unavailable'}},before);
  assert.equal(changed.nodes.length,0);assert.deepEqual(changed.history,{});
});
test('histories are bounded and duplicate display names remain separate',()=>{
  let data;
  const input={...reads,engines:{ok:true,value:remoteNodes.map(n=>({...n,name:'same-name'}))}};
  for(let i=0;i<110;i++)data=assemble(config,input,data,new Date(Date.UTC(2026,8,18,0,0,i*8)).toISOString());
  assert.equal(new Set(data.nodes.map(n=>n.id)).size,8);assert.equal(data.history[data.nodes[0].id].length,90);
});
test('source payloads cannot expose credentials or arbitrary fields in the browser projection',()=>{
  const data=assemble(config,{...reads,engines:{ok:true,value:[{...remoteNodes[0],access_token:'secret',api_key:'secret',nested:{password:'secret'}}]}});
  assert.doesNotMatch(JSON.stringify(data),/secret|access_token|api_key/);
  assert.equal(safeUrl('https://user:password@host.test/a?token=secret#secret'),'https://host.test/a');assert.equal(safeUrl('javascript:alert(1)'),null);
  const host=normalizeDevice(config.machines[0],device,'now');assert.equal(host.usableModelGb,24);assert.equal(host.memoryAvailableGb,28);
});
test('collector coalesces concurrent refreshes, caches hardware and writes a truthful verdict',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'grid-collect-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await atomicJson(join(dir,'grid-fleet.json'),config);
  const calls=[];
  const collect=createCollector(dir,{runJson:async(_machine,mode,args)=>{calls.push(args[0]);await new Promise(r=>setTimeout(r,2));return args[0]==='device-info'?{ok:true,value:device}:reads[args[0]];}});
  // Five reads, plus the selection check (`use`) before them and the grid list (`ls`) beside them.
  const [a,b]=await Promise.all([collect(),collect()]);assert.equal(a,b);assert.equal(calls.length,7);
  await collect();assert.equal(calls.filter(c=>c==='device-info').length,1);
  const verdict=JSON.parse(await readFile(join(dir,'.harness/verdict.json'),'utf8'));assert.equal(verdict.ready,true);assert.match(verdict.summary,/7 engines/);
});
