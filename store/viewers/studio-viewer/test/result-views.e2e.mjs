// Rendering contracts for optional native results. These explicit fixtures do not run applications.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createStudio} from '../server.mjs';

const viewer=fileURLToPath(new URL('../',import.meta.url));
const agents=fileURLToPath(new URL('../../../agents/',import.meta.url));
const root=await mkdtemp(join(tmpdir(),'studio-native-view-fixtures-'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const scenarios=[['juce-agent-toolkit','Native JUCE · fixture','JUCE RECORDING'],['autoresearch-mlx','Native MLX','MLX EXPERIMENT'],['comfy-mcp','Native ComfyUI · fixture','COMFYUI OUTPUTS']];
try{
  for(const [name,engine,badge] of scenarios){
    const packageDir=join(agents,name),workspace=join(root,name);await cp(join(packageDir,'template'),workspace,{recursive:true});
    const project=JSON.parse(await readFile(join(workspace,'studio.json'),'utf8'));
    await mkdir(join(workspace,'out/runs/fixture'),{recursive:true});
    const result={spec:1,id:'fixture',title:'Native result rendering fixture',description:'An isolated UI contract fixture',createdAt:new Date().toISOString(),engine,parameters:project.parameters,metrics:[],artifacts:[],data:{}};
    const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    if(name==='comfy-mcp'){
      const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=80;const x=c.getContext('2d');x.fillStyle='#759576';x.fillRect(0,0,80,80);return c.toDataURL().split(',')[1];});
      await writeFile(join(workspace,'out/runs/fixture/image.png'),Buffer.from(png,'base64'));
      result.artifacts=[{label:'Fixture PNG',path:'out/runs/fixture/image.png'}];result.data={images:[{seed:null,name:'image.png'}]};
    }
    await writeFile(join(workspace,'out/latest.json'),JSON.stringify(result));await writeFile(join(workspace,'out/runs/fixture/result.json'),JSON.stringify(result));
    const studio=await createStudio({workspace,packageDir});
    try{
      await page.coverage.startJSCoverage({resetOnNavigation:false});await page.goto(studio.url);
      await page.waitForFunction(()=>document.getElementById('connection').textContent==='Workspace connected');
      assert.equal(await page.locator('.domain-badge').textContent(),badge);
      if(name==='comfy-mcp'){
        await page.getByRole('button',{name:'Inspect image 1',exact:true}).click();
        await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('dialog').getByRole('heading').textContent(),'ComfyUI output');
        await page.getByRole('button',{name:'Close',exact:true}).click();
      }
      assert.deepEqual(errors,[]);
      const coverage=await page.coverage.stopJSCoverage();await writeFile(join(viewer,'test-results',`${name}--native-fixture-browser-coverage.json`),JSON.stringify(coverage));
      console.log(`PASS ${name}: native result rendering contract`);
    }finally{await context.close();await studio.close();}
  }
}finally{await browser.close();await rm(root,{recursive:true,force:true});}
