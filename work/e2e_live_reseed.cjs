// e2e_live_reseed.cjs — REAL user-flow E2E against the INSTALLED web-viewer runtime.
// Simulates the daemon: agent rewrites artifact -> fs.watch -> SSE change -> open pane
// re-issues iframe src with a fresh ?v= cache-bust (the viewer's own reload()). Uses a
// scratch workspace copy so the store template is untouched. The iframe src is readable
// from the shell (not cross-origin), so this is the airtight live-reload signal; the
// template also animates, so we use src-change (not pixel diff) as the proof.
const { chromium } = require('/tmp/wv_ui/node_modules/playwright-core');
const { spawn } = require('node:child_process');
const { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');

const VIEWER = '/Users/d/.harness/dsh/autonomous/web-viewer/viewer.mjs';
const SRC = '/private/tmp/harness-store-voxel/store/agents/generative-art/template';
const ART = 'sketch/index.html';

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));}); });

async function main(){
  const ws = mkdtempSync(join(tmpdir(),'e2e-live-'));
  cpSync(SRC, ws, { recursive: true });
  const artPath = join(ws, ART);
  const orig = readFileSync(artPath,'utf8');

  const port = await freePort();
  const v = spawn('node',[VIEWER],{ env:{ ...process.env, HARNESS_WORKSPACE: ws, HARNESS_VIEWER_PORT:String(port) }});
  await new Promise(r=>setTimeout(r,1000));
  const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true });
  const page = await browser.newPage();
  const out = [];

  const src = () => page.evaluate(()=>{ const f=document.querySelector('iframe'); return f? f.src : 'NO_IFRAME'; });
  const frameRenders = () => page.evaluate(()=>{ const f=document.querySelector('iframe'); if(!f) return false; try{ return f.contentDocument && f.contentDocument.querySelectorAll('canvas').length>0; }catch{ return false; } });

  try {
    await page.goto(`http://127.0.0.1:${port}/?file=${encodeURIComponent(ART)}`,{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(1500);
    const base = await src();
    out.push(`pane loaded artifact iframe: ${base.includes('/files/')}`);
    out.push(`artifact frame has a canvas: ${await frameRenders()}`);

    // RE-SEED 1
    writeFileSync(artPath, orig.replace('#0b0b12','#00ff88'),'utf8');
    await page.waitForTimeout(2000);
    const s1 = await src();
    out.push(`re-seed #1 live-reloaded the pane (src ?v= changed): ${s1!==base}`);
    out.push(`  src went ${base.split('?v=')[1]} -> ${s1.split('?v=')[1]}`);

    // RE-SEED 2
    writeFileSync(artPath, orig.replace('#0b0b12','#ff0055'),'utf8');
    await page.waitForTimeout(2000);
    const s2 = await src();
    out.push(`re-seed #2 live-reloaded the pane again (src ?v= changed): ${s2!==s1}`);
    out.push(`  src went ${s1.split('?v=')[1]} -> ${s2.split('?v=')[1]}`);

    // Manual Reload button still works after changes
    await page.evaluate(()=>document.querySelector('#reload').click());
    await page.waitForTimeout(1200);
    const s3 = await src();
    out.push(`manual Reload button refreshes the pane (src ?v= changed): ${s3!==s2}`);
  } finally {
    try{v.kill();}catch{}
    try{await browser.close();}catch{}
    rmSync(ws,{recursive:true,force:true});
  }
  console.log('\n==== E2E: live re-seed through INSTALLED web-viewer runtime ====');
  out.forEach(x=>console.log('  '+x));
}
main().catch(e=>{console.error('FATAL',e.message);process.exit(2);});
