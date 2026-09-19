// Opt-in real model smoke. All mutations use a newly allocated GRID_HOME and unique loopback ports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { atomicJson, DEFAULT_CONFIG, execute, now, PACKAGE } from '../lib/fleet.mjs';
import { createCollector } from '../lib/telemetry.mjs';
import { createViewer } from '../viewer.mjs';

const model=process.env.GRID_TEST_MODEL,engineDir=process.env.GRID_TEST_ENGINE_DIR;
if(!model||!engineDir)throw new Error('Set GRID_TEST_MODEL to a real GGUF and GRID_TEST_ENGINE_DIR to its llama-server installation directory.');
await access(model);await access(join(engineDir,'llama-server'));
const workspace=await mkdtemp(join(process.env.GRID_TEST_OUTPUT || tmpdir(),'grid-harness-live-'));
const gridHome=join(workspace,'grid-home');
await mkdir(join(gridHome,'engines'),{recursive:true});await symlink(resolve(engineDir),join(gridHome,'engines','llama.cpp'));
await mkdir(join(gridHome,'models'),{recursive:true});await symlink(resolve(model),join(gridHome,'models',basename(model)));
const env={...process.env,GRID_HOME:gridHome,GRID_NO_UPDATE_CHECK:'1',HARNESS_WORKSPACE:workspace,LLAMA_SERVER:join(resolve(engineDir),'llama-server')};
const machine={id:'local',transport:'local',gridHome};
const freePort=()=>new Promise((ok,fail)=>{const server=createServer();server.once('error',fail);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>ok(port));});});
const port=await freePort(),enginePort=await freePort(),name='grid-harness-test',alias='grid-harness-smoke',nodeName='grid-harness-test-node';
await atomicJson(join(workspace,'grid-fleet.json'),{...DEFAULT_CONFIG,grid:name,machines:[{...machine,name:'Isolated test host'}]});
const report={startedAt:now(),workspace,model:basename(model),gridVersion:null,checks:[],cleanup:[],result:'running'};
const run=async(args,{allowFailure=false,timeoutMs=120_000}={})=>{
  const result=await new Promise((ok,fail)=>{
    const child=spawn(process.execPath,[join(PACKAGE,'toolchain','fleet.mjs'),'run','--',...args],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
    const timer=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();},timeoutMs);
    child.on('error',fail);child.on('close',code=>{clearTimeout(timer);ok({code,stdout,stderr});});
  });
  await writeFile(join(workspace,'commands.log'),`grid ${args[0]}\n${result.stdout}\n${result.stderr}\n`,{flag:'a'});
  if(!allowFailure)assert.equal(result.code,0,`${args[0]}: ${result.stderr || result.stdout}`);
  return result;
};
let viewer;
try{
  report.gridVersion=(await run(['version'])).stdout.trim();
  await run(['start',name,'--port',String(port),'--host','127.0.0.1','--advertise-host','127.0.0.1']);report.checks.push('start isolated local grid');
  await run(['join',name,'--serve',basename(model),'--name',nodeName,'--advertise-as',alias,'--endpoint-port',String(enginePort),'--advertise-host','127.0.0.1','--ctx-size','1024','--n-predict','48','--parallel','1']);report.checks.push('deploy real GGUF through Grid');
  let modelRows=[];
  for(let retry=0;retry<30;retry++){
    const listed=await run(['models',name,'--json']);modelRows=JSON.parse(listed.stdout);
    if(modelRows.some(row=>row.model===alias))break;
    await new Promise(done=>setTimeout(done,1000));
  }
  assert.ok(modelRows.some(row=>row.model===alias),'model must be advertised');report.checks.push('discover served model');
  const chat=await run(['chat','--grid',name,'-m',alias,'Say hello in one short sentence.','--json','--timeout','60']);
  const response=JSON.parse(chat.stdout);const reply=response.choices?.[0]?.message?.content;
  assert.equal(typeof reply,'string');assert.ok(reply.trim());report.reply=reply;report.checks.push('receive real model chat response');
  const collect=createCollector(workspace);
  const snapshot=await collect();assert.equal(snapshot.status,'live');assert.ok(snapshot.nodes.some(node=>node.models.includes(alias)));report.checks.push('CLI telemetry → normalized snapshot → ready verdict');
  viewer=createViewer({workspace,collect,intervalMs:1000});const viewerPort=await viewer.start();
  let served;
  for(let retry=0;retry<20;retry++){served=await(await fetch(`http://127.0.0.1:${viewerPort}/api/snapshot`)).json();if(served.nodes.length)break;await new Promise(done=>setTimeout(done,250));}
  assert.ok(served.nodes.some(node=>node.models.includes(alias)));report.checks.push('live HTTP viewer observes deployed model');
  const engines=JSON.parse((await run(['engines',name,'--json'])).stdout);
  const target=engines.find(engine=>engine.models.includes(alias));assert.ok(target);
  await run(['leave',name,'--engine',target.engine]);
  // Local Grid expires a stopped child at its 60 s heartbeat TTL if shutdown could not unregister.
  // Verify convergence, never equate a successful leave command with completed discovery removal.
  const leaveAt=Date.now();let remaining=[];
  do {
    remaining=JSON.parse((await run(['models',name,'--json'])).stdout);
    if(!remaining.some(row=>row.model===alias))break;
    await new Promise(done=>setTimeout(done,2000));
  } while(Date.now()-leaveAt<80_000);
  assert.ok(!remaining.some(row=>row.model===alias),'stopped model must disappear from discovery within 80 seconds');
  report.undeployConvergenceMs=Date.now()-leaveAt;report.checks.push('undeploy exact engine and verify model removed');
  const after=await collect();assert.equal(after.summary.modelsServing,0);report.checks.push('viewer observes removal');
  report.result='passed';
}catch(error){report.result='failed';report.error=error.message;process.exitCode=1;}
finally{
  await viewer?.close();
  for(const args of [['leave',name,'--all'],['stop',name],['delete',name,'--yes']]){
    const result=await run(args,{allowFailure:true,timeoutMs:70_000});report.cleanup.push({command:args[0],code:result.code});
    if(result.code!==0){report.result='failed';process.exitCode=1;}
  }
  report.finishedAt=now();await atomicJson(join(workspace,'report.json'),report);console.log(JSON.stringify(report,null,2));
}
