import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,relative} from 'node:path';
import v8ToIstanbul from 'v8-to-istanbul';
import istanbul from 'istanbul-lib-coverage';
const {createCoverageMap}=istanbul;

const viewer=fileURLToPath(new URL('../',import.meta.url));
const store=fileURLToPath(new URL('../../../',import.meta.url));
const map=createCoverageMap({});
for(const filename of await readdir(join(viewer,'test-results'))){
  if(!filename.endsWith('-browser-coverage.json'))continue;
  const name=filename.replace('-browser-coverage.json','').split('--')[0];
  const entries=JSON.parse(await readFile(join(viewer,'test-results',filename),'utf8'));
  for(const entry of entries){
    if(!entry.url?.startsWith('http://127.0.0.1:'))continue;
    const path=new URL(entry.url).pathname;
    let file;
    if(path==='/domain.mjs'){
      if(name==='ui')continue;
      file=join(store,'agents',name,'view.mjs');
    }else if(['/studio.mjs','/graphics.mjs','/music.mjs'].includes(path))file=join(viewer,'web',path.slice(1));
    else continue;
    if(entry.source!==await readFile(file,'utf8'))throw Error(`Stale browser coverage for ${file}; rerun ${filename}.`);
    const converter=v8ToIstanbul(file,0,{source:entry.source});
    await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
  }
}
const files={};
for(const file of map.files().sort()){
  const summary=map.fileCoverageFor(file).toSummary().toJSON();
  files[relative(store,file)]=summary;
  console.log(`${relative(store,file)}: ${summary.lines.pct}% lines, ${summary.branches.pct}% branches, ${summary.functions.pct}% functions`);
}
const summary={total:map.getCoverageSummary().toJSON(),files};
await mkdir(join(viewer,'coverage'),{recursive:true});
await writeFile(join(viewer,'coverage/browser-summary.json'),JSON.stringify(summary,null,2));
await writeFile(join(viewer,'coverage/browser-final.json'),JSON.stringify(map.toJSON()));
console.log('Browser total:',summary.total);
if(map.files().length!==11)throw Error('Coverage must include all eight domain views and the three shared browser modules.');
for(const metric of ['lines','statements','functions','branches']){
  if(summary.total[metric].pct!==100)throw Error(`Browser ${metric} coverage is below 100%.`);
}
