import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,realpath,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStudio,confined,validateParameters} from '../server.mjs';

const config={title:'Test studio',controls:[{id:'speed',label:'Speed',type:'number',value:2,min:1,max:5,integer:true},{id:'mode',label:'Mode',type:'select',value:'a',options:[{value:'a'},{value:'b'}]},{id:'name',label:'Name',type:'text',value:'hello',maxLength:20}],actions:[{id:'run',label:'Make'}]};
const project={spec:1,parameters:{speed:2,mode:'a',name:'hello'}};
async function fixture(t,script='exit 0',jobTimeout=10000){
  const root=await realpath(await mkdtemp(join(tmpdir(),'studio-test-'))),workspace=join(root,'workspace'),packageDir=join(root,'package');
  await mkdir(workspace);await mkdir(join(packageDir,'toolchain'),{recursive:true});
  await writeFile(join(workspace,'studio.json'),JSON.stringify(project));
  await writeFile(join(packageDir,'studio.config.json'),JSON.stringify(config));
  await writeFile(join(packageDir,'view.mjs'),'export function mount(){}');
  await writeFile(join(packageDir,'toolchain/run.sh'),'#!/bin/sh\n'+script+'\n',{mode:0o755});
  const studio=await createStudio({workspace,packageDir,jobTimeout});
  t.after(async()=>{await studio.close();await rm(root,{recursive:true,force:true});});
  const req=async(path,body,headers={})=>{const r=await fetch(studio.url+path,body===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});return {status:r.status,type:r.headers.get('content-type'),data:await r.text()};};
  const state=async()=>JSON.parse((await req('/api/state')).data);
  const run=async(parameters=project.parameters)=>req('/api/run',{action:'run',parameters,revision:(await state()).revision});
  return {root,workspace,packageDir,studio,req,state,run};
}
async function until(get,predicate){for(let i=0;i<150;i++){const v=await get();if(predicate(v))return v;await new Promise(r=>setTimeout(r,10));}throw Error('condition timed out');}

