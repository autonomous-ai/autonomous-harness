// perf.cjs — measure the viewer's real per-interaction latency and profile the hot path.
// Two numbers a user feels: (a) request latency for shell + artifact fetches; (b) the
// re-seed path: file write -> SSE 'change' -> pane reload issues a new GET -> new frame.
// Then report where time goes so we can hill-climb.
const { spawn } = require('node:child_process');
const { cpSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { performance } = require('node:perf_hooks');

const VIEWER = '/Users/d/.harness/dsh/autonomous/web-viewer/viewer.mjs';
const SRC = '/private/tmp/harness-store-voxel/store/agents/generative-art/template';
const ART = 'sketch/index.html';
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));}); });

const reqOnce = (port, path) => new Promise((resolve) => {
  const t0 = performance.now();
  const r = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode, ms: performance.now()-t0, bytes: Number(res.headers['content-length']||0) }));
  });
  r.on('error', (e) => resolve({ err: e.message }));
});

async function main(){
  const ws = mkdtempSync(join(tmpdir(),'perf-'));
  cpSync(SRC, ws, { recursive:true });
  const artPath = join(ws, ART);
  const port = await freePort();
  const v = spawn('node',[VIEWER],{ env:{...process.env,HARNESS_WORKSPACE:ws,HARNESS_VIEWER_PORT:String(port)}});
  await new Promise(r=>setTimeout(r,900));

  // (a) request latency, warm, N each
  const N = 200;
  const shells=[], files=[];
  for(let i=0;i<N;i++){ shells.push((await reqOnce(port,'/')).ms); files.push((await reqOnce(port,'/files/'+ART)).ms); }
  const pct=(a,p)=>{ const s=[...a].sort((x,y)=>x-y); return s[Math.min(s.length-1, Math.floor(s.length*p/100))].toFixed(2); };
  const med=a=>pct(a,50);
  console.log('--- request latency (',N,'warm each) ---');
  console.log(`SHELL  median ${med(shells)}ms  p95 ${pct(shells,95)}ms  p99 ${pct(shells,99)}ms`);
  console.log(`FILES  median ${med(files)}ms  p95 ${pct(files,95)}ms  p99 ${pct(files,99)}ms`);

  // (b) re-seed latency: time from file write until a fresh HEAD of the artifact returns the new size/version
  const t0=performance.now();
  writeFileSync(artPath, readAppend(artPath),'utf8');
  // the reload path issues GET /files/...?v=<ts>; measure how fast the viewer notices and re-serves
  // We approximate: poll HEAD until the content-length changes (proves the new file is live-served)
  const origLen = (await reqOnce(port,'/files/'+ART)).bytes;
  let seenNew=false, detectMs=-1;
  const dt=performance.now();
  while(performance.now()-dt<5000 && !seenNew){
    const r=await reqOnce(port,'/files/'+ART);
    if(r.bytes!==origLen && r.bytes>0){ seenNew=true; detectMs=performance.now()-dt; }
  }
  console.log('--- re-seed detect (write -> new file served) ---');
  console.log(`new content served after ${detectMs.toFixed(0)}ms (detected: ${seenNew})`);
  console.log(`total incl write: ${(performance.now()-t0).toFixed(0)}ms`);

  v.kill(); rmSync(ws,{recursive:true,force:true});
}
const readAppend = (p)=>require('node:fs').readFileSync(p,'utf8')+`\n<!-- r ${Date.now()} -->\n`;
main().catch(e=>{console.error('FATAL',e.message);process.exit(2);});
