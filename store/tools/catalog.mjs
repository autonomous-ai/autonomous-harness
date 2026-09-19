#!/usr/bin/env node
// Publish metadata, never run a harness's setup or load its code. No npm dependencies required.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readDshRegistry } from '../../cli/scripts/lib/dshRegistry.mjs';

const MONOREPO='https://github.com/autonomous-ai/openharness';
const ID=/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/;
const PACKAGE_PATH=/^(?!\/)(?!.*\/$)(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9._\-/]+$/;
const LIMITS={id:160,name:40,description:300,category:24,author:80,repo:2048,ref:200,path:512,homepage:2048,upstream:2048,license:40,tagline:80,viewerUse:160};

export function createStoreCatalog(storeDir, ref, {revisionFor}={}) {
  if (!/^[a-f0-9]{40}$/i.test(ref)) throw new Error('Publish from a complete git commit SHA');
  const entries=readDshRegistry(storeDir,{strict:true}).sort((a,b)=>a.id.localeCompare(b.id));
  const byId=new Map();
  for (const entry of entries) {
    for(const [key,max]of Object.entries(LIMITS))if(entry[key]!==undefined&&(typeof entry[key]!=='string'||entry[key].length>max||/[\x00-\x1f\x7f]/.test(entry[key])))throw new Error(`${entry.id}: invalid ${key}`);
    if(entry.tagline!==undefined&&!entry.tagline.trim())throw new Error(`${entry.id}: invalid tagline`);
    if(!ID.test(entry.id)||!entry.name||!entry.repo||byId.has(entry.id))throw new Error(`Invalid or duplicate catalog identity: ${entry.id}`);
    if(entry.kind!==undefined&&!['agent','viewer'].includes(entry.kind))throw new Error(`${entry.id}: invalid kind`);
    if(entry.kind!=='viewer'&&(typeof entry.engine!=='string'||!entry.engine))throw new Error(`${entry.id}: missing engine`);
    const url=new URL(entry.repo);
    if(url.protocol!=='https:'||url.username||url.password)throw new Error(`${entry.id}: use a public HTTPS repository`);
    if(entry.path!==undefined&&!PACKAGE_PATH.test(entry.path))throw new Error(`${entry.id}: invalid package path`);
    if(entry.viewerUse!==undefined&&!ID.test(entry.viewerUse))throw new Error(`${entry.id}: invalid viewer dependency`);
    if(entry.tier!==undefined&&![0,1,2].includes(entry.tier))throw new Error(`${entry.id}: invalid tier`);
    for(const key of ['homepage','upstream'])if(entry[key]!==undefined)new URL(entry[key]);
    if(entry.examples!==undefined){if(!Array.isArray(entry.examples)||entry.examples.length>8)throw new Error(`${entry.id}: invalid examples`);for(const ex of entry.examples){if(!ex||typeof ex!=='object'||typeof ex.prompt!=='string'||!ex.prompt.trim()||ex.prompt.length>600)throw new Error(`${entry.id}: an example needs a prompt`);if(ex.image!==undefined&&(typeof ex.image!=='string'||ex.image.length>2048||new URL(ex.image).protocol!=='https:'))throw new Error(`${entry.id}: an example image is an https URL`);if(ex.caption!==undefined&&(typeof ex.caption!=='string'||ex.caption.length>120))throw new Error(`${entry.id}: invalid example caption`);for(const key of Object.keys(ex))if(!['prompt','image','caption'].includes(key))throw new Error(`${entry.id}: unknown example field ${key}`);}}
    if(entry.evaluation!==undefined){if(!Array.isArray(entry.evaluation)||entry.evaluation.length>4)throw new Error(`${entry.id}: invalid evaluation`);for(const ev of entry.evaluation){if(!ev||typeof ev!=='object'||!['tool','checks','review','none'].includes(ev.method))throw new Error(`${entry.id}: an evaluation method is tool, checks, review or none`);if(ev.by!==undefined&&(typeof ev.by!=='string'||!ev.by.trim()||ev.by.length>80||/[\x00-\x1f\x7f]/.test(ev.by)))throw new Error(`${entry.id}: invalid evaluation by`);for(const key of Object.keys(ev))if(!['method','by'].includes(key))throw new Error(`${entry.id}: unknown evaluation field ${key}`);}}
    if(entry.screenshots!==undefined){if(!Array.isArray(entry.screenshots)||entry.screenshots.length>8)throw new Error(`${entry.id}: invalid screenshots`);for(const shot of entry.screenshots){if(typeof shot!=='string'||shot.length>2048)throw new Error(`${entry.id}: invalid screenshot`);new URL(shot);}}
    const builtIn=entry.repo.replace(/\.git$/,'')===MONOREPO&&entry.path===`store/${entry.kind==='viewer'?'viewers':'agents'}/${entry.id.slice('autonomous/'.length)}`&&entry.id.startsWith('autonomous/');
    if(entry.id.startsWith('autonomous/')&&!builtIn)throw new Error(`${entry.id}: autonomous IDs belong to built-in packages`);
    if(builtIn){entry.ref=ref;const revision=revisionFor?.(entry.path);if(revision!==undefined)entry.revision=revision;}
    if(entry.revision!==undefined&&!/^[a-f0-9]{40}$/i.test(entry.revision))throw new Error(`${entry.id}: invalid package revision`);
    entry.verified=builtIn;
    byId.set(entry.id,entry);
  }
  for(const entry of entries)if(entry.viewerUse&&byId.get(entry.viewerUse)?.kind!=='viewer')throw new Error(`${entry.id}: viewer ${entry.viewerUse} must be listed in the same catalog`);
  if(!entries.length)throw new Error('Refusing to publish an empty Store');
  return {spec:1,entries};
}