test('controls reject invalid input, retain defaults, and enforce native types',()=>{
  assert.deepEqual(validateParameters(config,{}),project.parameters);
  for(const p of [null,[],2,{extra:1},{speed:NaN},{speed:null},{speed:'2'},{speed:0},{speed:1.2},{mode:'c'},{name:2},{name:'x'.repeat(21)}])assert.throws(()=>validateParameters(config,p),e=>e.status===400);
  assert.deepEqual(validateParameters(config,{speed:3,mode:'b',name:'there'}),{speed:3,mode:'b',name:'there'});
  const simple={controls:[{id:'v',label:'Value',type:'text',value:''}]};
  assert.throws(()=>validateParameters(simple,{v:'x'.repeat(501)}));
});
test('serves the complete local UI and only the installed domain module',async t=>{
  const f=await fixture(t);
  for(const path of ['/','/studio.css','/tokens.css','/studio.mjs','/graphics.mjs','/music.mjs','/domain.mjs'])assert.equal((await f.req(path)).status,200,path);
  assert.equal((await f.req('/not-present')).status,404);
  assert.equal((await f.req('/%E0%A4%A')).status,400);
  const s=await f.state();assert.deepEqual(s.project,project);assert.deepEqual(s.history,[]);assert.equal(s.result,null);
  const head=await fetch(f.studio.url+'/',{method:'HEAD'});assert.equal(await head.text(),'');
});
test('rejects cross-site requests, unsupported methods, invalid JSON, unknown actions, and stale revisions',async t=>{
  const f=await fixture(t);
  assert.equal((await f.req('/api/run',{}, {Origin:'https://example.com'})).status,403);
  const wrongHost=await new Promise((ok,fail)=>{const r=http.get(f.studio.url,{headers:{Host:'evil.example'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode));});r.on('error',fail);});
  assert.equal(wrongHost,403);
  assert.equal((await f.req('/api/run','abc')).status,400);
  for(const input of ['null','[]','2'])assert.equal((await f.req('/api/run',input)).status,400);
  assert.equal((await f.req('/api/run','x'.repeat(17000))).status,413);
  assert.equal((await f.req('/api/run',{}, {'Content-Type':'text/plain'})).status,415);
  assert.equal((await f.req('/api/run',{action:'bad'})).status,400);
  assert.equal((await f.req('/api/run',{action:'run',revision:'old'})).status,409);
  assert.equal((await f.req('/unknown',{})).status,405);
  assert.equal((await f.req('/api/cancel',{})).status,409);
});
test('runs one fixed command, persists controls, reports output, and permits reruns',async t=>{
  const f=await fixture(t,'echo rendering; sleep 0.1; echo finished');
  assert.equal((await f.run({...project.parameters,speed:4})).status,202);
  assert.equal((await f.run()).status,409);
  const done=await until(f.state,s=>s.job.status==='done');assert.match(done.job.log,/rendering/);assert.match(done.job.log,/finished/);assert.equal(done.project.parameters.speed,4);
  assert.equal((await f.run()).status,202);await until(f.state,s=>s.job.status==='done');
});
test('failed, cancelled, and timed-out jobs retain the previous artifact',async t=>{
  for(const [script,timeout,expected] of [['echo oh-no >&2; exit 2',1000,'failed'],['sleep 10',20,'failed'],['sleep 10',1000,'cancelled']]){
    const f=await fixture(t,script,timeout);await mkdir(join(f.workspace,'out'));await writeFile(join(f.workspace,'out/latest.json'),'{}');
    assert.equal((await f.run()).status,202);
    if(expected==='cancelled')assert.equal((await f.req('/api/cancel',{})).status,200);
    const s=await until(f.state,s=>s.job.status===expected);assert.deepEqual(s.result,{});
  }
});
test('records successful history, reads chosen runs, ignores incomplete results',async t=>{
  const f=await fixture(t);await mkdir(join(f.workspace,'out/runs/first'),{recursive:true});await mkdir(join(f.workspace,'out/runs/incomplete'));await mkdir(join(f.workspace,'out/runs/broken'));
  await writeFile(join(f.workspace,'out/runs/first/result.json'),JSON.stringify({id:'first',title:'My run',metrics:[],engine:'actual'}));await writeFile(join(f.workspace,'out/runs/broken/result.json'),'not json');
  assert.equal((await f.state()).history.length,1);assert.equal((await f.req('/api/run?id=first')).status,200);assert.equal((await f.req('/api/run')).status,400);assert.equal((await f.req('/api/run?id=../studio')).status,400);assert.equal((await f.req('/api/run?id=missing')).status,404);
  await writeFile(join(f.workspace,'out/latest.json'),'unfinished');assert.equal((await f.req('/api/state')).status,500);
});

test('cancellation also works when the platform cannot signal a process group',async t=>{
  const f=await fixture(t,'sleep 10');await f.run();
  const kill=process.kill;
  t.mock.method(process,'kill',(pid,signal)=>{if(pid<0)throw Error('process groups unavailable');return kill(pid,signal);});
  assert.equal((await f.req('/api/cancel',{})).status,200);
  await until(f.state,s=>s.job.status==='cancelled');
});

test('closing the viewer terminates jobs that ignore graceful cancellation',async t=>{
  const f=await fixture(t,"trap '' TERM; echo ready; while :; do sleep 1; done");
  await f.run();await until(f.state,s=>s.job.log.includes('ready'));
  assert.equal((await f.req('/api/cancel',{})).status,200);
  await f.studio.close();
  await assert.rejects(fetch(f.studio.url+'/api/state'));
});
test('confines files after symlink resolution and serves artifact downloads',async t=>{
  const f=await fixture(t);await mkdir(join(f.workspace,'out'));await writeFile(join(f.root,'secret.txt'),'private');await symlink(join(f.root,'secret.txt'),join(f.workspace,'out/escape.txt'));
  await writeFile(join(f.workspace,'out/sound.wav'),'RIFF');await writeFile(join(f.workspace,'out/data.json'),'{}');await writeFile(join(f.workspace,'out/unknown.xyz'),'hello');
  assert.equal((await f.req('/artifacts/out/escape.txt')).status,403);assert.equal((await f.req('/artifacts/studio.json')).status,403);assert.equal((await f.req('/artifacts/out')).status,403);assert.equal((await f.req('/artifacts/out/')).status,404);
  for(const name of ['sound.wav','data.json','unknown.xyz'])assert.equal((await f.req('/artifacts/out/'+name)).status,200);
  const r=await fetch(f.studio.url+'/artifacts/out/sound.wav?download');assert.match(r.headers.get('content-disposition'),/attachment/);assert.equal(await r.text(),'RIFF');
  assert.equal(await confined(f.workspace,'.'),f.workspace);await assert.rejects(confined(f.workspace,'../secret.txt'),e=>e.status===403);
});
test('rejects oversized and malformed state without disclosing filesystem paths',async t=>{
  const f=await fixture(t);await writeFile(join(f.workspace,'studio.json'),'x'.repeat(8*1024*1024+1));assert.equal((await f.req('/api/state')).status,413);await writeFile(join(f.workspace,'studio.json'),'broken');const r=await f.req('/api/state');assert.equal(r.status,500);assert.ok(!r.data.includes(f.workspace));
});

