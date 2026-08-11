/**
 * Self-contained local dashboard for the machine-adapter, served by the hook server on
 * 127.0.0.1:<port>. Vanilla HTML/CSS/JS (no framework, no build) — polls GET /api/status and drives
 * the loopback management API (approve pairing, unpair, stop). Scoped to LOCAL-only concerns (adapter
 * health, machine fingerprint, local pairings); it never renders chat/transcripts — that's the cloud
 * web (WEB_URL/machine/<agentId>). 
 *
 * CSRF: mutating calls send the `x-adapter-local: 1` header, which a cross-origin page cannot set on a
 * simple request (a custom header forces a CORS preflight the server never allows) — so only this
 * same-origin page (and the CLI) can trigger actions.
 */
export const LOCAL_WEB_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>harness</title>
<style>
  :root { color-scheme: dark; --bg:#0e1116; --card:#161b22; --line:#232a34; --fg:#e6edf3; --mut:#8b949e; --faint:#6e7681; --grn:#3fb950; --red:#e5534b; --yel:#d29922; --acc:#4c8bf5; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system, system-ui, sans-serif; }
  a { color:var(--acc); text-decoration:none; } a:hover { text-decoration:underline; }
  .wrap { max-width:960px; margin:0 auto; padding:20px 16px 48px; }
  .bar { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .brand { font-weight:600; }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; vertical-align:middle; }
  .on { background:var(--grn); } .off { background:var(--red); } .idle { background:var(--faint); }
  .mut { color:var(--mut); } .mono { font-family:var(--mono); }
  .fp { font-family:var(--mono); letter-spacing:.04em; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 7px; font-size:11px; color:var(--mut); margin-right:6px; text-transform:uppercase; }
  .spacer { flex:1; }
  .btn { background:none; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:5px 12px; font-size:12.5px; cursor:pointer; }
  .btn:hover { border-color:var(--acc); }
  .btn.danger:hover { border-color:var(--red); color:var(--red); }
  .btn.primary { background:var(--acc); border-color:var(--acc); color:#fff; font-weight:600; }
  .btn.primary:hover { filter:brightness(1.08); }
  .btn:disabled { opacity:.6; cursor:default; }
  /* approve modal */
  .modal { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; z-index:50; padding:16px; }
  .modalCard { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px 22px 18px; max-width:440px; width:100%; box-shadow:0 12px 40px rgba(0,0,0,.5); }
  .mTitle { font-size:17px; font-weight:600; }
  .mSub { color:var(--mut); font-size:13px; margin-top:8px; line-height:1.5; }
  .mCodeLabel { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); margin-top:16px; }
  .mCode { font-family:var(--mono); font-size:30px; letter-spacing:.22em; font-weight:700; margin-top:4px; }
  .mNote { font-size:12px; color:var(--mut); margin-top:6px; }
  .mInput { font-family:var(--mono); background:var(--bg); border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:8px 12px; letter-spacing:.2em; text-transform:uppercase; width:150px; margin-top:6px; }
  .mFp { font-size:12px; color:var(--mut); margin-top:16px; }
  .mBtns { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:16px; }
  @media (max-width:720px){ .grid { grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card h2 { margin:0 0 10px; font-size:13px; font-weight:600; color:var(--mut); text-transform:uppercase; letter-spacing:.05em; }
  .row { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--line); }
  .row:first-of-type { border-top:0; }
  .row .main { flex:1; min-width:0; }
  .row .name { font-weight:500; }
  .row .sub { color:var(--faint); font-size:12px; font-family:var(--mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .empty { color:var(--faint); padding:8px 0; }
  .pending { margin-top:16px; background:#20160a; border:1px solid #4a3a12; border-radius:12px; padding:14px 16px; }
  .pending input { font-family:var(--mono); background:var(--bg); border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:6px 10px; letter-spacing:.2em; text-transform:uppercase; width:120px; }
  .about { margin-top:16px; }
  .statusGrid { display:grid; grid-template-columns:1fr 1fr; gap:8px 18px; }
  @media (max-width:520px){ .statusGrid { grid-template-columns:1fr; } }
  .metric { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 0; border-top:1px solid var(--line); }
  .metric:first-child, .metric:nth-child(2) { border-top:0; }
  @media (max-width:520px){ .metric:nth-child(2) { border-top:1px solid var(--line); } }
  .metric .k { color:var(--mut); }
  .metric .v { font-weight:600; white-space:nowrap; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .adv { margin-top:12px; border-top:1px solid var(--line); padding-top:10px; }
  .adv summary { cursor:pointer; color:var(--mut); font-size:12.5px; }
  .adv .kv { display:flex; gap:8px; padding:3px 0; font-size:12.5px; }
  .adv .k { color:var(--faint); width:110px; flex:none; }
  .adv .v { font-family:var(--mono); overflow:hidden; text-overflow:ellipsis; }
  .toast { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 16px; opacity:0; transition:opacity .2s; }
  .toast.show { opacity:1; }
  pre.logs { max-height:220px; overflow:auto; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px; font-size:11.5px; color:var(--mut); margin:0; }
</style>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <span class="brand">harness</span>
    <span id="conn"><span class="dot idle"></span> <span class="mut">connecting…</span></span>
    <span id="device"><span class="dot idle"></span> <span class="mut">device —</span></span>
    <span class="mut">machine <span id="agent" class="mono">—</span></span>
    <span class="mut" id="agents">no agents</span>
    <span class="mut">up <span id="uptime">—</span></span>
    <span class="spacer"></span>
    <button class="btn danger" onclick="stopAdapter()">Stop</button>
  </div>
  <div class="bar" style="margin-top:10px;">
    <span class="mut">machine fingerprint</span> <span id="fp" class="fp">—</span>
    <span class="spacer"></span>
    <a id="weblink" href="#" target="_blank" rel="noreferrer">open in web ↗</a>
  </div>

  <div id="pending"></div>

  <div class="grid">
    <div class="card">
      <h2>Sessions (tmux claude)</h2>
      <div id="sessions"><div class="empty">loading…</div></div>
    </div>
    <div class="card">
      <h2>Paired browsers <button class="btn danger" style="float:right;font-size:11px;padding:2px 8px" onclick="unpairAll()">Unpair all</button></h2>
      <div id="pairs"><div class="empty">loading…</div></div>
    </div>
  </div>

  <div class="card about">
    <h2>Machine</h2>
    <div id="about"></div>
    <details id="logsBox" style="margin-top:10px"><summary class="mut" style="cursor:pointer">Logs</summary>
      <pre class="logs" id="logs">—</pre>
    </details>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const H = { 'x-adapter-local': '1' };
let pendKey = null;      // identity of the pending shown — so polling doesn't clobber the modal/input
let dismissedKey = null; // pending fully handled (approved) — don't rebuild until it changes
let modalClosed = false; // user hit Close on the approve modal → behave like no ?code (normal UI) this session
let lastStatus = null;   // last /api/status snapshot (for closeModal to re-render inline immediately)
// Code from the "Open dashboard & approve" link on the web (?code=…). It travels via the URL the user
// clicks in their own browser (loopback), never through the backend — so CPace security is preserved.
const params = new URLSearchParams(location.search);
const urlCode = (params.get('code') || '').toUpperCase();
const setupMode = params.get('setup') === 'browser';
let setupModalOpen = false;
let setupInFlight = false;
let setupAutoAttempted = false;
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(m){ const t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),1800); }
function fmtDur(s){ s=Math.max(0,s|0); const d=s/86400|0,h=s%86400/3600|0,m=s%3600/60|0; return d?d+'d '+h+'h':h?h+'h '+m+'m':m?m+'m':s+'s'; }
function fmtWhen(ts){ try{ return new Date(ts).toISOString().slice(0,16).replace('T',' ') }catch{ return '' } }

async function post(path, body){
  const r = await fetch(path, { method:'POST', headers:{...H, ...(body?{'content-type':'application/json'}:{})}, body: body?JSON.stringify(body):undefined });
  const j = await r.json().catch(()=>({})); return { ok:r.ok, status:r.status, j };
}
// Strip ?code=… from the address bar (no reload) once the pairing is handled — so a refresh doesn't
// re-open the modal with a stale/consumed code, and the code doesn't linger in history.
function clearUrlCode(){ try { history.replaceState(null, '', location.pathname); } catch(e) {} }
function clearSetupUrl(){ try { history.replaceState(null, '', location.pathname); } catch(e) {} }

function showBrowserSetup(html){
  document.getElementById('pending').innerHTML = '<div class="pending">'+html+'</div>';
}
function buildSetupApproveModal(s){
  const machineUrl = s && s.webUrl && s.agentId ? (s.webUrl.replace(/\\/$/,'')+'/machine/'+s.agentId) : 'Machine';
  document.getElementById('pending').innerHTML =
    '<div class="modal"><div class="modalCard">'
    + '<div class="mTitle">Set up browser encryption?</div>'
    + '<div class="mSub">This creates a reusable 7-day setup link. Anyone with the link can pair a browser until it expires, so keep it private.</div>'
    + '<div class="mCodeLabel">machine</div><div class="mFp"><span class="fp">'+esc((s&&s.fingerprint)||'—')+'</span></div>'
    + '<div class="mCodeLabel">destination</div><div class="mFp">'+esc(machineUrl)+'</div>'
    + '<div class="mBtns"><button class="btn" onclick="closeSetupModal()">Cancel</button><button id="setupApproveBtn" class="btn primary" onclick="approveBrowserSetup()">Approve</button></div>'
    + '</div></div>';
}
function startBrowserSetup(){
  if (setupInFlight) return;
  setupModalOpen = true;
  buildSetupApproveModal(lastStatus || {});
}
function closeSetupModal(){
  setupModalOpen = false;
  if (setupMode) {
    history.back();
    setTimeout(() => {
      clearSetupUrl();
      document.getElementById('pending').innerHTML = '';
      if (lastStatus) render(lastStatus);
    }, 250);
    return;
  }
  clearSetupUrl();
  document.getElementById('pending').innerHTML = '';
  if (lastStatus) render(lastStatus);
}
async function approveBrowserSetup(){
  if (setupInFlight) return;
  setupInFlight = true;
  setupModalOpen = false;
  const btn = document.getElementById('setupApproveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
  showBrowserSetup('<b>Generating browser setup link…</b><div class="mut" style="margin-top:6px">You will be returned to Machine automatically.</div>');
  const { ok, j } = await post('/api/e2ee/setup-link');
  if (ok && typeof j.url === 'string' && j.url) {
    location.replace(j.url);
    return;
  }
  setupInFlight = false;
  clearSetupUrl();
  showBrowserSetup(
    '<b>Could not generate setup link</b>'
    + '<div class="mut" style="margin-top:6px">'+esc(j.error || 'Try running harness browser-link in the terminal.')+'</div>'
    + '<div style="margin-top:10px"><button class="btn" onclick="startBrowserSetup()">Try again</button></div>'
  );
}

async function doApprove(){
  const el = document.getElementById('code');
  const code = (urlCode || (el ? el.value.trim().toUpperCase() : '')).trim();
  if(!code){ toast('Enter the pairing code'); return; }
  clearUrlCode();
  const btn = document.getElementById('approveBtn'); if(btn){ btn.disabled = true; btn.textContent = 'Approving…'; }
  const { ok, j } = await post('/api/pair', { code });
  if (ok){ toast('✓ Paired '+(j.fingerprint||'')); dismissedKey = pendKey; document.getElementById('pending').innerHTML = ''; }
  else { toast('✗ '+(j.error||'failed')); if(btn){ btn.disabled = false; btn.textContent = 'Approve'; } }
  refresh();
}
// Close = don't approve now → drop back to the normal page (same as opening without ?code): show the
// subtle inline banner instead of the blocking modal, for the rest of this session.
function closeModal(){ modalClosed = true; clearUrlCode(); pendKey = null; if (lastStatus) render(lastStatus); else document.getElementById('pending').innerHTML = ''; }
function pendingRoleLabel(s){ return s && s.pending && s.pending.role === 'device' ? 'device' : 'browser'; }
// Inline (non-blocking) banner when the dashboard is opened directly and a client happens to be waiting.
function buildInlinePending(s){
  const role = pendingRoleLabel(s);
  document.getElementById('pending').innerHTML =
    '<div class="pending"><b>🔒 A '+esc(role)+' is waiting to pair</b> — <span class="mut">'+esc(s.pending.label)+'</span>'
    + '<div style="margin-top:8px">Enter the code shown on that '+esc(role)+': '
    + '<input id="code" maxlength="8" placeholder="ABC123" onkeydown="if(event.key===\\'Enter\\')doApprove()"> '
    + '<button class="btn" onclick="doApprove()">Approve</button></div></div>';
}
function buildApproveModal(s){
  const p = s.pending;
  const role = pendingRoleLabel(s);
  const codeBlock = urlCode
    ? '<div class="mCodeLabel">verification code</div><div class="mCode">'+esc(urlCode)+'</div><div class="mNote">Make sure this matches the code on your '+esc(role)+' screen.</div>'
    : '<div class="mCodeLabel">enter the code shown on your '+esc(role)+'</div><input id="code" class="mInput" maxlength="8" placeholder="ABC123" onkeydown="if(event.key===\\'Enter\\')doApprove()">';
  document.getElementById('pending').innerHTML =
    '<div class="modal"><div class="modalCard">'
    + '<div class="mTitle">🔒 Approve this '+esc(role)+'?</div>'
    + '<div class="mSub">A '+esc(role)+' (<b>'+esc(p.label)+'</b>) is asking to pair for end-to-end encryption. Approve only if you started this flow.</div>'
    + codeBlock
    + '<div class="mFp">this computer · <span class="fp">'+esc(s.fingerprint||'')+'</span></div>'
    + '<div class="mBtns"><button class="btn" onclick="closeModal()">Close</button><button id="approveBtn" class="btn primary" onclick="doApprove()">Approve</button></div>'
    + '</div></div>';
  const el = document.getElementById('code'); if (el) el.focus();
}
async function unpair(id){ const { ok, j } = await post('/api/revoke', { id }); toast(ok?('✓ Unpaired '+(j.fingerprint||'')):('✗ '+(j.error||'failed'))); refresh(); }
async function unpairAll(){ if(!confirm('Unpair every browser?')) return; const { j } = await post('/api/revoke-all'); toast('✓ Unpaired '+(j.count||0)); refresh(); }
async function stopAdapter(){ if(!confirm('Stop the adapter?')) return; await post('/api/stop'); toast('Stopping…'); }
function isDevicePair(p){
  return !!p && (p.role === 'device' || String(p.label || '').toLowerCase() === 'device');
}

function render(s){
  lastStatus = s;
  const c = document.getElementById('conn');
  c.innerHTML = '<span class="dot '+(s.connected?'on':'off')+'"></span> <span class="mut">'+(s.connected?'cloud connected':'cloud reconnecting…')+'</span>';
  const d = document.getElementById('device');
  const deviceOnline = !!s.deviceE2eeConnected || !!((s.pairs||[]).find(p => isDevicePair(p) && p.online));
  const deviceTransport = !!s.deviceTransportConnected;
  d.innerHTML = '<span class="dot '+(deviceOnline?'on':deviceTransport?'idle':'off')+'"></span> <span class="mut">device '+(deviceOnline?'connected':deviceTransport?'pairing':'offline')+'</span>';
  document.getElementById('agent').textContent = (s.agentId||'').slice(0,8) || '—';
  const nAgents = (s.sessions||[]).length;
  document.getElementById('agents').textContent = nAgents === 0 ? 'no agents' : nAgents + (nAgents === 1 ? ' agent' : ' agents');
  document.getElementById('uptime').textContent = fmtDur(s.uptimeSec);
  document.getElementById('fp').textContent = s.fingerprint || '—';
  const wl = document.getElementById('weblink');
  wl.href = s.webUrl ? (s.webUrl.replace(/\\/$/,'')+'/machine/'+s.agentId) : '#';

  // sessions
  const se = document.getElementById('sessions');
  se.innerHTML = (s.sessions&&s.sessions.length) ? s.sessions.map(x =>
    '<div class="row"><div class="main"><div class="name">'+esc(x.name)+'</div><div class="sub">'+esc(x.cwd||'')+'  ·  '+esc(x.tmuxPane||'')+'</div></div><div class="mut" style="font-size:12px">'+fmtWhen(x.updatedAt)+'</div></div>'
  ).join('') : '<div class="empty">No tmux claude sessions. Run <span class="mono">claude</span> in a tmux pane.</div>';

  // pairs
  const pe = document.getElementById('pairs');
  pe.innerHTML = (s.pairs&&s.pairs.length) ? s.pairs.map(p => {
    const role = isDevicePair(p) ? 'device' : (p.role || 'web');
    return '<div class="row"><span class="dot '+(p.online?'on':'idle')+'"></span><div class="main"><div class="name fp">'+esc(p.fingerprint)+'</div><div class="sub"><span class="pill">'+esc(role)+'</span>'+esc(p.label)+'  ·  paired '+fmtWhen(p.pairedAt)+'</div></div><button class="btn danger" onclick="unpair(\\''+esc(p.fingerprint)+'\\')">Unpair</button></div>';
  }).join('') : '<div class="empty">No clients paired. Use Set up browser or run <span class="mono">harness browser-link</span>.</div>';

  // pending — rebuild ONLY when it actually changes (new/rotated pairing), else leave the code input
  // and whatever the user typed/pasted intact (polling every 2.5s must not wipe the field).
  // Pending pairing → a MODAL popup. Built once per pending (guarded by pendKey) so polling every 2.5s
  // doesn't clobber it. If the web link supplied ?code=…, it's pre-filled and the user just clicks
  // Approve — nothing to type. Otherwise a code input is shown as a fallback.
  const pd = document.getElementById('pending');
  if (setupModalOpen) {
    buildSetupApproveModal(s);
  } else if (!setupInFlight) {
    if (s.pending) {
      const key = s.pending.expiresAt + '|' + s.pending.label;
      if (key !== pendKey) {
        pendKey = key;
        // A blocking modal ONLY when arrived via the web "Approve" link (?code=…) and not yet closed;
        // opening directly (or after Close) shows a subtle inline banner instead (normal UI, no overlay).
        if (dismissedKey !== key) { if (urlCode && !modalClosed) buildApproveModal(s); else buildInlinePending(s); }
      }
    } else if (pendKey !== null) { pd.innerHTML = ''; pendKey = null; dismissedKey = null; }
  }

  // machine summary — keep the default view human-readable; tuck raw paths/ports into Advanced.
  const cfg = s.config||{};
  const sessionCount = (s.sessions&&s.sessions.length) || 0;
  const pairCount = (s.pairs&&s.pairs.length) || 0;
  const machineUrl = s.webUrl ? (s.webUrl.replace(/\\/$/,'')+'/machine/'+s.agentId) : '#';
  document.getElementById('about').innerHTML =
    '<div class="statusGrid">'
    + metric('Machine cloud', s.connected ? 'Connected' : 'Reconnecting')
    + metric('Claude sessions', sessionCount ? ('Watching '+sessionCount) : 'Waiting')
    + metric('Browsers', pairCount ? (pairCount+' paired') : 'None paired')
    + metric('Device', deviceOnline ? 'Connected' : deviceTransport ? 'Pairing' : 'Offline')
    + '</div>'
    + '<div class="actions"><a class="btn" href="'+esc(machineUrl)+'" target="_blank" rel="noreferrer">Open machine</a><button class="btn" onclick="startBrowserSetup()">Set up browser</button><a class="btn" href="#pairs">Clients</a><button class="btn" onclick="document.getElementById(\\'logsBox\\').open=true;document.getElementById(\\'logsBox\\').scrollIntoView({behavior:\\'smooth\\',block:\\'nearest\\'});">View logs</button></div>'
    + '<details class="adv"><summary>Advanced</summary>'
    + kv('Backend URL', s.backendUrl)
    + kv('Watched folder', cfg.watching)
    + kv('CLI data', cfg.dataDir)
    + kv('Local control', cfg.port)
    + '</details>';
}
function metric(k,v){ return '<div class="metric"><span class="k">'+esc(k)+'</span><span class="v">'+esc(v||'')+'</span></div>'; }
function kv(k,v){ return '<div class="kv"><span class="k">'+esc(k)+'</span><span class="v">'+esc(v||'')+'</span></div>'; }

async function refresh(){
  try {
    const s = await (await fetch('/api/status')).json();
    render(s);
    if (setupMode && !setupAutoAttempted) { setupAutoAttempted = true; startBrowserSetup(); }
    fetch('/api/logs').then(r=>r.ok?r.text():'').then(t=>{ if(t) document.getElementById('logs').textContent = t; }).catch(()=>{});
  } catch { document.getElementById('conn').innerHTML = '<span class="dot off"></span> <span class="mut">cloud unreachable</span>'; }
}
refresh(); setInterval(refresh, 2500);
</script>
</body>
</html>`
