// Like runtimes.sh, the small Python runner must travel with sparse package installs.
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
let failed=false;
for(const name of readdirSync(join(root,'agents'))){
  const dir=join(root,'agents',name);
  if(!existsSync(join(dir,'studio.config.json')))continue;
  for(const script of ['studio_runtime.py','studio_fetch.py']){
    const canonical=readFileSync(join(root,'tools',script),'utf8');
    const file=join(dir,'toolchain',script);
    if(existsSync(file)&&readFileSync(file,'utf8')===canonical)continue;
    if(process.argv.includes('--check')){console.error(`${name}: ${script} differs`);failed=true;}
    else writeFileSync(file,canonical);
  }
}
process.exitCode=failed?1:0;