test('simultaneous submissions start exactly one process',async t=>{
  const f=await fixture(t,'echo started; sleep 0.5');
  const revision=(await f.state()).revision;
  const results=await Promise.all(Array.from({length:8},()=>f.req('/api/run',{action:'run',parameters:project.parameters,revision})));
  assert.equal(results.filter(r=>r.status===202).length,1);
  assert.equal(results.filter(r=>r.status===409).length,7);
  await until(f.state,s=>s.job.status==='done');
  assert.equal((await f.state()).job.log.trim(),'started');
});

test('missing executable and corrupt history surface errors and retain the workspace',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.packageDir,'toolchain/run.sh'),'#!/definitely-not-an-interpreter\n');
  assert.equal((await f.run()).status,202);
  const failed=await until(f.state,s=>s.job.status==='failed');assert.match(failed.job.message,/ENOENT/);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace,'studio.json'),'utf8')),project);
  await mkdir(join(f.root,'outside'));await mkdir(join(f.workspace,'out'));
  await symlink(join(f.root,'outside'),join(f.workspace,'out/runs'));
  assert.equal((await f.req('/api/state')).status,403);
});

test('bounds output size and handles JSON HEAD downloads',async t=>{
  const f=await fixture(t);await mkdir(join(f.workspace,'out'));
  const file=await open(join(f.workspace,'out/large.bin'),'w');await file.truncate(256*1024*1024+1);await file.close();
  assert.equal((await f.req('/artifacts/out/large.bin')).status,413);
  await writeFile(join(f.workspace,'out/record.json'),'{"answer":42}');
  const head=await fetch(f.studio.url+'/artifacts/out/record.json',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
});

test('WebKit audio ranges, suffixes, and artifact downloads preserve exact bytes',async t=>{
  const f=await fixture(t);await mkdir(join(f.workspace,'out'));
  await writeFile(join(f.workspace,'out/record.wav'),'0123456789');
  for(const [range,wanted,contentRange] of [['bytes=0-1','01','bytes 0-1/10'],['bytes=7-','789','bytes 7-9/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=8-99','89','bytes 8-9/10']]){
    const response=await fetch(f.studio.url+'/artifacts/out/record.wav',{headers:{Range:range}});
    assert.equal(response.status,206);assert.equal(await response.text(),wanted);
    assert.equal(response.headers.get('content-range'),contentRange);assert.equal(Number(response.headers.get('content-length')),wanted.length);
  }
  for(const range of ['bytes=10-','bytes=5-2','bytes=-0','bytes=-','bytes=0-1,3-4','nonsense','bytes=999999999999999999999-']){
    const response=await fetch(f.studio.url+'/artifacts/out/record.wav',{headers:{Range:range}});
    assert.equal(response.status,416,range);assert.equal(response.headers.get('content-range'),'bytes */10');
  }
  const content='{\n  "answer": 42\n}\n';await writeFile(join(f.workspace,'out/record.json'),content);
  assert.equal(await(await fetch(f.studio.url+'/artifacts/out/record.json?download')).text(),content);
  const head=await fetch(f.studio.url+'/artifacts/out/record.wav',{method:'HEAD',headers:{Range:'bytes=0-1'}});
  assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
});

test('manifest server entry point starts, serves a workspace, and stops cleanly',async t=>{
  const f=await fixture(t);
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,HARNESS_WORKSPACE:f.workspace,HARNESS_DSH_DIR:f.packageDir,HARNESS_VIEWER_PORT:'0'},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  const [data]=await once(child.stdout,'data');const url=data.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  assert.equal((await fetch(url+'/api/state')).status,200);
  const exited=once(child,'exit');child.kill('SIGTERM');assert.deepEqual(await exited,[0,null]);
});
