import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {groove} from '../web/music.mjs';

test('audition and MIDI export agree for every seed, scale, density, and custom rhythm',()=>{
  const cases=[];
  for(const seed of [1,7,16,32])for(const scale of ['minor','major','pentatonic'])for(const density of [1,4,8,16])for(const pattern of ['', '1000010001000001', '0000000000000000'])for(const swing of [0,.3,.6])cases.push({seed,scale,density,pattern,swing});
  const cwd=fileURLToPath(new URL('../../../agents/ableton-ai/toolchain/',import.meta.url));
  const result=spawnSync('python3',['-c','import json,sys;from workflow import notes;print(json.dumps([notes(p) for p in json.load(sys.stdin)]))'],{cwd,input:JSON.stringify(cases),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const exported=JSON.parse(result.stdout);
  cases.forEach((p,i)=>assert.deepEqual(groove(p),exported[i],JSON.stringify(p)));
});
