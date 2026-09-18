#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { atomicJson, DEFAULT_CONFIG, execute, readConfig, runTracked } from '../lib/fleet.mjs';
import { createCollector } from '../lib/telemetry.mjs';
import { discoverMachines } from '../lib/harness.mjs';
import { connectWorkspace, initializeWorkspace, mergeMachines, readStatus } from '../lib/connect.mjs';

const workspace = resolve(process.env.HARNESS_WORKSPACE || process.cwd());
const [command = 'help', ...args] = process.argv.slice(2);
try {
  if (command === 'init') {
    const { access, mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await access(join(workspace, 'grid-fleet.json')).catch(() => atomicJson(join(workspace, 'grid-fleet.json'), DEFAULT_CONFIG));
    const {connection} = await initializeWorkspace(workspace);
    await createCollector(workspace)();
    console.log(`Grid workspace ready: ${workspace}`);
    if (connection.message) console.log(connection.message);
  } else if (command === 'connect') {
    let mode,grid,remember=false;
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--mode' && mode===undefined) mode=args[++i];
      else if(args[i]==='--grid' && grid===undefined) grid=args[++i];
      else if(args[i]==='--remember' && !remember) remember=true;
      else throw new Error('Use: fleet connect --mode local|remote --grid NAME [--remember]');
    }
    await connectWorkspace(workspace,{mode,grid,remember});
    const snapshot = await createCollector(workspace)();
    console.log(JSON.stringify({mode,grid,remembered:remember,status:snapshot.status,enginesOnline:snapshot.summary.enginesOnline},null,2));
  } else if (command === 'status') {
    if(args.length && !(args.length===1 && args[0]==='--json')) throw new Error('Use: fleet status [--json]');
    console.log(JSON.stringify(await readStatus(workspace),null,2));
  } else if (command === 'doctor') {
    const result = await execute({ transport: 'local' }, ['version']);
    const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0];
    const [a=0,b=0,c=0] = (version || '').split('.').map(Number);
    if (!result.ok || !(a > 0 || b > 3 || (b === 3 && c >= 47))) throw new Error('Grid >= 0.3.47 is required. Run toolchain/setup.sh or update the selected Harness runtime.');
    console.log(`ok   Grid ${version}\nok   Node ${process.versions.node}\nok   local fleet viewer\ninfo Paired Harness machines use encrypted connections; SSH targets use existing keys`);
  } else if (command === 'discover') {
    if (args.length && (args.length !== 1 || args[0] !== '--add')) throw new Error('Use: fleet discover [--add]');
    const found = await discoverMachines();
    if (args[0] === '--add') {
      const config = await readConfig(workspace);
      await atomicJson(join(workspace,'grid-fleet.json'), mergeMachines(config,found));
    }
    console.log(JSON.stringify(found,null,2));
  } else if (command === 'refresh') {
    const snapshot = await createCollector(workspace)();
    console.log(JSON.stringify(snapshot, null, 2));
    process.exitCode = snapshot.status === 'unavailable' ? 1 : 0;
  } else if (command === 'config') {
    console.log(JSON.stringify(await readConfig(workspace), null, 2));
  } else if (command === 'run') {
    const boundary = args.indexOf('--');
    if (boundary < 0 || boundary === args.length - 1) throw new Error('Use: fleet run [--machine ID] -- <grid arguments>');
    const flags = args.slice(0,boundary), gridArgs = args.slice(boundary + 1);
    let target, thinking;
    for (let i=0;i<flags.length;i+=2) {
      if (flags[i]==='--machine' && target===undefined && flags[i+1]) target=flags[i+1];
      else if (flags[i]==='--thinking' && thinking===undefined && ['on','off'].includes(flags[i+1])) thinking=flags[i+1]==='on';
      else throw new Error('Use --machine ID and/or --thinking on|off before --.');
    }
    if (thinking!==undefined && gridArgs[0]!=='join') throw new Error('--thinking configures engine startup; use it with join.');
    const config = await readConfig(workspace);
    const machineId = target || config.controller;
    const machine = config.machines.find(m => m.id === machineId);
    if (!machine) throw new Error(`Unknown machine ${machineId}. Add it to grid-fleet.json first.`);
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
    const result = await runTracked(workspace, machine, config.mode, gridArgs, { signal: abort.signal, thinking });
    if (!result.ok && result.error) console.error(result.error);
    process.exitCode = result.code;
  } else {
    console.log(`Grid fleet workspace tools

  fleet init                       Initialize from your remembered or active Grid
  fleet connect --mode MODE --grid NAME [--remember]
                                   Select a reachable grid; optionally reuse it in new workspaces
  fleet status [--json]             Read the viewer's observations without network access
  fleet doctor                     Check Grid and Node
  fleet discover [--add]            Discover your Harness machines
  fleet config                     Validate and print fleet inventory
  fleet refresh                    Read Grid, update viewer and verdict
  fleet run [--machine ID] -- ARGS  Run any Grid command on a configured machine

Use --thinking on|off before -- to configure a supported model's thinking at join.

Examples:
  "$GRID_FLEET" run -- engines --json
  "$GRID_FLEET" run --machine studio --thinking off -- join home --serve model.gguf --name studio
  "$GRID_FLEET" run --machine studio -- leave home --engine studio

Grid’s own help is available with: fleet run -- --help
Workspace: ${workspace}`);
    if (command !== 'help') process.exitCode = 2;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
