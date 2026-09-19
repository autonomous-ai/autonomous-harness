import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeUrl, harnessExecute } from '../lib/harness.mjs';
import { validateConfig } from '../lib/fleet.mjs';

function socketClass(respond) {
  return class FakeSocket extends EventTarget {
    readyState = 1;
    constructor(url) { super(); this.url = url; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(data) { respond(JSON.parse(data), frame => queueMicrotask(() => this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}))), this); }
    close() { this.readyState=3; this.dispatchEvent(new Event('close')); }
  };
}
const machine={id:'rig',name:'GPU rig',transport:'harness',machineId:'machine-123'};
test('Harness targets are explicit identities, with no binary overrides or remote bridge URLs',()=>{
  assert.equal(validateConfig({spec:1,mode:'remote',grid:'home',machines:[machine]}).machines[0].machineId,'machine-123');
  assert.throws(()=>validateConfig({spec:1,mode:'remote',grid:'home',machines:[{...machine,gridBinary:'/bin/sh'}]}));
  for(const url of ['wss://example.com/api/local-ws','ws://127.0.0.1/elsewhere','ws://user:password@127.0.0.1/api/local-ws']) assert.throws(()=>bridgeUrl({HARNESS_GRID_BRIDGE_URL:url}));
});
test('connected Harness machine receives exact CLI arguments and its own output',async()=>{
  let ran=0;const args=['--remote','chat','one; $(literal)','two words'];
  const WebSocketImpl=socketClass((frame,reply)=>{
    if(frame.type==='machine_select'){assert.equal(frame.payload.machineId,'machine-123');reply({type:'connected',payload:{relayIsolation:true}});}
    if(frame.type==='grid_fleet_capabilities')reply({type:frame.type+'_result',payload:{...frame.payload,protocol:1,gridCli:'managed'}});
    if(frame.type==='grid_fleet_run'){ran++;assert.deepEqual(frame.payload.args,args);reply({type:frame.type+'_result',payload:{requestId:frame.payload.requestId,ok:true,code:0,stdout:'answer',stderr:''}});}
  });
  assert.deepEqual(await harnessExecute(machine,args,{WebSocketImpl}),{ok:true,code:0,stdout:'answer',stderr:'',error:null});assert.equal(ran,1);
});
test('an older remote daemon fails with an actionable compatibility message before any mutation',async()=>{
  const WebSocketImpl=socketClass((frame,reply)=>{
    if(frame.type==='machine_select')reply({type:'connected',payload:{relayIsolation:true}});
    else if(frame.type==='grid_fleet_capabilities')reply({type:frame.type+'_result',payload:{requestId:frame.payload.requestId,error:'UNSUPPORTED'}});
    else assert.fail('must not run');
  });
  const result=await harnessExecute(machine,['join','home'],{WebSocketImpl});assert.equal(result.ok,false);assert.match(result.error,/Update Harness/);
});
test('lost connections do not retry mutations',async()=>{
  let ran=0;
  const WebSocketImpl=socketClass((frame,reply,socket)=>{
    if(frame.type==='machine_select')reply({type:'connected',payload:{relayIsolation:true}});
    if(frame.type==='grid_fleet_capabilities')reply({type:frame.type+'_result',payload:{requestId:frame.payload.requestId,protocol:1}});
    if(frame.type==='grid_fleet_run'){ran++;queueMicrotask(()=>socket.close());}
  });
  const result=await harnessExecute(machine,['join','home'],{WebSocketImpl});assert.equal(result.code,124);assert.equal(ran,1);assert.match(result.error,/may still be running/);
});
test('duplicate connection and capability events cannot replay a deployment',async()=>{
  let runs=0;
  const WebSocketImpl=socketClass((frame,reply)=>{
    if(frame.type==='machine_select'){
      assert.equal(frame.payload.relayIsolation,true);
      reply({type:'connected',payload:{relayIsolation:true}});reply({type:'connected',payload:{relayIsolation:true}});
    }
    if(frame.type==='grid_fleet_capabilities'){
      const response={type:frame.type+'_result',payload:{requestId:frame.payload.requestId,protocol:1}};reply(response);reply(response);
    }
    if(frame.type==='grid_fleet_run'){runs++;reply({type:frame.type+'_result',payload:{requestId:frame.payload.requestId,ok:true,code:0}});}
  });
  assert.equal((await harnessExecute(machine,['join','home'],{WebSocketImpl})).ok,true);assert.equal(runs,1);
});
test('an older local bridge cannot share the desktop connection for a fleet command',async()=>{
  const WebSocketImpl=socketClass((frame,reply)=>{
    if(frame.type==='machine_select')reply({type:'connected',payload:{}});
    else assert.fail('no command may run without an isolated connection');
  });
  assert.match((await harnessExecute(machine,['join','home'],{WebSocketImpl})).error,/controller/);
});
test('thinking controls require remote support before starting the engine',async()=>{
  let runs=0;
  const WebSocketImpl=socketClass((frame,reply)=>{
    if(frame.type==='machine_select')reply({type:'connected',payload:{relayIsolation:true}});
    if(frame.type==='grid_fleet_capabilities')reply({type:frame.type+'_result',payload:{requestId:frame.payload.requestId,protocol:1}});
    if(frame.type==='grid_fleet_run')runs++;
  });
  assert.match((await harnessExecute(machine,['join'],{WebSocketImpl,thinking:false})).error,/thinking/);assert.equal(runs,0);
});
test('cancellation addresses the same command through the same connection',async()=>{
  const controller=new AbortController();let commandId,cancelled;
  const WebSocketImpl=socketClass((frame,reply)=>{
    if(frame.type==='machine_select')reply({type:'connected',payload:{relayIsolation:true}});
    if(frame.type==='grid_fleet_capabilities')reply({type:frame.type+'_result',payload:{requestId:frame.payload.requestId,protocol:1}});
    if(frame.type==='grid_fleet_run'){commandId=frame.payload.requestId;queueMicrotask(()=>controller.abort());}
    if(frame.type==='grid_fleet_cancel')cancelled=frame.payload.commandId;
  });
  const result=await harnessExecute(machine,['pull','model'],{WebSocketImpl,signal:controller.signal});assert.equal(result.code,124);assert.equal(cancelled,commandId);
});
