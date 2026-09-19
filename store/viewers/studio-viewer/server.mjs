import http from 'node:http';
import {readFile, writeFile, rename, rm, readdir, realpath, stat} from 'node:fs/promises';
import {resolve, join, relative, sep, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

const UI = fileURLToPath(new URL('./web/', import.meta.url));
const TYPES = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.wav':'audio/wav','.mid':'audio/midi','.mp4':'video/mp4','.txt':'text/plain; charset=utf-8','.csv':'text/csv','.ifc':'application/octet-stream','.zip':'application/zip'};

export class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function confined(root, path) {
  const base = await realpath(root);
  const target = await realpath(resolve(base, path));
  if (target !== base && !target.startsWith(base + sep)) throw new Problem(403, 'This file is outside the workspace.');
  return target;
}
async function jsonFile(root, path) {
  const target = await confined(root, path);
  if ((await stat(target)).size > 8 * 1024 * 1024) throw new Problem(413, 'This file is too large to preview.');
  return JSON.parse(await readFile(target, 'utf8'));
}
export function validateParameters(config, parameters) {
  if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object') throw new Problem(400, 'Provide the studio controls.');
  const keys = new Set(config.controls.map(c => c.id));
  if (Object.keys(parameters).some(k => !keys.has(k))) throw new Problem(400, 'Unknown studio control.');
  const out = {};
  for (const c of config.controls) {
    const v = Object.hasOwn(parameters,c.id) ? parameters[c.id] : c.value;
    if (c.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < c.min || v > c.max || (c.integer && !Number.isInteger(v))) throw new Problem(400, `${c.label} must be between ${c.min} and ${c.max}.`);
    } else if (c.type === 'select') {
      if (!c.options.some(o => o.value === v)) throw new Problem(400, `Choose a valid ${c.label.toLowerCase()}.`);
    } else if (typeof v !== 'string' || v.length > (c.maxLength ?? 500)) throw new Problem(400, `${c.label} is too long or invalid.`);
    out[c.id] = v;
  }
  return out;
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 16384) throw new Problem(413, 'The request is too large.');
  }
  try { return JSON.parse(raw); } catch { throw new Problem(400, 'The request must be JSON.'); }
}
function revision(project) { return createHash('sha256').update(JSON.stringify(project)).digest('hex').slice(0,16); }
async function optionalJSON(root, path, fallback) {
  try { return await jsonFile(root, path); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export async function createStudio({workspace, packageDir, port = 0, jobTimeout = 900000}) {
  workspace = await realpath(workspace);
  packageDir = await realpath(packageDir);
  const config = await jsonFile(packageDir, 'studio.config.json');
  let job = null;
  let child = null;
  let timer = null;
  let starting = false;
  const project = async () => jsonFile(workspace, 'studio.json');
  const readState = async () => {
    const p = await project();
    const result = await optionalJSON(workspace, 'out/latest.json', null);
    const history = [];
    let entries = [];
    try { entries = await readdir(await confined(workspace, 'out/runs')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const id of entries.sort().reverse().slice(0,40)) {
      try {
        const r = await jsonFile(workspace, `out/runs/${id}/result.json`);
        history.push({id, title:r.title, engine:r.engine, createdAt:r.createdAt, metrics:r.metrics, action:r.action});
      } catch { /* An in-progress or damaged result never hides previous runs. */ }
    }
    return {config, project:p, revision:revision(p), result, history, job};
  };
  const endChild = () => {
    if (child) {
      const current = child;
      const signal = name => {try { process.kill(-current.pid,name); } catch { current.kill(name); }};
      signal('SIGTERM');
      const force = setTimeout(() => signal('SIGKILL'),1000);
      force.unref();
      current.once('close',() => clearTimeout(force));
    }
  };
  const server = http.createServer(async (req,res) => {
    const send = (status, data, type = 'application/json; charset=utf-8', raw = false) => {
      res.writeHead(status, {'Content-Type':type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'"});
      res.end(!raw && type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== expectedHost && req.headers.host !== `localhost:${server.address().port}`) throw new Problem(403, 'Open this studio on its local address.');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new Problem(403, 'Requests must come from this studio.');
      const url = new URL(req.url, `http://${expectedHost}`);
      let path;
      try { path = decodeURIComponent(url.pathname); }
      catch { throw new Problem(400, 'This address is malformed.'); }
      if (req.method === 'GET' && path === '/api/state') return send(200, await readState());
      if (req.method === 'GET' && path === '/api/run') {
        const id = url.searchParams.get('id');
        if (!/^[a-zA-Z0-9-]+$/.test(id ?? '')) throw new Problem(400, 'Choose a run from the history.');
        return send(200, await jsonFile(workspace, `out/runs/${id}/result.json`));
      }
      if (req.method === 'POST' && path === '/api/cancel') {
        if (!child) throw new Problem(409, 'There is no run to stop.');
        job = {...job, status:'cancelled', message:'Run stopped. Your last result is safe.'};
        endChild();
        return send(200, {ok:true});
      }
      if (req.method === 'POST' && path === '/api/run') {
        if (child || starting) throw new Problem(409, 'A run is already in progress.');
        starting = true;
        try {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new Problem(415, 'Send studio controls as JSON.');
        const input = await body(req);
        if (!input || Array.isArray(input) || typeof input !== 'object') throw new Problem(400, 'Provide the studio action and controls.');
        const action = config.actions.find(a => a.id === input.action);
        if (!action) throw new Problem(400, 'Choose a studio action.');
        const p = await project();
        if (input.revision !== revision(p)) throw new Problem(409, 'The agent changed this project. Refresh to load its latest controls.');
        const parameters = validateParameters(config,input.parameters);
        const target = await confined(workspace, 'studio.json');
        const temporary = join(workspace,`.studio-${randomUUID()}.json`);
        try {
          await writeFile(temporary,JSON.stringify({...p,parameters},null,2)+'\n',{flag:'wx'});
          await rename(temporary,target);
        } finally { await rm(temporary,{force:true}); }
        const script = await confined(packageDir,'toolchain/run.sh');
        job = {status:'running', action:action.id, label:action.label, startedAt:new Date().toISOString(), message:'Preparing your run…', log:''};
        child = spawn(script, [action.id], {cwd:workspace, detached:true, env:{...process.env,HARNESS_WORKSPACE:workspace,HARNESS_DSH_DIR:packageDir},stdio:['ignore','pipe','pipe']});
        const handleOutput = data => {job.log = (job.log + data.toString()).slice(-6000); job.message = data.toString().trim().split('\n').at(-1).slice(0,240);};
        child.stdout.on('data',handleOutput); child.stderr.on('data',handleOutput);
        child.on('error', error => {job = {...job,status:'failed',message:error.message};});
        child.on('close', code => {
          clearTimeout(timer); timer = null; child = null;
          if (job.status === 'running') job = {...job,status:code === 0 ? 'done':'failed',message:code === 0 ? 'Your new result is ready.':`Run failed. ${job.message}`};
        });
        timer = setTimeout(() => {job = {...job,status:'failed',message:'This run reached its time limit. Your last result is safe.'}; endChild();},jobTimeout);
        return send(202,{ok:true});
        } finally { starting = false; }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Problem(405,'This action is not supported.');
      let root = UI, file = path === '/' ? 'index.html':path.slice(1);
      if (path === '/domain.mjs') {root = packageDir; file = 'view.mjs';}
      if (path.startsWith('/artifacts/')) {
        root = workspace; file = path.slice('/artifacts/'.length);
        if (!file.startsWith('out/')) throw new Problem(403, 'Only studio outputs can be downloaded.');
      }
      const target = await confined(root,file);
      const s = await stat(target);
      if (!s.isFile()) throw new Problem(404,'This file is not available.');
      if (s.size > 256*1024*1024) throw new Problem(413,'Open this large artifact from your workspace.');
      const type = TYPES[extname(target)] ?? 'application/octet-stream';
      if (url.searchParams.has('download')) res.setHeader('Content-Disposition',`attachment; filename="${target.split(sep).at(-1).replace(/[^a-zA-Z0-9._-]/g,'_')}"`);
      res.setHeader('Accept-Ranges','bytes');
      // WebKit probes audio with bytes=0-1 and requires a proper partial response.
      if (req.method === 'GET' && req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        let start = 0, end = s.size-1;
        if (match && (match[1] || match[2])) {
          if (match[1]) {start=Number(match[1]);if (match[2]) end=Math.min(end,Number(match[2]));}
          else start=Math.max(0,s.size-Number(match[2]));
        } else start=s.size;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start>=s.size) {
          res.setHeader('Content-Range',`bytes */${s.size}`);
          throw new Problem(416,'This byte range is outside the artifact.');
        }
        res.setHeader('Content-Range',`bytes ${start}-${end}/${s.size}`);
        res.setHeader('Content-Length',end-start+1);
        return send(206,(await readFile(target)).subarray(start,end+1),type,true);
      }
      res.setHeader('Content-Length',s.size);
      const data = req.method === 'HEAD' ? Buffer.alloc(0):await readFile(target);
      return send(200,data,type,true);
    } catch(error) {
      res.removeHeader('Content-Length');
      const status = error.status ?? (error.code === 'ENOENT' ? 404:500);
      return send(status,{error:status === 500 ? 'The studio could not read the project. Check studio.json and the latest result.':error.message});
    }
  });
  await new Promise((ok,fail) => {server.once('error',fail); server.listen(port,'127.0.0.1',ok);});
  return {server, url:`http://127.0.0.1:${server.address().port}`, close:async () => {
    clearTimeout(timer);
    const stopped = child ? new Promise(ok => child.once('close',ok)) : Promise.resolve();
    endChild();server.closeAllConnections();
    await Promise.all([stopped,new Promise(ok => server.close(ok))]);
  }};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studio = await createStudio({workspace:process.env.HARNESS_WORKSPACE,packageDir:process.env.HARNESS_DSH_DIR,port:Number(process.env.HARNESS_VIEWER_PORT)});
  console.log(`Studio ready at ${studio.url}`);
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal,async () => {await studio.close();process.exit(0);});
}
