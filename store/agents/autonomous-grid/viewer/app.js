(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const fmt = (n, digits = 1) => finite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
  const age = time => { const seconds = Math.max(0, (Date.now() - Date.parse(time)) / 1000); return !Number.isFinite(seconds) ? '' : seconds < 60 ? `${Math.floor(seconds)}s ago` : `${Math.floor(seconds / 60)}m ago`; };
  const clockTime = time => time ? new Date(time).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '';
  const metricInfo = { tokS: ['Last decode rate', 'tok/s'], temperatureC: ['GPU temperature', '°C'], utilizationPct: ['GPU utilization', '%'], memoryUsedGb: ['Memory used', 'GB'], powerW: ['GPU power', 'W'] };
  let snapshot = null, selected = null, view = 'topology', metric = 'tokS';
  let paused = matchMedia('(prefers-reduced-motion: reduce)').matches, positions = new Map(), drags = {}, dragging = null, moved = false;
  let width = 0, height = 0, hub = { x:0,y:0 }, t = 0, previousFrame = 0, lastReceived = 0, transportLost = false, graphNodes = [];
  let activeScope = '', toastTimer;
  const stage = $('topology'), canvas = $('connections'), ctx = canvas.getContext('2d');
  const nodeButtons = new Map();
  const storage = { read: key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }, write: (key,value) => { try { localStorage.setItem(key,JSON.stringify(value)); } catch {} } };
  function measured(n) { return !n.stale && n.online !== false; }
  function reading(n, field = metric) { return measured(n) ? n[field] : null; }
  function metricMarkup(n, field = metric) { const value=reading(n,field); return finite(value) ? `${fmt(value)} <small>${metricInfo[field][1]}</small>` : '<span class="unmeasured">not reported</span>'; }
  function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>{$('toast').hidden=true;},4000); }
  function status() {
    if (!snapshot) return;
    const late = lastReceived && Date.now() - lastReceived > Math.max(30_000, (snapshot.pollIntervalMs || 8000)*3);
    const state = transportLost || late ? 'disconnected' : snapshot.status;
    const labels={live:'Grid connected',partial:'Partial telemetry',unavailable:'Grid unavailable',unconfigured:'Choose a grid',connecting:'Connecting',disconnected:'Connection lost'};
    $('connection-label').textContent=labels[state] || 'Waiting for Grid';
    $('connection-dot').className='status-dot'+(['unavailable','disconnected'].includes(state)?' offline':state==='live'?'':' pending');
    $('observed').textContent=snapshot.observedAt?`Observed ${age(snapshot.observedAt)}`:'Waiting for Grid';
    $('footer-status').textContent=['unavailable','disconnected'].includes(state)?'Last observations remain visible. Ask Grid to reconnect.':'Talk to Grid in the agent pane.';
  }
  function consume(data) {
    if (!data || data.spec!==1 || !Array.isArray(data.nodes)) return;
    snapshot=data;lastReceived=Date.now();transportLost=false;
    if (activeScope!==data.scope) {
      activeScope=data.scope || 'default';selected=null;
      const saved=storage.read('grid-map:'+activeScope);drags=saved&&typeof saved==='object'?saved:{};
    }
    render();
  }
  function render() {
    if (!snapshot) return;
    $('grid-name').textContent=snapshot.grid;
    $('mode').textContent=snapshot.mode || '';
    const available=!['connecting','unavailable','unconfigured'].includes(snapshot.status);
    $('total-engines').textContent=available?fmt(snapshot.summary.enginesOnline,0):'—';
    $('total-known').textContent=snapshot.nodes.length?`${snapshot.nodes.length} known to this grid`:'waiting for engines';
    $('total-models').textContent=available?fmt(snapshot.summary.modelsServing,0):'—';
    const answered=snapshot.summary.answered;
    $('total-requests').textContent=available?fmt(answered?.requests,0):'—';
    $('requests-window').textContent=finite(answered?.windowSeconds)?`last ${fmt(answered.windowSeconds/3600,1)} hours`:'not reported by this grid';
    graphNodes=snapshot.nodes.slice(0,12);
    stage.dataset.density=graphNodes.length<=4?'spacious':'compact';
    $('map-subtitle').textContent=snapshot.nodes.length>12?`12 of ${snapshot.nodes.length} engines · see every engine in Rack`:'Every machine has a place.';
    $('map-empty').hidden=graphNodes.length>0;
    $('hub').hidden=graphNodes.length===0;
    $('empty-message').textContent=snapshot.status==='unconfigured'?'Ask the Grid agent to connect one of your existing grids, or help you create your first fleet.':snapshot.status==='unavailable'?'Grid isn’t reachable yet. Ask the agent to check your connection, choose a grid, or start one.':'Ask the Grid agent to discover this machine and deploy your first model.';
    $('hub-status').textContent=available?`${snapshot.summary.enginesOnline || 0} engines online`:'awaiting connection';
    const ids=new Set(graphNodes.map(n=>n.id));
    for (const [id,b] of nodeButtons) if (!ids.has(id)) { b.remove();nodeButtons.delete(id); }
    for (const n of graphNodes) {
      let b=nodeButtons.get(n.id);
      if(!b){
        b=document.createElement('button');b.type='button';b.dataset.node=n.id;
        b.addEventListener('click',()=>{if(moved){moved=false;return;}select(n.id);});
        b.addEventListener('pointerdown',event=>{if(event.button!==0)return;dragging={id:n.id,x:event.clientX,y:event.clientY};moved=false;b.setPointerCapture?.(event.pointerId);});
        b.addEventListener('pointermove',event=>{
          if(!dragging||dragging.id!==n.id)return;
          if(Math.hypot(event.clientX-dragging.x,event.clientY-dragging.y)>5)moved=true;
          if(!moved)return;
          const bounds=stage.getBoundingClientRect();
          drags[n.id]={x:(event.clientX-bounds.left)/width,y:(event.clientY-bounds.top)/height};position();draw();
        });
        b.addEventListener('pointerup',()=>{dragging=null;if(moved)storage.write('grid-map:'+activeScope,drags);});
        b.addEventListener('pointercancel',()=>{dragging=null;moved=false;});
        $('nodes').appendChild(b);nodeButtons.set(n.id,b);
      }
      b.className=`node${n.online===false?' offline':''}${n.stale?' stale':''}`;
      b.setAttribute('aria-pressed',String(selected===n.id));
      b.setAttribute('aria-label',`${n.name}, ${n.stale?'stale observation':n.online===false?'offline':n.online===true?'online':'status not reported'}, ${n.models.join(', ') || 'no models'}, ${metricInfo[metric][0]} ${fmt(reading(n))} ${metricInfo[metric][1]}`);
      const usage=finite(n.memoryUsedGb)&&n.memoryTotalGb>0?Math.min(100,n.memoryUsedGb/n.memoryTotalGb*100):null;
      b.innerHTML=`<span class="node-head"><span class="node-name">${escape(n.name)}</span><span class="node-dot"></span></span><span class="node-model" style="display:block">${escape(n.models[0] || 'No models')}${n.models.length>1?` +${n.models.length-1}`:''}</span><span class="node-reading">${metricMarkup(n)}</span>${usage!==null?`<span class="node-bar" style="display:block"><span style="width:${usage}%"></span></span>`:''}<span class="node-hardware">${escape(n.hardware || n.engine)}</span>`;
    }
    renderRack();renderInspector();renderActivity();resize();status();
  }
  function select(id) {selected=selected===id?null:id;for(const [key,b]of nodeButtons)b.setAttribute('aria-pressed',String(key===selected));renderInspector();renderRack();draw();}
  function renderRack() {
    if(!snapshot)return;
    $('rack').innerHTML=snapshot.nodes.length?snapshot.nodes.map(n=>`<button class="rack-engine${n.online===false?' offline':''}" type="button" data-select="${escape(n.id)}" aria-pressed="${selected===n.id}"><span class="rack-strip"></span><h3>${escape(n.name)}</h3><div class="rack-hardware">${escape(n.hardware || n.engine)} · ${n.stale?'stale':n.online===false?'offline':n.online===true?'online':'status unavailable'}</div><div class="rack-models">${escape(n.models.join(' · ') || 'No models advertised')}</div><div class="rack-metrics"><div>${metricMarkup(n,'tokS')}<label>last decode</label></div><div>${metricMarkup(n,'temperatureC')}<label>temperature</label></div><div>${metricMarkup(n,'memoryUsedGb')}<label>memory used</label></div></div></button>`).join(''):'<div class="quiet">Your engines will appear here when they join Grid.</div>';
  }
  const pair=(label,value)=>`<div class="detail-pair"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`;
  const detailMetric=(label,value,unit,hint='')=>`<div class="detail-metric"><span class="label">${escape(label)}</span><span class="value">${fmt(value)} <small>${escape(unit)}</small></span>${hint?`<span class="hint">${escape(hint)}</span>`:''}</div>`;
  function prompt(text) {return `<div class="ask-prompt"><span>ASK YOUR GRID AGENT</span><p>${escape(text)}</p><button class="copy-prompt" type="button" data-prompt="${escape(text)}">Copy request ↗</button></div>`;}
  function gpuDetails(g) {
    const used=finite(g.memoryUsedGb)&&g.memoryGb>0?Math.max(0,Math.min(100,g.memoryUsedGb/g.memoryGb*100)):0;
    return `<div class="gpu-detail"><div class="model-entry"><span class="model-glyph">▧</span><span class="model-title">${escape(g.name)}<span class="model-caption">${fmt(g.memoryUsedGb)} / ${fmt(g.memoryGb)} GB used</span></span></div><div class="memory-track"><span style="width:${used}%"></span></div><div class="memory-labels"><span>${fmt(g.utilizationPct)}% load</span><span>${fmt(g.temperatureC)} °C · ${fmt(g.powerW)} W</span></div></div>`;
  }
  function renderInspector() {
    if(!snapshot)return;
    const node=snapshot.nodes.find(n=>n.id===selected), machine=snapshot.machines?.find(m=>'machine:'+m.id===selected);
    const panel=$('inspector');
    if(machine){
      panel.innerHTML=`<div class="inspector-head"><div><span class="eyebrow">MANAGED MACHINE</span><h2>${escape(machine.name)}</h2><p class="subline">${escape(machine.hardware || machine.error || '')}</p></div><button class="close" type="button" data-close aria-label="Close machine details">×</button></div><div class="detail-status"><span class="status-dot${machine.reachable?'':' offline'}"></span>${machine.reachable?'Reachable':'Unreachable'} · ${escape(machine.transport)}</div><div class="detail-metrics">${detailMetric('System memory',machine.memoryTotalGb,'GB')}${detailMetric('Grid RAM estimate',machine.memoryAvailableGb,'GB','Inventory, not live usage')}${detailMetric('Grid model budget',machine.usableModelGb,'GB')}${detailMetric('Free disk',machine.diskFreeGb,'GB')}</div><div class="detail-section">${pair('Platform',machine.platform || '—')}${pair('Backend',machine.backend || '—')}${pair('CPU cores',fmt(machine.cpuCores,0))}${pair('Observed',age(machine.observedAt))}</div><div class="detail-section"><h3>Graphics</h3>${machine.gpus?.map(gpuDetails).join('')||'<p class="quiet">No GPU reported. CPU models can still be useful.</p>'}</div>${prompt(`Find an open-weight model that fits ${machine.name}, keeping enough memory free for my other work. Explain the tradeoff before deploying it.`)}`;
      return;
    }
    if(node){
      const total=node.memoryTotalGb,used=node.memoryUsedGb;
      const fill=total>0&&finite(used)?Math.max(0,Math.min(100,used/total*100)):0;
      panel.innerHTML=`<div class="inspector-head"><div><span class="eyebrow">ENGINE DETAILS</span><h2>${escape(node.name)}</h2><p class="subline">${escape(node.hardware || node.engine)}${node.platform?`<br>${escape(node.platform)}`:''}</p></div><button class="close" type="button" data-close aria-label="Close engine details">×</button></div><div class="detail-status"><span class="status-dot${node.stale?' pending':node.online===false?' offline':''}"></span>${node.stale?'Last known observation':node.online===true?'Online':node.online===false?'Offline':'Status not reported'}${node.hosted?' · hosted model':''}</div><div class="detail-metrics">${detailMetric('Last decode rate',node.tokS,'tok/s','Per-engine estimate')}${detailMetric('GPU temperature',node.temperatureC,'°C')}${detailMetric('GPU utilization',node.utilizationPct,'%')}${detailMetric('GPU power',node.powerW,'W',node.powerLimitW!==null?`${fmt(node.powerLimitW)} W limit`:'')}</div><div class="detail-section"><h3>${escape(node.memoryKind || 'Model memory')}${node.stale?' · last known':''}</h3>${node.hosted?'<p class="quiet">Hosted models do not contribute local GPU memory.</p>':`<div class="detail-pair"><strong>${fmt(used)} <span>/ ${fmt(total)} GB</span></strong></div><div class="memory-track"><span style="width:${fill}%"></span></div><div class="memory-labels"><span>${fmt(node.memoryFreeGb)} GB free</span><span>${total>0&&finite(used)?fmt(used/total*100,0)+'% used':'not reported'}</span></div>`}</div><div class="detail-section"><h3>${escape(metricInfo[metric][0])} · recent observations</h3>${spark(node.id)}</div><div class="detail-section"><h3>Models on this engine · ${node.models.length}</h3>${node.models.map(model=>{const caps=node.capabilities?.find(c=>c.model===model);return `<div class="model-entry"><span class="model-glyph">◇</span><span class="model-title">${escape(model)}<span class="model-caption">${caps?.contextLength?`${fmt(caps.contextLength,0)} context tokens`:''}${caps?.responses?' · Responses API':''}</span></span></div>`;}).join('')||'<p class="quiet">No models advertised.</p>'}</div><div class="detail-section">${pair('Engine',node.engine)}${pair('Concurrency',fmt(node.concurrency,0))}${pair('Active requests',fmt(node.activeRequests,0))}${pair('Disk',`${fmt(node.diskUsedGb)} / ${fmt(node.diskTotalGb)} GB`)}${pair('Output tokens',fmt(node.answered?.tokensOut,0))}${pair('Usage window',node.answered?.windowSeconds?`${fmt(node.answered.windowSeconds/3600)} hours`:'—')}${pair('Last observed',age(node.observedAt))}${node.endpoint?`<div class="endpoint">${escape(node.endpoint)}</div>`:''}</div>${prompt(`Review the models on ${node.name} and suggest a better placement for my workload, using measured memory and performance.`)}`;
      return;
    }
    const errors=Object.values(snapshot.sources || {}).filter(s=>!s.ok);
    panel.innerHTML=`<div class="inspector-head"><div><span class="eyebrow">FLEET OVERVIEW</span><h2>One grid.<br>All your compute.</h2><p class="subline">An agent that knows your machines.<br>A place for every model.</p></div></div><div class="detail-section" style="border-top:0;padding-top:0"><h3>Serving on your grid</h3>${snapshot.models.map(m=>`<div class="model-entry"><span class="model-glyph">◇</span><span class="model-title">${escape(m.id)}<span class="model-caption">${m.nodes.length} ${m.nodes.length===1?'engine':'engines'}</span></span></div>`).join('')||'<p class="quiet">No serving models reported yet.</p>'}</div><div class="detail-section"><h3>Managed machines · ${snapshot.machines?.length||0}</h3>${(snapshot.machines||[]).map(m=>`<div class="host-row${m.reachable?'':' offline'}"><span class="host-dot"></span><button type="button" data-select="machine:${escape(m.id)}">${escape(m.name)}<small>${escape(m.hardware || (m.reachable?m.transport:'unreachable'))}${finite(m.memoryTotalGb)?` · ${fmt(m.memoryTotalGb,0)} GB`:''}</small></button></div>`).join('')}<p class="quiet">Select a machine to inspect its capacity.</p></div>${snapshot.endpoint?`<div class="detail-section"><h3>Your endpoint</h3><div class="endpoint">${escape(snapshot.endpoint)}</div></div>`:''}${errors.map(s=>`<div class="source-error">${escape(s.error)}</div>`).join('')}${prompt(snapshot.nodes.length?'Find the best way to run a coding model and a fast everyday chat model across my machines.':'Discover my machines and help me deploy an open-weight model that fits.')}`;
  }
  function spark(id) {
    const samples=snapshot.history?.[id]||[],valid=samples.filter(s=>finite(s[metric]));
    if(valid.length<2)return '<div class="spark-empty">Waiting for measured history</div>';
    const start=Date.parse(samples[0].at),end=Date.parse(samples.at(-1).at),span=end-start||1,max=Math.max(...valid.map(s=>s[metric]),1)*1.15;
    let d='',pen=false;
    for(const sample of samples){if(!finite(sample[metric])){pen=false;continue;}const x=3+(Date.parse(sample.at)-start)/span*244,y=64-sample[metric]/max*53;d+=`${pen?'L':'M'}${x.toFixed(1)},${y.toFixed(1)} `;pen=true;}
    return `<svg class="spark" viewBox="0 0 250 73" role="img" aria-label="${escape(metricInfo[metric][0])} history, ${valid.length} observations"><path d="M0 64H250 M0 37H250 M0 10H250" stroke="#ffffff0a" fill="none"/><path d="${d}" stroke="#dfb465" stroke-width="1.6" fill="none"/><text x="247" y="9" fill="#778799" font-size="8" text-anchor="end">${fmt(max)} ${metricInfo[metric][1]}</text></svg><div class="spark-labels"><span>${clockTime(samples[0].at)}</span><span>${clockTime(samples.at(-1).at)}</span></div>`;
  }
  function renderActivity() {
    const operations=(snapshot.operations||[]).map(op=>({id:op.id,at:op.endedAt||op.startedAt,kind:op.phase,message:`${snapshot.machines?.find(m=>m.id===op.machine)?.name||op.machine} · ${op.command} · ${op.phase}`}));
    const events=[...operations,...(snapshot.events||[])].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,5);
    $('activity-list').innerHTML=events.length?events.map(event=>`<div class="activity-row ${escape(event.kind)}"><span class="pip"></span><span class="message">${escape(event.message)}</span><span class="activity-time">${escape(age(event.at))}</span></div>`).join(''):'<div class="quiet">Grid operations and changes to your fleet appear here.</div>';
  }
  function resize() {
    if(view==='rack')return;
    width=stage.clientWidth||800;
    const small=width<620;
    const expanded=small?230+Math.ceil(graphNodes.length/2)*144:graphNodes.length>8?Math.max(680,200+Math.ceil(graphNodes.length/4)*150):560;
    stage.style.height=Math.max(width<540?600:560,expanded)+'px';height=stage.clientHeight;
    const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx?.setTransform(dpr,0,0,dpr,0,0);
    position();draw();
  }
  function position() {
    const small=width<620,count=graphNodes.length;
    hub={x:width*.5,y:small?150:height*.49};
    $('hub').style.left=hub.x+'px';$('hub').style.top=hub.y+'px';
    const anchors=[[.14,.31],[.36,.18],[.15,.63],[.36,.83],[.69,.17],[.85,.40],[.85,.73],[.64,.88]];
    const smallFleet={1:[[.22,.49]],2:[[.22,.35],[.78,.65]],3:[[.20,.34],[.80,.34],[.50,.85]],4:[[.20,.32],[.80,.32],[.20,.76],[.80,.76]]};
    graphNodes.forEach((n,i)=>{
      const b=nodeButtons.get(n.id);if(!b)return;
      let base;
      if(small)base={x:width*(i%2===0?.25:.75),y:275+Math.floor(i/2)*144};
      else if(count<=8){const a=(smallFleet[count]||anchors)[i];base={x:width*a[0],y:height*a[1]};}
      else {const half=Math.ceil(count/2),left=i<half;const k=left?i:i-half;base={x:width*(left?.18:.82),y:115+k*(height-190)/(half-1)};}
      const stored=drags[n.id];if(stored&&finite(stored.x)&&finite(stored.y))base={x:stored.x*width,y:stored.y*height};
      const inset=(b.offsetWidth||140)/2+12;
      const x=Math.max(inset,Math.min(width-inset,base.x+(dragging?.id===n.id?0:Math.sin(t*.20+i*.78)*3)));
      const y=Math.max(105,Math.min(height-95,base.y+(dragging?.id===n.id?0:Math.cos(t*.18+i*.64)*3)));
      positions.set(n.id,{x,y});b.style.left=x+'px';b.style.top=y+'px';
    });
  }
  function draw() {
    if(!ctx||view!=='topology')return;
    ctx.clearRect(0,0,width,height);
    if(!graphNodes.length)return;
    const glow=ctx.createRadialGradient(hub.x,hub.y,10,hub.x,hub.y,180);glow.addColorStop(0,'rgba(185,134,36,.13)');glow.addColorStop(1,'rgba(170,117,27,0)');ctx.fillStyle=glow;ctx.fillRect(0,0,width,height);
    for(let i=0;i<70;i++){ctx.fillStyle=`rgba(171,159,130,${i%6===0?.16:.06})`;ctx.beginPath();ctx.arc(((i*173.87+42)%991)/991*width,((i*131.2+31)%587)/587*height,i%5===0?1:.55,0,Math.PI*2);ctx.fill();}
    for(let i=0;i<graphNodes.length;i++){
      const node=graphNodes[i],p=positions.get(node.id);if(!p)continue;
      const online=node.online===true&&!node.stale&&!transportLost&&Date.now()-lastReceived<30000,active=finite(node.activeRequests)?node.activeRequests:0,chosen=selected===node.id;
      ctx.beginPath();ctx.strokeStyle=chosen?'rgba(237,188,85,.70)':online?'rgba(173,140,74,.31)':'rgba(115,126,141,.17)';ctx.lineWidth=chosen?1.35:.75;ctx.setLineDash(online?[]:[3,7]);ctx.moveTo(hub.x,hub.y);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.setLineDash([]);
      // Connection pulses express online membership. Only measured active requests add extra pulses.
      if(online){const pulses=1+Math.min(3,active);for(let j=0;j<pulses;j++){const progress=(t*(.045+Math.min(active,4)*.008)+i*.137+j/pulses)%1;const x=hub.x+(p.x-hub.x)*progress,y=hub.y+(p.y-hub.y)*progress;ctx.beginPath();ctx.strokeStyle='rgba(232,183,78,.27)';ctx.moveTo(x-(p.x-hub.x)*.026,y-(p.y-hub.y)*.026);ctx.lineTo(x,y);ctx.stroke();ctx.fillStyle=chosen?'#f4d795':'#c4a25e';ctx.shadowColor='#d5ab52';ctx.shadowBlur=6;ctx.beginPath();ctx.arc(x,y,chosen?1.8:1.25,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;}}
    }
    for(let ring=0;ring<3;ring++){ctx.beginPath();ctx.strokeStyle=ring===0?'rgba(211,165,72,.63)':`rgba(190,146,55,${ring===1?.12:.05})`;ctx.lineWidth=ring===0?1.7:1;const angle=t*.075*(ring%2?-1:1);ctx.arc(hub.x,hub.y,88+ring*13,angle,angle+Math.PI*(ring===0?1.85:1.4));ctx.stroke();}
  }
  function frame(time) {
    if(!paused&&!document.hidden&&view==='topology') {t+=Math.min((time-previousFrame)/1000,.08)||0;position();draw();}
    previousFrame=time;requestAnimationFrame(frame);
  }
  function setView(value) {view=value;$('topology').hidden=value!=='topology';$('rack').hidden=value!=='rack';$('topology-button').setAttribute('aria-pressed',String(value==='topology'));$('rack-button').setAttribute('aria-pressed',String(value==='rack'));resize();}
  $('topology-button').addEventListener('click',()=>setView('topology'));
  $('rack-button').addEventListener('click',()=>setView('rack'));
  $('metric').addEventListener('change',event=>{metric=event.target.value;render();});
  $('motion').addEventListener('click',()=>{paused=!paused;$('motion').textContent=paused?'Resume motion':'Pause motion';$('motion').setAttribute('aria-pressed',String(paused));});
  $('motion').textContent=paused?'Resume motion':'Pause motion';$('motion').setAttribute('aria-pressed',String(paused));
  $('hub').addEventListener('click',()=>{selected=null;render();});
  document.addEventListener('click',async event=>{
    const close=event.target.closest('[data-close]'),selection=event.target.closest('[data-select]'),copy=event.target.closest('[data-prompt]');
    if(close){selected=null;render();}else if(selection)select(selection.dataset.select);
    else if(copy){try{await navigator.clipboard.writeText(copy.dataset.prompt);toast('Request copied. Paste it into your Grid agent.');}catch{toast('Select the request text and paste it into your Grid agent.');}}
  });
  new ResizeObserver(()=>resize()).observe(stage);
  const stream=new EventSource('events');
  stream.addEventListener('snapshot',event=>{try{consume(JSON.parse(event.data));}catch{transportLost=true;status();}});
  stream.onerror=()=>{transportLost=true;status();};
  const fetchSnapshot=()=>fetch('api/snapshot',{signal:AbortSignal.timeout(12_000)}).then(r=>{if(!r.ok)throw new Error();return r.json();}).then(consume).catch(()=>{transportLost=true;status();});
  fetchSnapshot();setInterval(()=>{status();if(transportLost)fetchSnapshot();},8000);
  requestAnimationFrame(frame);
})();
