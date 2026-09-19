import {canvas,grid,line,words,circle,toolbar,badge,label,el,tone} from '/graphics.mjs';
export function mount(stage,api){
  let p=api.getParameters(),result,playing=false,recording=new Audio(),keyIndex=-1;
  label(stage,'A small instrument, waiting for your hands.');const tag=badge(stage,'LIVE AUDITION');
  const screen=canvas(stage,(ctx,w,h,t)=>{
    grid(ctx,w,h,36);const center=h*.33,amplitude=h*.15;
    const points=[];for(let x=20;x<w-20;x+=2){const a=x/w*7*Math.PI*2-t*2;let v=Math.sin(a);if(p.wave==='triangle')v=Math.asin(Math.sin(a))*2/Math.PI;if(p.wave==='saw')v=2*((a/(2*Math.PI))%1)-1;points.push([x,center+v*amplitude*p.brightness]);}
    ctx.shadowBlur=20;ctx.shadowColor='#e6ac7550';line(ctx,points,'#f2bc88',2);ctx.shadowBlur=0;
    line(ctx,[[20,center],[w-20,center]],'#ffffff0a',1);if(w>500)words(ctx,`${p.frequency} Hz`,25,center+amplitude+24,'#ac998c',10);
    if(keyIndex>=0)circle(ctx,w-35,center+amplitude+20,4,'#f2bc88');
    if(result?.data?.waveform){const wave=result.data.waveform;line(ctx,wave.map((v,i)=>[24+i/(wave.length-1)*(w-48),h-20-v*12]),'#bf9875',1);}
  },api.signal);screen.element.setAttribute('aria-label','Oscillator waveform preview');
  const keyboard=el('div','','keyboard'),keys=['C','D','E','F','G','A','B','C'],offset=[0,2,4,5,7,9,11,12];
  async function play(i){keyIndex=i;try{await tone(p.frequency*2**(offset[i]/12),.45,p.wave==='saw'?'sawtooth':p.wave,.12);api.announce(`Playing ${keys[i]}`);}catch{api.announce('Audio is unavailable in this browser. Download the recording to listen.');}setTimeout(()=>{keyIndex=-1;},450);}
  keys.forEach((name,i)=>{const b=el('button',`${name} · ${'ASDFGHJK'[i]}`,'key');b.type='button';b.setAttribute('aria-label',`Play ${name}${i===7?' high':''}`);b.addEventListener('click',()=>play(i));keyboard.append(b);});stage.append(keyboard);
  window.addEventListener('keydown',e=>{if(e.repeat||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;const i='asdfghjk'.indexOf(e.key.toLowerCase());if(i>=0&&e.key.length===1){e.preventDefault();play(i);}},{signal:api.signal});
  const bar=toolbar(stage,[['Play recording',async b=>{const artifact=result?.artifacts?.find(a=>a.path.endsWith('.wav'));if(!artifact){api.announce('Record a phrase first.');return;}if(playing){recording.pause();recording.currentTime=0;playing=false;b.textContent='Play recording';}else{recording.src=api.artifactURL(artifact.path);try{await recording.play();playing=true;b.textContent='Stop recording';}catch{api.announce('Audio could not play. Download the WAV to listen.');}}}],['Surprise me',()=>{api.setParameter('frequency',[165,220,277,330,440][Math.floor(Math.random()*5)]);api.setParameter('wave',['sine','triangle','saw'][Math.floor(Math.random()*3)]);}]]);
  recording.addEventListener('ended',()=>{playing=false;bar.firstChild.textContent='Play recording';});
  api.signal.addEventListener('abort',()=>recording.pause());
  return {update(params,r,motion){p=params;result=r;screen.motion(motion);tag.textContent=r?.engine?.startsWith('Native')?'JUCE RECORDING':'LIVE AUDITION';}};
}
