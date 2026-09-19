const $ = id => document.getElementById(id);
const text = (tag, value, className) => {const e=document.createElement(tag);e.textContent=value;if(className)e.className=className;return e;};
let state, parameters, domain, draftRevision, dirty=false, selected=null, motion=!matchMedia('(prefers-reduced-motion: reduce)').matches, lastResult='', lastJob='', moduleAttempts=0, pending=false, refreshing=false;
const abort = new AbortController();
const artifactURL = path => '/artifacts/'+path.split('/').map(encodeURIComponent).join('/');
const announce = message => {$('announcement').textContent=message;};
function notice(message, error=false) {$('notice').textContent=message;$('notice').hidden=!message;$('notice').classList.toggle('error',error);}
async function api(path, body) {const r=await fetch(path,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
function setParameter(id,value) {
  if(!dirty)draftRevision=state.revision;
  parameters[id]=value;dirty=true;$('dirty').textContent='UNSAVED';
  const input=document.querySelector(`[name="${CSS.escape(id)}"]`);if(input){input.value=value;input.dispatchEvent(new Event('studio-value'));}
  domain?.update(parameters,selected??state.result,motion);
}
function controls(config) {
  $('controls').replaceChildren();
  for(const c of config.controls){
    if(c.hidden)continue;
    const label=text('label','', 'control'), head=text('span','', 'control-head'), caption=text('span',c.label), output=text('output','');
    let input;
    if(c.type==='select'){input=document.createElement('select');for(const o of c.options){const opt=text('option',o.label);opt.value=o.value;input.append(opt);}}
    else{input=document.createElement('input');input.type=c.type==='number'?'range':'text';if(c.type==='number'){input.min=c.min;input.max=c.max;input.step=c.step??1;}else input.maxLength=c.maxLength??500;}
    input.setAttribute('aria-label',c.label);input.name=c.id;input.id=`control-${c.id}`;input.value=parameters[c.id];label.htmlFor=input.id;
    const update=()=>{output.value=c.type==='number'?`${input.value}${c.unit?' '+c.unit:''}`:'';if(c.type==='number')input.setAttribute('aria-valuetext',output.value);};update();input.addEventListener('studio-value',update);
    input.addEventListener('input',()=>{update();setParameter(c.id,c.type==='number'?Number(input.value):input.value);});
    head.append(caption,output);label.append(head,input);if(c.hint)label.append(text('small',c.hint));$('controls').append(label);
  }
}
function renderResult(result){
  $('metrics').replaceChildren();$('artifacts').replaceChildren();
  for(const m of result?.metrics??[]){const card=text('div','', 'metric'),label=text('span',m.label,'metric-label'),value=text('span',String(m.value),'metric-value');if(m.unit)value.append(text('span',m.unit,'metric-unit'));card.append(label,value);$('metrics').append(card);}
  $('result-title').textContent=result?.title??'Your next idea starts here';$('result-description').textContent=result?.description??state.config.empty;
  $('provenance').textContent=result?.engine??state.config.previewLabel;
  $('run-time').textContent=result?new Date(result.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';
  for(const a of result?.artifacts??[]){const link=text('a',`↓  ${a.label}`,'artifact');link.href=artifactURL(a.path)+'?download';link.download='';link.setAttribute('aria-label',`Download ${a.label}`);$('artifacts').append(link);}
  domain?.update(parameters,result,motion);
}
function renderHistory(){
  $('history').replaceChildren();
  for(const r of state.history){const item=document.createElement('li'),button=document.createElement('button');button.type='button';button.setAttribute('aria-current',String(selected?.id===r.id));const content=text('span','', 'history-content');content.append(text('span',r.title,'history-title'),text('span',`${r.engine} · ${new Date(r.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`,'history-time'));button.append(text('span','','history-dot'),content);if(r.metrics?.[0])button.append(text('span',r.metrics[0].value,'history-value'));button.addEventListener('click',async()=>{try{selected=await api(`/api/run?id=${encodeURIComponent(r.id)}`);$('latest').hidden=false;renderResult(selected);renderHistory();announce(`Viewing ${r.title}`);}catch(e){notice(e.message,true);}});item.append(button);$('history').append(item);}
  if(!state.history.length)$('history').append(text('li','Your first run will live here.','muted'));
}
async function run(action){
  if(pending)return;
  pending=true;notice('');$('run').disabled=true;
  try{await api('/api/run',{action,parameters,revision:draftRevision??state.revision});dirty=false;selected=null;await refresh();announce('Run started.');}catch(e){notice(e.message,true);}finally{pending=false;$('run').disabled=state?.job?.status==='running';}
}
async function refresh(){
  if(refreshing)return;
  refreshing=true;
  try{
    const next=await api('/api/state');
    const changed=state&&next.revision!==state.revision;
    if(!state){state=next;parameters={...state.project.parameters};const c=state.config;document.title=c.title+' · Harness';$('title').textContent=c.title;$('description').textContent=c.description;$('category').textContent=c.category.toUpperCase();$('scene-label').textContent=c.scene.toUpperCase();$('hint').textContent=c.hint;$('tip').textContent=c.tip;$('credit').textContent=c.credit;$('run').textContent=c.actions[0].label;for(const [key,value] of Object.entries(c.theme??{}))document.documentElement.style.setProperty('--'+key,value);controls(c);for(const a of c.actions.slice(1)){const b=text('button',a.label);b.type='button';b.setAttribute('aria-label',a.label);b.title=a.description??a.label;b.addEventListener('click',()=>run(a.id));$('extra-actions').append(b);}const module=await import(`/domain.mjs?attempt=${moduleAttempts++}`);$('stage').replaceChildren();domain=module.mount($('stage'),{getParameters:()=>parameters,setParameter,announce,artifactURL,signal:abort.signal,run:()=>run(c.actions[0].id)});}
    state=next;
    if(changed&&dirty){$('remote').hidden=false;}else if(changed){parameters={...state.project.parameters};draftRevision=state.revision;controls(state.config);$('remote').hidden=true;}
    $('reset').disabled=false;$('connection').textContent='Workspace connected';$('app').setAttribute('aria-busy','false');
    $('dirty').textContent=dirty?'UNSAVED':'SAVED';
    const running=state.job?.status==='running';$('run').disabled=running||pending;for(const b of $('extra-actions').children)b.disabled=running||pending;
    $('job-details').hidden=!state.job;$('log').textContent=state.job?.log??'';
    const jobStamp=state.job?`${state.job.startedAt}:${state.job.status}`:'';
    if(state.job?.status==='failed'&&jobStamp!==lastJob)notice(state.job.message,true);
    else if(running){notice(state.job.message);if(!$('cancel')){const b=text('button','Stop run');b.id='cancel';b.addEventListener('click',async()=>{try{await api('/api/cancel',{});await refresh();}catch(e){notice(e.message,true);}});$('notice').append(' ',b);}}
    else if(state.job?.status==='cancelled'&&jobStamp!==lastJob)notice(state.job.message);
    else if(state.job?.status==='done'&&jobStamp!==lastJob)notice('');
    lastJob=jobStamp;
    const stamp=state.result?.id??'';
    if(stamp!==lastResult||changed||!lastResult){lastResult=stamp;renderResult(selected??state.result);renderHistory();}
  }catch(e){if(!domain){state=null;$('extra-actions').replaceChildren();}$('connection').textContent='Reconnecting';notice(e.message,true);}finally{refreshing=false;}
}
$('run').addEventListener('click',()=>run(state.config.actions[0].id));
$('controls').addEventListener('submit',e=>e.preventDefault());
$('reset').addEventListener('click',()=>{for(const c of state.config.controls)setParameter(c.id,c.value);notice('Controls reset. Run to save a new exploration.');});
$('refresh').addEventListener('click',()=>{parameters={...state.project.parameters};draftRevision=state.revision;dirty=false;controls(state.config);$('remote').hidden=true;$('dirty').textContent='SAVED';domain.update(parameters,selected??state.result,motion);});
$('latest').addEventListener('click',()=>{selected=null;$('latest').hidden=true;renderResult(state.result);renderHistory();});
$('motion').addEventListener('click',()=>{motion=!motion;setMotion();});
function setMotion(){$('motion').setAttribute('aria-pressed',String(motion));$('motion').textContent=motion?'Pause motion':'Resume motion';domain?.update(parameters,selected??state?.result,motion);}
setMotion();await refresh();const poll=setInterval(refresh,1200);
window.addEventListener('pagehide',()=>{clearInterval(poll);abort.abort();domain?.destroy?.();},{once:true});
