import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,stat,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {chromium,webkit} from 'playwright';
import {createStudio} from '../server.mjs';

const viewer=fileURLToPath(new URL('../',import.meta.url));
const agents=fileURLToPath(new URL('../../../agents/',import.meta.url));
const names=(process.env.STUDIO_TEST_PACKAGES??'juce-agent-toolkit,foam-agent,autoresearch-mlx,ableton-ai,dimos,simskill,bonsai-mcp,comfy-mcp').split(',');
const webkitRun=process.env.STUDIO_TEST_BROWSER==='webkit';
const output=join(viewer,'test-results',...(webkitRun?['webkit']:[]));await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'harness-studio-browser-'));
const browser=webkitRun?await webkit.launch({headless:true}):await chromium.launch({channel:process.env.STUDIO_BROWSER_CHANNEL??'chrome',headless:true});
const report=[];
const exec=(command,args,cwd,env={})=>new Promise((ok,fail)=>{const p=spawn(command,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let log='';p.stdout.on('data',b=>{log+=b;});p.stderr.on('data',b=>{log+=b;});p.on('error',fail);p.on('close',code=>code===0?ok(log):fail(Error(log)));});
const domains={
  'juce-agent-toolkit':async page=>{await page.getByRole('button',{name:'Play C',exact:true}).click();await page.keyboard.press('a');await page.getByRole('button',{name:'Play recording',exact:true}).click();await page.getByRole('button',{name:'Stop recording',exact:true}).click();await page.getByRole('button',{name:'Surprise me',exact:true}).click();},
  'foam-agent':async page=>{await page.getByRole('button',{name:'Show pressure',exact:true}).click();await page.getByRole('button',{name:'Show velocity',exact:true}).click();await page.getByRole('button',{name:'Show vectors',exact:true}).click();await page.getByRole('button',{name:'Hide vectors',exact:true}).click();await page.getByRole('button',{name:'Release tracers',exact:true}).click();await page.locator('canvas').click({position:{x:40,y:100}});},
  'autoresearch-mlx':async page=>{await page.getByRole('button',{name:'Hide held-out score',exact:true}).click();await page.getByRole('button',{name:'Show held-out score',exact:true}).click();await page.locator('canvas').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowLeft');await page.getByRole('button',{name:'Try another seed',exact:true}).click();},
  'ableton-ai':async page=>{await page.getByRole('button',{name:'Play loop',exact:true}).click();await page.getByRole('button',{name:'Pause loop',exact:true}).click();await page.getByRole('button',{name:'New variation',exact:true}).click();await page.locator('canvas').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Play WAV',exact:true}).click();},
  'dimos':async page=>{await page.getByRole('button',{name:'Hide route',exact:true}).click();await page.getByRole('button',{name:'Show route',exact:true}).click();await page.getByRole('button',{name:'Replay mission',exact:true}).click();await page.getByRole('slider',{name:'Mission replay position'}).focus();await page.keyboard.press('ArrowRight');await page.locator('canvas').focus();await page.keyboard.press('ArrowLeft');},
  'simskill':async page=>{await page.getByRole('button',{name:'Pause traffic',exact:true}).click();await page.getByRole('button',{name:'Play traffic',exact:true}).click();await page.getByRole('button',{name:'8× speed',exact:true}).click();await page.getByRole('button',{name:'16× speed',exact:true}).click();await page.getByRole('button',{name:'1× speed',exact:true}).click();await page.getByRole('button',{name:'Follow a car',exact:true}).click();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:join(output,'simskill-follow.png'),fullPage:true});await page.getByRole('button',{name:'See the city',exact:true}).click();await page.getByRole('slider',{name:'Traffic replay position'}).focus();await page.keyboard.press('ArrowRight');},
  'bonsai-mcp':async page=>{await page.getByRole('button',{name:'Floor plan',exact:true}).click();await page.getByRole('button',{name:'Next room',exact:true}).click();await page.getByRole('button',{name:'Orbit view',exact:true}).click();await page.getByRole('button',{name:'Separate floors',exact:true}).click();await page.getByRole('button',{name:'Bring together',exact:true}).click();const box=await page.locator('canvas').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+100);await page.mouse.down();await page.mouse.move(box.x+box.width/2+70,box.y+100,{steps:5});await page.mouse.up();await page.locator('canvas').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Floor plan',exact:true}).click();await page.locator('canvas').click({position:{x:box.width/2,y:box.height/2}});await page.getByRole('button',{name:'Orbit view',exact:true}).click();},
  'comfy-mcp':async page=>{await page.locator('.gallery button').first().click();await page.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Inspect favourite',exact:true}).click();await page.keyboard.press('Escape');await page.getByRole('button',{name:'Another family',exact:true}).click();},
};
try{
  for(const name of names){
    const packageDir=join(agents,name),workspace=join(root,name);await cp(join(packageDir,'template'),workspace,{recursive:true});
    const manifest=JSON.parse(await readFile(join(packageDir,'harness.json'),'utf8'));
    const config=JSON.parse(await readFile(join(packageDir,'studio.config.json'),'utf8'));
    const doctor=await exec(join(packageDir,'toolchain/doctor.sh'),[],packageDir);
    const init=await exec(join(packageDir,manifest.workspace.init),[],workspace,{HARNESS_DSH_DIR:packageDir,HARNESS_WORKSPACE:workspace});
    let verdict=JSON.parse(await readFile(join(workspace,'.harness/verdict.json'),'utf8'));assert.equal(verdict.ready,true);assert.ok((await stat(join(workspace,verdict.artifact))).size>0);
    const studio=await createStudio({workspace,packageDir});
    const context=await browser.newContext({viewport:{width:1280,height:1000},acceptDownloads:true});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const requests=[];page.on('requestfailed',r=>requests.push(`${r.method()} ${r.url()}: ${r.failure()?.errorText}`));
    if(!webkitRun)await page.coverage.startJSCoverage({resetOnNavigation:false});
    try{
      await page.goto(studio.url);await page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');
      assert.equal(await page.locator('h1').textContent(),config.title);
      await page.locator('#run').waitFor({state:'visible'});
      await page.waitForFunction(()=>document.querySelector('#stage canvas')||document.querySelector('.gallery img')?.complete);
      if(name==='simskill'){
        const recorded=await(await fetch(studio.url+'/api/state')).json();const stopped=recorded.result.data.frames.findIndex(f=>f.cars.some(car=>car.speed<.1));assert.ok(stopped>=0);
        await page.getByRole('slider',{name:'Traffic replay position'}).evaluate((input,index)=>{input.value=index;input.dispatchEvent(new Event('input',{bubbles:true}));},stopped);
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      }
      await page.screenshot({path:join(output,`${name}-wide.png`),fullPage:true});
      // A workspace with no successful output must still have usable previews and controls.
      await rename(join(workspace,'out'),join(workspace,'saved-output'));
      await page.reload();await page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#artifacts a').count(),0);
      if(name==='juce-agent-toolkit')await page.getByRole('button',{name:'Play recording',exact:true}).click();
      if(name==='ableton-ai'){await page.getByRole('button',{name:'Play WAV',exact:true}).click();await page.getByRole('button',{name:'Play loop',exact:true}).click();await page.getByRole('button',{name:'Pause motion',exact:true}).click();await page.getByRole('button',{name:'Resume motion',exact:true}).click();}
      if(name==='comfy-mcp')await page.getByRole('button',{name:'Inspect favourite',exact:true}).click();
      await rename(join(workspace,'saved-output'),join(workspace,'out'));
      await page.reload();await page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');
      await domains[name](page);
      const first=await (await fetch(studio.url+'/api/state')).json();
      for(const c of config.controls.filter(c=>!c.hidden)){
        const input=page.locator(`[name="${c.id}"]`);
        if(c.type==='number'){await input.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowLeft');}
        else if(c.type==='select'){for(const choice of c.options){await input.selectOption(choice.value);if(name==='bonsai-mcp'&&c.id==='use'){await page.getByRole('button',{name:'Floor plan',exact:true}).click();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.getByRole('button',{name:'Orbit view',exact:true}).click();}await page.evaluate(()=>new Promise(requestAnimationFrame));}await input.selectOption(c.value);}
        else await input.fill(c.value);
      }
      // Keep the default valid robot goal after exercising map movement.
      await page.getByRole('button',{name:'Reset controls',exact:true}).click();
      await page.getByRole('button',{name:config.actions[0].label,exact:true}).click();
      await page.waitForFunction(async old=>{const s=await(await fetch('/api/state')).json();if(s.job?.status==='failed')throw Error(s.job.message);return s.job?.status==='done'&&s.result.id!==old;},first.result.id,{timeout:120000});
      await page.waitForFunction(()=>document.querySelectorAll('#history button').length>=2);
      const current=await (await fetch(studio.url+'/api/state')).json();assert.notEqual(current.result.id,first.result.id);
      for(const a of current.result.artifacts){const r=await fetch(studio.url+'/artifacts/'+a.path);assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>0);}
      const downloading=page.waitForEvent('download');await page.locator('.artifact').first().click();const download=await downloading;await download.saveAs(join(output,`${name}-download-${download.suggestedFilename()}`));assert.equal(await download.failure(),null);
      await page.locator('#history button').last().click();await page.getByRole('button',{name:'Back to latest'}).waitFor();await page.getByRole('button',{name:'Back to latest'}).click();
      await page.getByRole('button',{name:'Pause motion',exact:true}).click();assert.equal(await page.locator('#motion').getAttribute('aria-pressed'),'false');await page.getByRole('button',{name:'Resume motion',exact:true}).click();
      // A concurrent agent edit must not be overwritten by an older UI draft.
      const c=config.controls.find(c=>c.type==='number');await page.locator(`[name="${c.id}"]`).focus();await page.keyboard.press('ArrowRight');
      const project=JSON.parse(await readFile(join(workspace,'studio.json'),'utf8'));project.title+=' · edited by agent';await writeFile(join(workspace,'studio.json'),JSON.stringify(project));
      await page.locator('#remote').waitFor({state:'visible'});await page.getByRole('button',{name:config.actions[0].label,exact:true}).click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('agent changed'));assert.equal(JSON.parse(await readFile(join(workspace,'studio.json'),'utf8')).title,project.title);await page.getByRole('button',{name:'Load update',exact:true}).click();
      await page.reload();await page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');assert.equal((await(await fetch(studio.url+'/api/state')).json()).history.length,2);
      await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,`${name}-narrow.png`),fullPage:true});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'narrow layout must not scroll horizontally');
      await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');assert.equal(await page.locator('#motion').getAttribute('aria-pressed'),'false');
      // Malformed agent output surfaces an error and recovers without losing artifacts.
      const source=await readFile(join(workspace,'studio.json'),'utf8');await writeFile(join(workspace,'studio.json'),'unfinished');await page.waitForFunction(()=>document.getElementById('connection').textContent==='Reconnecting');await writeFile(join(workspace,'studio.json'),source);await page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');
      assert.deepEqual(errors,[],`${name}: browser errors`);assert.deepEqual(requests,[],`${name}: failed resource requests`);
      if(!webkitRun){const coverage=await page.coverage.stopJSCoverage();await writeFile(join(output,`${name}-browser-coverage.json`),JSON.stringify(coverage));}
      report.push({name,status:'passed',artifactCount:current.result.artifacts.length,engine:current.result.engine,workflows:['doctor','initialization','viewer','empty state','all controls','domain interactions','run','artifacts','download','history','pause','agent edit','stale draft protection','reload','narrow layout','reduced motion','malformed project recovery']});
      console.log(`PASS ${name}: ${report.at(-1).workflows.length} workflow checks, ${current.result.artifacts.length} artifacts`);
    }finally{await context.close();await studio.close();}
  }
}finally{await browser.close();await writeFile(join(output,'browser-report.json'),JSON.stringify(report,null,2));if(process.env.KEEP_STUDIO_TEST_WORKSPACES)console.log(`Workspaces: ${root}`);else await rm(root,{recursive:true,force:true});}
