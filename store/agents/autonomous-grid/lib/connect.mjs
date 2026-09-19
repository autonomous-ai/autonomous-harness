import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { atomicJson, gridJson, gridSelect, now, readConfig, readJson, stateDir, text, validateConfig } from './fleet.mjs';
import { discoverMachines } from './harness.mjs';

/** The email `grid login` recorded in the credential store, or null. `GRID_HOME` is honoured the way grid honours it. */
export async function signedInEmail(env = process.env) {
  const home = env.GRID_HOME && isAbsolute(env.GRID_HOME) ? env.GRID_HOME : join(homedir(), '.grid');
  try {
    const match = /^\s*email\s*=\s*"([^"]+)"/m.exec(await readFile(join(home, 'credentials.toml'), 'utf8'));
    return match ? match[1].trim() : null;
  } catch { return null; }
}

/**
 * The user's own private grid, recognised without asking anyone: Harness mints it at sign-in as the
 * email's local part (lowercased, runs of non-alphanumerics folded to `-`, trimmed) plus `-` and eight
 * hex digits, of type `permissioned-public`. Exactly one row of `grid ls` matches, or the answer is
 * null — never a guess, because grid names are global and a wrong one is somebody else's grid. This
 * replaces following `grid use`: the active selection is whatever the person last typed at the CLI
 * (a team's grid, a community one) and is not theirs to deploy onto by default.
 */
export function pickPrivateGrid(email, rows) {
  const local = String(email || '').split('@')[0];
  const slug = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  const pattern = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-f]{8}$`);
  const names = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.type === 'permissioned-public' && typeof row.grid === 'string' && pattern.test(row.grid))
    .map(row => row.grid);
  return names.length === 1 ? names[0] : null;
}

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
export async function initializeWorkspace(workspace, { runJson = gridJson, select = gridSelect, discover = discoverMachines, profilePath = defaultsPath(), email = signedInEmail } = {}) {
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
      const listings = await Promise.all(['local','remote'].map(async mode => ({mode,result:await read(mode,['ls'])})));
      // ONE source of truth for "which grid": the CLI's active selection (`grid use`). The viewer
      // follows it on every poll (telemetry.mjs), so what the person selected in a terminal, or
      // asked the agent to select, is what the screen shows. A fresh sign-in has no selection yet;
      // then the person's own private grid is derived from the sign-in and SELECTED, so the CLI
      // and the viewer agree from the first minute — never a team's or a community grid by guess.
      const active = text((await read(preferred, ['use'])).value?.active);
      if (active && !active.startsWith('-')) {
        const engines = await read(preferred, ['engines', active]);
        if (engines.ok && Array.isArray(engines.value)) { config.grid = active; source = 'Grid selection'; }
      }
      const remote = listings.find(l => l.mode === 'remote')?.result;
      const own = config.grid ? null : pickPrivateGrid(await email(), remote?.value);
      if (own) {
        const engines = await read('remote', ['engines', own]);
        if (engines.ok && Array.isArray(engines.value)) {
          config.mode = 'remote'; config.grid = own; source = 'your private grid';
          // The write form of `use` answers in prose, not JSON (lib/fleet.mjs gridSelect).
          await select(controller(), 'remote', own, { timeoutMs: 5000 }).catch(() => ({ ok: false }));
        }
      }
      if (!config.grid) {
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
        if (!config.grid) message = candidates.length ? `Ask the user which fleet to use — ${candidates.map(c => c.grid).join(', ')} — then fleet connect --mode local|remote --grid NAME. No private grid of theirs was found, so nothing is chosen for them.` : 'No grid is reachable from this machine. The user signs in to Harness first; then fleet connect --mode local|remote --grid NAME.';
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

export async function connectWorkspace(workspace, {mode,grid,remember=false}, {runJson=gridJson,select=gridSelect,discover=discoverMachines,profilePath=defaultsPath()} = {}) {
  let config = validateConfig({...await readConfig(workspace),mode,grid});
  if (!grid) throw new Error('Choose an explicit grid name, ID or URL.');
  const controller = config.machines.find(m => m.id === config.controller);
  const probe = await runJson(controller,mode,['engines',grid],{timeoutMs:15000});
  if (!probe.ok || !Array.isArray(probe.value)) throw new Error(probe.error || 'This grid did not return an engine list; the workspace selection was not changed.');
  config = mergeMachines(config,await discover().catch(() => []));
  await atomicJson(join(workspace,'grid-fleet.json'),config);
  if (remember) await atomicJson(profilePath,config);
  // The CLI's selection follows the workspace's, so a later `grid use` read (the viewer's poll,
  // the person's terminal) agrees with what was just connected.
  await select(controller,mode,grid,{timeoutMs:5000}).catch(() => ({ok:false}));
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
