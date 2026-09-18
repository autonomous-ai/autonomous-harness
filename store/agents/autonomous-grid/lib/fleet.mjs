import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessExecute } from './harness.mjs';

export const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CONFIG = { spec: 1, mode: 'local', grid: null, machines: [{ id: 'local', name: 'This machine', transport: 'local' }], preferences: { goal: 'Run useful models on the machines I own', keepFreeMemoryGb: 4, allowAutomaticChanges: false } };
export const now = () => new Date().toISOString();
export const stateDir = workspace => join(workspace, '.harness', 'grid');
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export const text = (value, max = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
export const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export async function readJson(file, fallback, limit = 2 * 1024 * 1024) {
  try {
    if ((await stat(file)).size > limit) throw new Error('File is too large');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export function validateConfig(raw) {
  if (!raw || raw.spec !== 1 || !['local', 'remote'].includes(raw.mode)) throw new Error('grid-fleet.json needs spec: 1 and mode: local or remote.');
  if (raw.grid !== null && (typeof raw.grid !== 'string' || !raw.grid.trim() || raw.grid.length > 240 || raw.grid.startsWith('-') || /[\x00-\x1f]/.test(raw.grid))) throw new Error('grid must be a name, ID, URL, or null.');
  if (!Array.isArray(raw.machines) || !raw.machines.length || raw.machines.length > 32) throw new Error('machines must contain 1–32 local, Harness, or SSH targets.');
  const ids = new Set();
  const machines = raw.machines.map(m => {
    if (!m || !idPattern.test(m.id) || ids.has(m.id)) throw new Error('Every machine needs a unique, simple id.');
    ids.add(m.id);
    if (!['local', 'ssh', 'harness'].includes(m.transport)) throw new Error(`Unknown transport for ${m.id}.`);
    if (m.transport === 'harness' && (typeof m.machineId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(m.machineId))) throw new Error(`A Harness machineId is required for ${m.id}.`);
    if (m.transport === 'harness' && (m.gridHome || m.gridBinary)) throw new Error(`Harness targets use their daemon's Grid installation and home: ${m.id}.`);
    if (m.transport === 'ssh' && (typeof m.host !== 'string' || !/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(m.host))) throw new Error(`Invalid SSH host for ${m.id}; use an SSH config alias or user@host.`);
    if (m.port !== undefined && (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535)) throw new Error(`Invalid SSH port for ${m.id}.`);
    for (const key of ['gridBinary', 'gridHome']) if (m[key] !== undefined && (typeof m[key] !== 'string' || !m[key].startsWith('/') || m[key].includes('\0') || m[key].length > 1024)) throw new Error(`${key} for ${m.id} must be an absolute path.`);
    return { id: m.id, name: text(m.name) || m.id, transport: m.transport, ...(m.transport === 'harness' ? { machineId: m.machineId } : {}), ...(m.transport === 'ssh' ? { host: m.host, ...(m.port ? { port: m.port } : {}) } : {}), ...(m.gridBinary ? { gridBinary: m.gridBinary } : {}), ...(m.gridHome ? { gridHome: m.gridHome } : {}) };
  });
  // The controller is explicit, so editing the order of an inventory cannot redirect fleet reads.
  const controller = raw.controller || machines.find(m => m.transport === 'local')?.id || machines[0].id;
  if (!ids.has(controller)) throw new Error('controller must name a configured machine.');
  return { spec: 1, mode: raw.mode, grid: raw.grid, controller, machines, preferences: { goal: text(raw.preferences?.goal, 500) || DEFAULT_CONFIG.preferences.goal, keepFreeMemoryGb: number(raw.preferences?.keepFreeMemoryGb) ?? 4, allowAutomaticChanges: raw.preferences?.allowAutomaticChanges === true } };
}
export async function readConfig(workspace) { return validateConfig(await readJson(join(workspace, 'grid-fleet.json'), DEFAULT_CONFIG)); }

export const shellQuote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

export function invocation(machine, args, env = process.env, thinking) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('Grid arguments must be strings without NUL bytes.');
  const template = thinking === undefined ? null : JSON.stringify({ enable_thinking: thinking });
  const childEnv = { ...env, GRID_NO_UPDATE_CHECK: '1', ...(machine.gridHome ? { GRID_HOME: machine.gridHome } : {}), ...(template === null ? {} : { LLAMA_ARG_CHAT_TEMPLATE_KWARGS: template }) };
  if (machine.transport === 'local') return { file: machine.gridBinary || join(PACKAGE, 'toolchain', 'grid.sh'), args, env: childEnv };
  if (machine.transport !== 'ssh') throw new Error('This transport does not use a shell invocation.');
  // SSH accepts a shell command, not an argv vector. Quote each argument separately; never join
  // user input as shell syntax. BatchMode and strict host keys use the user's established SSH trust.
  const argv = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8'];
  if (machine.port) argv.push('-p', String(machine.port));
  const choose = machine.gridBinary ? `bin=${shellQuote(machine.gridBinary)}` : 'runtime="${ADAPTER_RUNTIME_DIR:-$HOME/.harness/runtime}"; bin="$(cat "$runtime/current-grid" 2>/dev/null || true)"; case "$bin" in "$runtime"/*) test -x "$bin" || bin="";; *) bin="";; esac; if test -z "$bin"; then bin="$(command -v grid || true)"; fi; if test -z "$bin"; then bin="$HOME/.local/bin/grid"; fi';
  const remote = `export GRID_NO_UPDATE_CHECK=1; ${template === null ? '' : `export LLAMA_ARG_CHAT_TEMPLATE_KWARGS=${shellQuote(template)}; `}${machine.gridHome ? `export GRID_HOME=${shellQuote(machine.gridHome)}; ` : ''}${choose}; exec "$bin" ${args.map(shellQuote).join(' ')}`;
  return { file: 'ssh', args: [...argv, machine.host, remote], env: childEnv };
}

export function execute(machine, args, { timeoutMs = 15_000, inherit = false, env = process.env, signal, thinking } = {}) {
  if (thinking !== undefined && typeof thinking !== 'boolean') throw new Error('Thinking must be a boolean.');
  if (machine.transport === 'harness') {
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('Grid arguments must be strings without NUL bytes.');
    return harnessExecute(machine, args, { timeoutMs, inherit, env, signal, thinking });
  }
  const call = invocation(machine, args, env, thinking);
  return new Promise(resolveResult => {
    let stdout = '', stderr = '', finished = false, timer, killTimer, child, termination = null;
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      resolveResult({ stdout, stderr, ...result });
    };
    const stop = message => {
      if (finished || termination) return;
      termination = message;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, code: 124, error: message }); }, 1500);
    };
    const abort = () => stop('Grid command was interrupted; verify the engine state before retrying.');
    try { child = spawn(call.file, call.args, { env: call.env, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish({ ok: false, code: 127, error: error.message }); return; }
    let stopping = false;
    const capture = which => chunk => {
      if (stopping) return;
      if (stdout.length + stderr.length + chunk.length > 4 * 1024 * 1024) { stopping = true; stop('Grid output exceeded 4 MiB.'); return; }
      if (which === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout?.setEncoding('utf8').on('data', capture('out'));
    child.stderr?.setEncoding('utf8').on('data', capture('err'));
    child.once('error', error => finish({ ok: false, code: 127, error: error.code === 'ENOENT' ? 'Grid or SSH is not installed on this machine.' : error.message }));
    child.once('close', (code, sig) => finish(termination ? { ok: false, code: 124, error: termination } : { ok: code === 0, code: code ?? 1, error: code === 0 ? null : `Grid exited ${code ?? sig}.` }));
    timer = setTimeout(() => { stopping = true; stop(`Grid did not answer within ${Math.round(timeoutMs / 1000)} seconds; the operation may still be running on the target.`); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function gridJson(machine, mode, args, options) {
  const result = await execute(machine, [`--${mode}`, ...args, '--json'], options);
  if (!result.ok) {
    const blocked = /(?:could not reach|network|socket)[\s\S]{0,600}(?:operation not permitted|EPERM|denied|blocked)/i.test(`${result.stdout}\n${result.stderr}`);
    return { ok: false, error: blocked ? 'Network access was blocked by the agent sandbox. Use fleet status for viewer observations, or request scoped network approval before retrying this Grid command.' : result.code === 127 ? result.error : `grid ${args[0]} failed (${result.code}). Run it in the agent terminal for details.` };
  }
  try {
    const value = JSON.parse(result.stdout);
    if (value?.error) return { ok: false, error: `grid ${args[0]} reported an error.` };
    return { ok: true, value };
  } catch { return { ok: false, error: `grid ${args[0]} did not return valid JSON.` }; }
}

/**
 * Make [grid] the CLI's active selection for [mode] (`grid use <name>`), and confirm it took.
 *
 * ⚠️ Not through gridJson: the WRITE form of `use` ignores `--json` and prints a sentence
 * (`active grid for remote mode: autonomous.ai`, exit 0). Parsing that as JSON failed every
 * time, so every switch from the viewer's dropdown reported "grid use did not return valid
 * JSON" over a switch that had in fact happened. Only the READ form (`grid use --json`, no name)
 * answers in JSON — so that is what confirms the write here.
 */
export async function gridSelect(machine, mode, grid, options, { run = execute, readJson = gridJson } = {}) {
  const written = await run(machine, [`--${mode}`, 'use', grid], options);
  if (!written.ok) return { ok: false, error: written.code === 127 ? written.error : `grid use failed (${written.code}). Run it in the agent terminal for details.` };
  const read = await readJson(machine, mode, ['use'], options);
  const active = typeof read.value?.active === 'string' ? read.value.active : null;
  if (read.ok && active !== null && active !== grid) return { ok: false, error: `grid use answered, but the active grid is ${active}, not ${grid}.` };
  return { ok: true, active: active ?? grid };
}

export async function operations(workspace) {
  const folder = join(stateDir(workspace), 'operations');
  const names = await readdir(folder).catch(() => []);
  const entries = await Promise.all(names.filter(n => /^[a-f0-9-]+\.json$/.test(n)).map(async name => ({ name, mtime: (await stat(join(folder,name)).catch(() => null))?.mtimeMs || 0 })));
  entries.sort((a,b) => b.mtime-a.mtime);
  const rows = await Promise.all(entries.slice(0,200).map(({name}) => readJson(join(folder, name), null, 16 * 1024).catch(() => null)));
  return rows.filter(row => row && typeof row.startedAt === 'string').sort((a,b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 40).map(row => {
    let phase = ['running', 'done', 'failed', 'interrupted'].includes(row.phase) ? row.phase : 'interrupted';
    if (phase === 'running' && Number.isInteger(row.pid) && row.pid > 0) {
      try { process.kill(row.pid, 0); } catch (error) { if (error.code === 'ESRCH') phase = 'interrupted'; }
    }
    return { id: text(row.id), machine: text(row.machine), command: text(row.command, 80), phase, startedAt: text(row.startedAt), endedAt: text(row.endedAt) || null, exitCode: number(row.exitCode) };
  });
}

export async function runTracked(workspace, machine, mode, args, options = {}) {
  const command = args.find(a => !a.startsWith('-')) || 'overview';
  const op = { id: randomUUID(), machine: machine.id, command: `grid ${text(command, 40)}`, phase: 'running', startedAt: now(), endedAt: null, exitCode: null, pid: process.pid };
  const file = join(stateDir(workspace), 'operations', `${op.id}.json`);
  await atomicJson(file, op);
  try {
    const result = await execute(machine, [`--${mode}`, ...args], { inherit: true, timeoutMs: 30 * 60_000, ...options });
    Object.assign(op, { phase: result.ok ? 'done' : result.code === 124 ? 'interrupted' : 'failed', endedAt: now(), exitCode: result.code });
    await atomicJson(file, op);
    return result;
  } catch (error) {
    await atomicJson(file, { ...op, phase: 'failed', endedAt: now(), exitCode: 1 });
    throw error;
  }
}
