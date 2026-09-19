import {spawn} from 'node:child_process';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const viewer=fileURLToPath(new URL('../',import.meta.url));
const store=fileURLToPath(new URL('../../../',import.meta.url));
const names=(process.env.STUDIO_TEST_PACKAGES??'juce-agent-toolkit,foam-agent,autoresearch-mlx,ableton-ai,dimos,simskill,bonsai-mcp,comfy-mcp').split(',');
const coverage=process.argv.includes('--coverage');
const testTools=resolve(process.env.STUDIO_TEST_TOOLS??join(viewer,'test-results/python-tools'));
const output=join(viewer,'test-results');await mkdir(output,{recursive:true});
const report=[];
async function run(python,file,env){
  await access(python);
  return new Promise((ok,fail)=>{
    const child=spawn(python,[join(viewer,'test',file)],{cwd:join(store,'..'),env:{...process.env,...env},stdio:'inherit'});
    child.on('error',fail);child.on('close',code=>code===0?ok():fail(Error(`${file} exited ${code}`)));
  });
}
try{
  const env=coverage?{STUDIO_COVERAGE:'1',PYTHONPATH:testTools+(process.env.PYTHONPATH?':'+process.env.PYTHONPATH:'')}:{};
  await run(join(store,'agents',names[0],'.venv/bin/python'),'runtime_test.py',env);
  report.push({name:'runtime',status:'passed'});
  await run(join(store,'agents',names[0],'.venv/bin/python'),'fetch_test.py',env);
  report.push({name:'fetch',status:'passed'});
  for(const name of names){
    console.log(`\nChecking ${name} with its installed runtime`);
    await run(join(store,'agents',name,'.venv/bin/python'),'workflows_test.py',{...env,STUDIO_TEST_PACKAGE:name});
    report.push({name,status:'passed'});
  }
  if(coverage){
    for(const {name} of report){
      const data=JSON.parse(await readFile(join(output,`${name}-python-coverage.json`),'utf8'));
      const t=data.totals;
      console.log(`${name}: ${t.covered_lines}/${t.num_statements} statements; ${t.covered_branches}/${t.num_branches} branches`);
      if(t.missing_lines||t.missing_branches)throw Error(`${name} did not meet 100% coverage. Enable the documented native JUCE check.`);
    }
  }
}finally{await writeFile(join(output,'workflow-report.json'),JSON.stringify(report,null,2));}
