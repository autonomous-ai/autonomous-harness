import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createStudio} from '../server.mjs';

const root=await mkdtemp(join(tmpdir(),'studio-ui-')),workspace=join(root,'workspace'),packageDir=join(root,'package');
await mkdir(workspace);await mkdir(join(packageDir,'toolchain'),{recursive:true});
const config={title:'Interaction lab',description:'An isolated viewer test',category:'Testing',scene:'Workbench',hint:'Try an idea',tip:'Saved results survive failures',credit:'Test fixture',previewLabel:'Ready to explore',empty:'Make your first artifact',
  controls:[{id:'size',label:'Size',type:'number',min:1,max:9,value:3,integer:true,hint:'One small change'},
    {id:'caption',label:'Caption',type:'text',value:'hello',maxLength:30},{id:'note',label:'Note',type:'text',value:''},
    {id:'shape',label:'Shape',type:'select',value:'round',options:[{value:'round',label:'Round'},{value:'square',label:'Square'}]}],
  actions:[{id:'make',label:'Make artifact'},{id:'fail',label:'Test failed run'},{id:'slow',label:'Test long run'}]};
let project={spec:1,parameters:Object.fromEntries(config.controls.map(c=>[c.id,c.value]))};
const save=async()=>writeFile(join(workspace,'studio.json'),JSON.stringify(project));await save();
await writeFile(join(packageDir,'studio.config.json'),JSON.stringify(config));
await writeFile(join(packageDir,'view.mjs'),`export function mount(stage,api){const button=document.createElement('button');button.textContent='Make from canvas';button.onclick=()=>{api.run();api.run();};stage.append(button);return {update(){},destroy(){}};}`);
await writeFile(join(packageDir,'toolchain/run.sh'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const action=process.argv[2];
if(action==='fail'){console.error('Fixture failed on purpose');process.exit(7);}
else if(action==='slow'){console.log('Waiting for cancellation');setInterval(()=>{},1000);}
else{
 const root=process.env.HARNESS_WORKSPACE,id='run-'+Date.now(),out=path.join(root,'out/runs',id);
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'hello.txt'),'A saved idea');
 const result={id,title:'A saved idea',description:'An actual fixture artifact',engine:'Local test fixture',parameters:JSON.parse(fs.readFileSync(path.join(root,'studio.json'))).parameters,
 createdAt:new Date().toISOString(),metrics:[{label:'Ideas',value:1,unit:''}],artifacts:[{label:'Text',path:'out/runs/'+id+'/hello.txt'}]};
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result));fs.writeFileSync(path.join(root,'out/latest.json'),JSON.stringify(result));
}
`,{mode:0o755});
const studio=await createStudio({workspace,packageDir});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.coverage.startJSCoverage({resetOnNavigation:false});
const connected=()=>page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');
const notice=message=>page.waitForFunction(m=>document.getElementById('notice').textContent.includes(m),message);
const state=async()=>(await fetch(studio.url+'/api/state')).json();
try{
  // A transient module response must recover, including the module import cache.
  let attempts=0;
  await page.route('**/domain.mjs*',async route=>{if(attempts++===0)await route.fulfill({status:503,contentType:'text/javascript',body:'Unavailable'});else await route.continue();});
  await page.goto(studio.url);await connected();assert.ok(attempts>=2);await page.unroute('**/domain.mjs*');
  assert.match(await page.locator('#history').textContent(),/first run/);assert.equal(await page.locator('#result-title').textContent(),'Your next idea starts here');
  project.parameters.caption='Saved by the agent';await save();await page.waitForFunction(()=>document.querySelector('[name=caption]').value==='Saved by the agent');
  await page.getByLabel('Caption').fill('A small experiment');await page.getByLabel('Note',{exact:true}).fill('keep me');
  await page.getByLabel('Shape',{exact:true}).selectOption('square');
  await page.getByRole('button',{name:'Make from canvas',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#history button').length===1);
  const first=await state();assert.equal(first.project.parameters.caption,'A small experiment');assert.equal(first.project.parameters.note,'keep me');
  assert.equal(first.history.length,1,'double canvas click must only start one run');
  // A draft cannot overwrite a new agent edit, even after the polling revision advances.
  await page.getByLabel('Caption').fill('Older unsaved draft');
  project={...first.project,parameters:{...first.project.parameters,caption:'New agent edit'}};await save();
  await page.locator('#remote').waitFor({state:'visible'});await page.getByRole('button',{name:'Make artifact',exact:true}).click();await notice('agent changed');
  assert.equal((await state()).project.parameters.caption,'New agent edit');
  await page.getByRole('button',{name:'Load update',exact:true}).click();assert.equal(await page.getByLabel('Caption').inputValue(),'New agent edit');
  await page.route('**/api/run?id=*',route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'History temporarily unavailable'})}));
  await page.locator('#history button').click();await notice('History temporarily unavailable');await page.unroute('**/api/run?id=*');
  await page.locator('#history button').click();await page.getByRole('button',{name:'Back to latest'}).click();
  await page.getByRole('button',{name:'Test failed run',exact:true}).click();await notice('Fixture failed on purpose');
  assert.equal((await state()).result.id,first.result.id);assert.equal(await page.locator('#artifacts a').count(),1);
  await page.getByRole('button',{name:'Test long run',exact:true}).click();await page.getByRole('button',{name:'Stop run'}).waitFor();
  await page.route('**/api/cancel',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Try stopping again'})}));
  await page.getByRole('button',{name:'Stop run'}).click();await notice('Try stopping again');await page.unroute('**/api/cancel');
  await page.getByRole('button',{name:'Stop run'}).click();await notice('Run stopped');assert.equal((await state()).result.id,first.result.id);
  await page.getByRole('button',{name:'Reset controls',exact:true}).click();
  await page.getByRole('button',{name:'Make artifact',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#history button').length===2);
  // A delayed poll must not build a second viewer while the first refresh is pending.
  let polls=0;
  await page.route('**/api/state',async route=>{polls++;await new Promise(r=>setTimeout(r,1500));await route.continue();});
  await page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');
  await new Promise(r=>setTimeout(r,2800));assert.equal(await page.getByRole('button',{name:'Make from canvas'}).count(),1);assert.ok(polls<3);
  await page.unroute('**/api/state');
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>dispatchEvent(new Event('pagehide')));
  const coverage=await page.coverage.stopJSCoverage();
  const output=fileURLToPath(new URL('../test-results/',import.meta.url));await mkdir(output,{recursive:true});
  await writeFile(join(output,'ui-browser-coverage.json'),JSON.stringify(coverage));
  await writeFile(join(output,'ui-report.json'),JSON.stringify({status:'passed',checks:['empty state','module recovery','clean agent edit','text controls','canvas run','duplicate click','stale draft protection','history failure','failed run retention','cancel error','cancel run','retry','single refresh','page cleanup']},null,2));
  console.log('PASS viewer recovery: 14 interaction checks');
}finally{await browser.close();await studio.close();await rm(root,{recursive:true,force:true});}
