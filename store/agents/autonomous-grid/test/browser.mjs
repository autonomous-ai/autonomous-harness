// Visual/interaction QA against the real viewer, with an explicitly labelled telemetry fixture.
// GRID_TEST_PLAYWRIGHT is the path to an installed Playwright entrypoint; no shipped browser dependency.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViewer } from '../viewer.mjs';
import { assemble, normalizeDevice } from '../lib/telemetry.mjs';
import { config, device, reads } from './fixtures.mjs';

if(!process.env.GRID_TEST_PLAYWRIGHT)throw new Error('Set GRID_TEST_PLAYWRIGHT to an installed Playwright entrypoint.');
const {chromium}=await import(pathToFileURL(process.env.GRID_TEST_PLAYWRIGHT).href);
const workspace=await mkdtemp(join(tmpdir(),'grid-browser-'));
const output=resolve(process.env.GRID_TEST_OUTPUT || workspace);await mkdir(output,{recursive:true});
let fixture;
for(let i=0;i<30;i++)fixture=assemble(config,reads,fixture,new Date(Date.now()-(29-i)*8000).toISOString());
fixture.grid='Home lab · test fixture';fixture.machines=[{...normalizeDevice(config.machines[0],device,new Date().toISOString()),reachable:true}];fixture.operations=[];
const viewer=createViewer({workspace,intervalMs:200,collect:async()=>fixture});
const port=await viewer.start();
const browser=await chromium.launch({headless:true,...(process.env.GRID_TEST_BROWSER?{executablePath:process.env.GRID_TEST_BROWSER}:{})});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.locator('.node').first().waitFor();await page.waitForTimeout(300);
  assert.equal(await page.locator('.node').count(),8);
  await page.screenshot({path:join(output,'grid-topology.png'),fullPage:true});
  await page.locator('.node').filter({hasText:'GPU workstation'}).click();await page.locator('.inspector h2').filter({hasText:'GPU workstation'}).waitFor();
  assert.match(await page.locator('.inspector').innerText(),/109\.4/);assert.match(await page.locator('.inspector').innerText(),/67/);
  await page.screenshot({path:join(output,'grid-engine.png'),fullPage:true});
  await page.selectOption('#metric','temperatureC');assert.match(await page.locator('.node').filter({hasText:'GPU workstation'}).innerText(),/67/);
  await page.click('#rack-button');assert.equal(await page.locator('.rack-engine').count(),8);assert.equal(await page.locator('#topology').isVisible(),false);
  await page.screenshot({path:join(output,'grid-rack.png'),fullPage:true});
  await page.click('#topology-button');await page.click('#motion');assert.equal(await page.locator('#motion').innerText(),'Resume motion');
  const overlaps=[];
  for(const size of [1440,1024,820,736,540,390,320]){
    await page.setViewportSize({width:size,height:1100});await page.waitForTimeout(150);
    const layout=await page.evaluate(()=>{
      const nodes=[...document.querySelectorAll('.node')].map(n=>({name:n.querySelector('.node-name').textContent,r:n.getBoundingClientRect()}));
      const collisions=[];
      for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const a=nodes[i].r,b=nodes[j].r;if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)collisions.push([nodes[i].name,nodes[j].name]);}
      return {overflow:document.documentElement.scrollWidth>innerWidth,collisions};
    });
    assert.equal(layout.overflow,false,`horizontal overflow at ${size}`);if(layout.collisions.length)overlaps.push({width:size,collisions:layout.collisions});
    if(size===390)await page.screenshot({path:join(output,'grid-mobile.png'),fullPage:true});
  }
  assert.deepEqual(overlaps,[],'machine cards overlap');
  fixture={...fixture,status:'unavailable',nodes:fixture.nodes.map(n=>({...n,stale:true})),sources:{engines:{ok:false,error:'Test connection interrupted'}}};
  await page.waitForFunction(()=>document.getElementById('connection-label').textContent==='Grid unavailable');
  assert.equal(await page.locator('.node.stale').count(),8);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',widths:[1440,1024,820,736,540,390,320],checks:['topology','engine inspector','metric switch','rack view','pause motion','no overlap','no horizontal overflow','stale telemetry'],output},null,2));
}finally{await browser.close();await viewer.close();await rm(workspace,{recursive:true,force:true});}
