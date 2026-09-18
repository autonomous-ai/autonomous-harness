import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { atomicJson, gridJson, now, readConfig, readJson, stateDir, text, validateConfig } from './fleet.mjs';
import { discoverMachines } from './harness.mjs';

export function defaultsPath(env = process.env) {
  const path = env.GRID_FLEET_DEFAULTS || join(homedir(), '.harness', 'grid-fleet', 'default.json');
  if (!isAbsolute(path)) throw new Error('GRID_FLEET_DEFAULTS must be an absolute path.');
  return path;
}

export function mergeMachines(config, found) {
  const result = structuredClone(config);
  for (const machine of found) {
    const local = result.machines.find(m => m.transport === 'local');
    if (machine.current && local) {
      if (local.name === 'This machine') local.name = machine.name;
      continue;
    }
    if (result.machines.length >= 32 || result.machines.some(m => m.id === machine.id || m.machineId === machine.machineId)) continue;
    result.machines.push(machine);
  }
  return validateConfig(result);
}

/** Resolve a fresh workspace without changing Grid's global mode/default or starting a service. */
export async function initializeWorkspace(workspace, { runJson = gridJson, discover = discoverMachines, profilePath = defaultsPath() } = {}) {
  let config = await readConfig(workspace), source = 'workspace', message = '', candidates = [];
  const controller = () => config.machines.find(m => m.id === config.controller);
  const read = (mode, args) => runJson(controller(), mode, args, { timeoutMs: 5000 }).catch(() => ({ ok: false }));
  if (!config.grid) {
    const saved = await readJson(profilePath, null);
    if (saved) {
      config = validateConfig(saved); source = 'remembered fleet';
      // An explicit remembered fleet stays selected through an outage. Never switch its owner
      // to an unrelated reachable grid just because that other grid currently answers.
      message = `Selected your remembered ${config.mode} fleet ${config.grid}; checking live telemetry.`;
    } else {
      const mode = await read(config.mode, ['mode']);
      const preferred = ['local','remote'].includes(mode.value?.mode) ? mode.value.mode : config.mode;
      config.mode = preferred;
      const active = await read(preferred, ['use']);
      const selected = text(active.value?.active);
      if (selected && !selected.startsWith('-')) {
        const engines = await read(preferred, ['engines', selected]);
        if (engines.ok && Array.isArray(engines.value)) {
          config.grid = selected; source = 'Grid selection';
        }
      }
      if (!config.grid) {
        const listings = await Promise.all(['local','remote'].map(async mode => ({mode,result:await read(mode,['ls'])})));
        for (const {mode,result} of listings) for (const row of Array.isArray(result.value) ? result.value.slice(0,16) : []) {
          const grid = text(row.grid || row.name || row.id);
          if (grid && !grid.startsWith('-') && !candidates.some(c => c.mode === mode && c.grid === grid)) candidates.push({mode,grid});
        }
        // Only a unique known grid is an unambiguous fallback. Multiple grids stay a choice,
        // even when one happens to have more traffic. Probe only the candidate we may select.
        if (candidates.length === 1) {
          const candidate = candidates[0], engines = await read(candidate.mode,['engines',candidate.grid]);
          if (engines.ok && Array.isArray(engines.value)) {
            config.mode = candidate.mode; config.grid = candidate.grid; source = 'only reachable grid';
          }
        }
        if (!config.grid) message = 'Choose a grid with fleet connect --mode local|remote --grid NAME. The existing default was not reachable or the selection is ambiguous.';
      }
      if (config.grid) message = `Connected this workspace to ${config.mode} grid ${config.grid}.`;
    }
  }
  config = mergeMachines(config, await discover().catch(() => []));
  await atomicJson(join(workspace,'grid-fleet.json'),config);
  const connection = { source, mode:config.mode, grid:config.grid, message, candidates, observedAt:now() };
  await atomicJson(join(stateDir(workspace),'connection.json'),connection);
  return {config,connection};
}

export async function connectWorkspace(workspace, {mode,grid,remember=false}, {runJson=gridJson,discover=discoverMachines,profilePath=defaultsPath()} = {}) {
  let config = validateConfig({...await readConfig(workspace),mode,grid});
  if (!grid) throw new Error('Choose an explicit grid name, ID or URL.');
  const controller = config.machines.find(m => m.id === config.controller);
  const probe = await runJson(controller,mode,['engines',grid],{timeoutMs:15000});
  if (!probe.ok || !Array.isArray(probe.value)) throw new Error(probe.error || 'This grid did not return an engine list; the workspace selection was not changed.');
  config = mergeMachines(config,await discover().catch(() => []));
  await atomicJson(join(workspace,'grid-fleet.json'),config);
  if (remember) await atomicJson(profilePath,config);
  await atomicJson(join(stateDir(workspace),'connection.json'),{source:'explicit selection',mode,grid,remembered:remember,observedAt:now()});
  return config;
}

/** Read the viewer's published observation, with no sockets or subprocesses. */
export async function readStatus(workspace, time = Date.now()) {
  const config = await readConfig(workspace);
  const snapshot = await readJson(join(stateDir(workspace),'snapshot.json'),null);
  const scope = JSON.stringify([config.mode,config.grid,config.controller]);
  if (!snapshot || snapshot.scope !== scope) return {
    spec:1,status:config.grid?'connecting':'unconfigured',fresh:false,mode:config.mode,grid:config.grid,
    models:[],nodes:[],machines:config.machines,
    message:config.grid?'The viewer has not published this fleet yet. Wait for it, or run fleet refresh with the required network approval.':'No grid selected. Run fleet connect --mode local|remote --grid NAME.',
  };
  const ageMs = time-Date.parse(snapshot.observedAt), fresh = Number.isFinite(ageMs) && ageMs >= -5000 && ageMs <= Math.max(30000,(snapshot.pollIntervalMs||8000)*3);
  const {history,events,...view} = snapshot;
  return {...view,status:fresh?snapshot.status:'stale',fresh,cached:true,ageSeconds:Number.isFinite(ageMs)?Math.max(0,Math.floor(ageMs/1000)):null,
    nodes:(snapshot.nodes||[]).map(n=>fresh?n:{...n,stale:true}),operations:(snapshot.operations||[]).slice(0,5),
    ...(!fresh?{message:'These are last-known observations. The viewer is no longer updating; request network approval for fleet refresh before reporting current health.'}:{}),
  };
}