/** One immutable catalog commit; optimistic ref updates cannot overwrite another publication. */
export async function publishStoreCatalog(catalog, {repository='autonomous-ai/openharness',token,fetch:request=fetch}={}) {
  if(!token)throw new Error('GITHUB_TOKEN is required to publish the catalog');
  const body=JSON.stringify(catalog,null,2)+'\n';
  const blobSha=createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');
  const api=async(path,method='GET',data)=>{
    const response=await request(`https://api.github.com/repos/${repository}/${path}`,{method,headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2022-11-28'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(30_000)});
    if(response.status===404&&method==='GET')return null;
    if(!response.ok)throw new Error(`Catalog publication failed: ${method} ${path} (${response.status})`);
    return response.json();
  };
  const current=await api('git/ref/heads/store-catalog');
  if(current){const previous=await api(`git/commits/${current.object.sha}`);const tree=await api(`git/trees/${previous.tree.sha}`);if(tree?.tree?.length===1&&tree.tree[0].path==='catalog.json'&&tree.tree[0].sha===blobSha)return {changed:false,sha:current.object.sha};}
  const blob=await api('git/blobs','POST',{content:body,encoding:'utf-8'});
  const tree=await api('git/trees','POST',{tree:[{path:'catalog.json',mode:'100644',type:'blob',sha:blob.sha}]});
  const commit=await api('git/commits','POST',{message:'Publish Harness Store catalog',tree:tree.sha,parents:current?[current.object.sha]:[]});
  if(current)await api('git/refs/heads/store-catalog','PATCH',{sha:commit.sha,force:false});
  else await api('git/refs','POST',{ref:'refs/heads/store-catalog',sha:commit.sha});
  return {changed:true,sha:commit.sha};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
  const storeDir=resolve(args.includes('--store')?value('--store'):fileURLToPath(new URL('..',import.meta.url)));
  const ref=args.includes('--ref')?value('--ref'):execFileSync('git',['-C',storeDir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const catalog=createStoreCatalog(storeDir,ref,{revisionFor:path=>execFileSync('git',['-C',storeDir,'rev-parse',`${ref}:${path}`],{encoding:'utf8'}).trim()});
  if(args.includes('--output'))writeFileSync(value('--output'),JSON.stringify(catalog,null,2)+'\n');
  if(args.includes('--publish'))console.log(await publishStoreCatalog(catalog,{token:process.env.GITHUB_TOKEN,repository:process.env.GITHUB_REPOSITORY||'autonomous-ai/openharness'}));
  else console.log(`Catalog valid: ${catalog.entries.length} packages at ${ref}`);
}
