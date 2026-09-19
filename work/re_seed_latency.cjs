// re_seed_latency.cjs — how fast does the user see a re-seed land in the open pane?
// The daemon flow, timed in a real browser: agent writes artifact -> ws.watch (80ms debounce)
// -> SSE change -> pane reload() sets a new iframe src ?v= -> browser fetches + paints.
// We time from the write until the iframe src ?v= changes (the moment the new frame request starts).
const { chromium } = require('/tmp/wv_ui/node_modules/playwright-core');
const { spawn } = require('node:child_process');
const { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');
const { performance } = require('node:perf_hooks');

const VIEWER = '/Users/d/.harness/dsh/autonomous/web-viewer/viewer.mjs';
const SRC = '/private/tmp/harness-store-voxel/store/agents/generative-art/template';
const ART = 'sketch/index.html';
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));}); });

async function main(){
  const ws = mkdtempSync(join(tmpdir(),'rsl-'));
  cpSync(SRC, ws, { recursive:true });
  const artPath = join(ws, ART);
  const orig = readFileSync(artPath,'utf8');
  const port = await freePort();
  const v = spawn('node',[VIEWER],{ env:{...process.env,HARNESS_WORKSPACE:ws,HARNESS_VIEWER_PORT:String(port)}});
  await new Promise(r=>setTimeout(r,1000));
  const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/?file=${encodeURIComponent(ART)}`,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1300);

  const reads=[];
  for(let i=0;i<5;i++){
    const before = await page.evaluate(()=>document.querySelector('iframe').src);
    const t0=performance.now();
    writeFileSync(artPath, orig+`\n<!-- reseed ${i} ${Date.now()} -->\n`,'utf8');
    let after=before, elapsed=-1;
    const stop=performance.now()+6000;
    while(performance.now()<stop){
      await page.waitForTimeout(20);
      after = await page.evaluate(()=>document.querySelector('iframe').src);
      if(after!==before){ elapsed=performance.now()-t0; break; }
    }
    reads.push({ n:i, srcChanged: after!==before, ms: Math.round(elapsed) });
    await page.waitForTimeout(300); // let the new frame paint before next write
  }
  v.kill(); await browser.close(); rmSync(ws,{recursive:true,force:true});

  const ok=reads.filter(r=>r.srcChanged);
  const avg=ok.length? Math.round(ok.reduce((a,b)=>a+b.ms,0)/ok.length):0;
  console.log('\n==== re-seed user-visible latency (write -> pane starts new frame) ====');
  for(const r of reads) console.log(`  reseed ${r.n}: ${r.srcChanged? r.ms+'ms':'TIMEOUT'}`);
  console.log(`avg ${avg}ms across ${ok.length}/${reads.length} (watcher debounce is 80ms)`);
}
main().catch(e=>{console.error('FATAL',e.message);process.exit(2);});
