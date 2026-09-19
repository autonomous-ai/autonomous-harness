import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const updateMessage = 'This machine needs a Harness version with Grid fleet support. Update Harness there, or configure an existing SSH target.';

export async function discoverMachines() {
  const { stdout } = await promisify(execFile)('harness', ['machines', '--json'], { timeout: 20_000, maxBuffer: 512 * 1024 });
  return stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => typeof row.machineId === 'string').map(row => ({
    id: row.machineId, machineId: row.machineId, name: String(row.name || row.hostname || row.machineId).slice(0,240),
    transport: row.current ? 'local' : 'harness', current: row.current === true, online: row.status === 'running',
  }));
}

/** Node's WebSocket talks only to Harness's loopback bridge; Harness owns pairing and encryption. */
export function bridgeUrl(env = process.env) {
  const url = new URL(env.HARNESS_GRID_BRIDGE_URL || 'ws://127.0.0.1:18473/api/local-ws');
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/api/local-ws' || url.username || url.password || url.search || url.hash) throw new Error('Harness bridge must be its local WebSocket endpoint.');
  return url.href;
}

export async function harnessExecute(machine, args, { timeoutMs = 15_000, inherit = false, signal, thinking, env = process.env, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) return { ok: false, code: 127, stdout: '', stderr: '', error: 'Node 22 or newer is required for Harness machine connections.' };
  let socket;
  try { socket = new WebSocketImpl(bridgeUrl(env)); }
  catch { return { ok: false, code: 127, stdout: '', stderr: '', error: 'Could not open the local Harness bridge.' }; }
  return await new Promise(resolve => {
    let done = false, running = false, selected = false, heartbeat, deadline;
    const commandId = randomUUID(), capabilityId = randomUUID();
    const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(deadline); clearInterval(heartbeat); signal?.removeEventListener('abort', abort); socket.close();
      if (inherit) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
      resolve(result);
    };
    const fail = error => finish({ ok: false, code: running ? 124 : 127, stdout: '', stderr: '', error });
    const abort = () => {
      if (running && socket.readyState === 1) send('grid_fleet_cancel', { requestId: randomUUID(), commandId });
      fail('Grid command interrupted. Verify the target state before retrying.');
    };
    deadline = setTimeout(() => fail('Harness did not connect to this machine. Check that it is online and linked.'), Math.min(timeoutMs, 20_000));
    socket.addEventListener('open', () => send('machine_select', { machineId: machine.machineId, localProtocolVersion: 1, relayIsolation: true }));
    socket.addEventListener('error', () => fail('Harness connection failed. Start Harness and check the machine link.'));
    socket.addEventListener('close', event => {
      if (done) return;
      if (event.code === 4404) fail('Link this machine in Harness Machines before managing it from Grid.');
      else fail(running ? 'Harness connection closed. The command may still be running; inspect the target before retrying.' : 'Harness could not connect. Check that this machine is online and linked.');
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) return;
      let frame; try { frame = JSON.parse(event.data); } catch { return; }
      const { type, payload = {} } = frame;
      if (type === 'connected') {
        if (selected) return;
        selected = true;
        if (payload.relayIsolation !== true && payload.transport !== 'local') {
          fail('Update Harness on this controller to support independent Grid fleet connections.'); return;
        }
        clearTimeout(deadline);
        deadline = setTimeout(() => fail(updateMessage), Math.min(timeoutMs, 15_000));
        send('grid_fleet_capabilities', { requestId: capabilityId });
        heartbeat = setInterval(() => send('ping', {}), 15_000);
      } else if (type === 'grid_fleet_capabilities_result' && payload.requestId === capabilityId) {
        if (running) return;
        if (payload.protocol !== 1) { fail(updateMessage); return; }
        if (thinking !== undefined && payload.thinkingControl !== true) { fail('Update Harness on this machine to support explicit model thinking controls.'); return; }
        if (payload.gridCli === 'missing') { fail('Grid is not installed on this machine. Install the Grid Harness there first.'); return; }
        clearTimeout(deadline); running = true;
        const duration = Math.min(timeoutMs, payload.maxTimeoutMs || 1_800_000);
        deadline = setTimeout(() => { abort(); }, duration + 5000);
        send('grid_fleet_run', { requestId: commandId, args, timeoutMs: duration, ...(thinking === undefined ? {} : { thinking }) });
      } else if (type === 'grid_fleet_run_result' && payload.requestId === commandId) {
        finish({ ok: payload.ok === true, code: Number.isInteger(payload.code) ? payload.code : 1,
          stdout: typeof payload.stdout === 'string' ? payload.stdout : '', stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
          error: payload.ok === true ? null : typeof payload.error === 'string' ? payload.error : 'Grid command failed.' });
      } else if (['error', 'connection_error', 'local_protocol_error', 'machine_link_required'].includes(type)) {
        fail('This machine is unavailable or needs linking in Harness Machines.');
      }
    });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
