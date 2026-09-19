// e2e_all.cjs — live re-seed E2E across EVERY harness, through the installed viewer.
// For each harness: copy template to scratch -> launch installed web-viewer -> open the
// artifact -> agent rewrites the artifact -> assert the open pane live-reloads (iframe
// src ?v= cache-bust). The ?v= bump is the viewer's own SSE->reload() signal.
const { chromium } = require('/tmp/wv_ui/node_modules/playwright-core');
const { spawn } = require('node:child_process');
const { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const net = require('node:net');

const VIEWER = '/Users/d/.harness/dsh/autonomous/web-viewer/viewer.mjs';
const STORE = '/private/tmp/harness-store-voxel/store/agents';
const HARNESSES = [
  'creative-direction', 'drone-pilot', 'game-master', 'generative-art',
  'lab-bench', 'music-studio', 'voxel-worlds',
];
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));}); });

// find the single .html artifact under a template dir (recursive)
function findArtifact(template){
  const walk=(d)=>{ for(const e of readdirSync(d)){ const p=join(d,e); if(statSync(p).isDirectory()){ const f=walk(p); if(f) return f; } else if(e.endsWith('.html')) return p; } return null; };
  return walk(template);
}

async function one(name, browser){
  const template = join(STORE, name, 'template');
  const art = findArtifact(template);
  if(!art) return { name, ok:false, why:'no html artifact' };
  const artRel = art.slice(template.length+1);

  const ws = mkdtempSync(join(tmpdir(),'e2e-all-'));
  cpSync(template, ws, { recursive:true });
  const artPath = join(ws, artRel);
  const orig = readFileSync(artPath,'utf8');
  const size = orig.length;

  const port = await freePort();
  const v = spawn('node',[VIEWER],{ env:{ ...process.env, HARNESS_WORKSPACE: ws, HARNESS_VIEWER_PORT:String(port) }});
  await new Promise(r=>setTimeout(r,1000));
  const page = await browser.newPage();
  const src = () => page.evaluate(()=>{ const f=document.querySelector('iframe'); return f? f.src : 'NO_IFRAME'; });

  try {
    await page.goto(`http://127.0.0.1:${port}/?file=${encodeURIComponent(artRel)}`,{waitUntil:'domcontentloaded'});
    await page.waitForTimeout(1500);
    const base = await src();
    if(!base.includes('/files/')) { return { name, ok:false, why:'shell did not load iframe' }; }

    // re-seed: append a comment to the html (safe for all; keeps determinism of reload signal)
    const changed = orig + '\n<!-- reseed ' + Date.now()+' -->\n';
    writeFileSync(artPath, changed, 'utf8');
    await page.waitForTimeout(2000);
    const s1 = await src();
    const reloaded = s1!==base;

    // sanity: artifact still served
    const served = await fetch(`http://127.0.0.1:${port}/files/${encodeURIComponent(artRel)}`).then(r=>r.status===200).catch(()=>false);
    return { name, ok: reloaded && served, reloaded, served, size, who:'installed viewer' };
  } finally {
    try{v.kill();}catch{}
    try{await page.close();}catch{}
    rmSync(ws,{recursive:true,force:true});
  }
}

async function main(){
  const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true });
  const results = [];
  for (const name of HARNESSES) results.push(await one(name, browser));
  await browser.close();
  const all = results.every(r=>r.ok);
  console.log('\n==== E2E matrix: live re-seed, ALL harnesses, installed viewer ====');
  for (const r of results) console.log(`  ${r.ok?'PASS':'FAIL'}  ${r.name}  (reloaded=${r.reloaded??'?'} served=${r.served??'?'} ${r.why||''})`.trim());
  console.log(all ? 'ALL PASS' : 'SOME FAILED');
  process.exit(all?0:1);
}
main().catch(e=>{console.error('FATAL',e.message);process.exit(2);});
