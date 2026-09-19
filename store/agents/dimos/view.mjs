import {canvas,round,line,circle,words,toolbar,badge,label,el} from '/graphics.mjs';
const layouts={office:[[4,3,2,3],[7,5,2,1],[2.5,7,2,1]],gallery:[[3,3,1.4,1.4],[6,3,1.4,1.4],[4.5,6,1.4,1.4],[7.5,7.5,1.4,1.4]]};
export function mount(stage,api){
  let p=api.getParameters(),result,showPath=true,replay=true,index=0,now=0,start=0,last='',bounds;
  const info=label(stage,'Choose somewhere worth exploring.'),tag=badge(stage,'SIMULATION ONLY');
  const screen=canvas(stage,(ctx,w,h,t)=>{
    now=t;const size=Math.min(h-145,w-70),left=(w-size)/2,top=70,s=size/10;bounds={left,top,s};const map=(x,y)=>[left+x*s,top+(10-y)*s];
    round(ctx,left,top,size,size,12,'#24372b','#ffffff20');
    for(let i=1;i<10;i++){line(ctx,[[left+i*s,top],[left+i*s,top+size]],'#ffffff0b',1);line(ctx,[[left,top+i*s],[left+size,top+i*s]],'#ffffff0b',1);}
    const blocks=layouts[p.layout];for(const [x,y,bw,bh] of blocks){const [px,py]=map(x-bw/2,y+bh/2);round(ctx,px+4,py+5,bw*s,bh*s,5,'#0a1e1644');round(ctx,px,py,bw*s,bh*s,5,'#66795d','#8da17a');line(ctx,[[px+5,py+7],[px+bw*s-5,py+7]],'#b0c49b55',1);}
    const compatible=result?.data?.positions&&result.parameters.layout===p.layout;
    if(showPath&&compatible)line(ctx,result.data.route.map(pt=>map(...pt)),'#bcdf8d55',3);
    const goal=map(p.goal_x,p.goal_y);circle(ctx,...goal,12+Math.sin(t*2)*2,'#bcdf8d17');circle(ctx,...goal,6,'#c2e98b');words(ctx,'GOAL',goal[0]+11,goal[1]+4,'#d9edbb',9);
    let position=[1,1];
    if(compatible){if(replay)index=Math.min(result.data.positions.length-1,Math.floor(((t-start)*30)%result.data.positions.length));const frame=result.data.positions[index];position=[frame[1],frame[2]];scrub.value=index;}
    const robot=map(...position);circle(ctx,...robot,17,'#bae38912');circle(ctx,...robot,9,'#e5edcc');circle(ctx,robot[0]+3,robot[1]-3,2,'#364d35');
    if(w>550){words(ctx,'ROVER 01',24,70,'#a7c292',10);words(ctx,compatible?`${result.data.positions[index][0].toFixed(1)} s`:'READY',24,98,'#dceac7',20);words(ctx,compatible?'Recorded trajectory':'Choose a destination',24,121,'#8da684',9);}

  },api.signal);screen.element.setAttribute('aria-label','Office rover mission map; click to select a goal');screen.element.tabIndex=0;
  screen.element.addEventListener('click',e=>{const b=screen.element.getBoundingClientRect();const x=Math.max(1,Math.min(9,Math.round((e.clientX-b.left-bounds.left)/bounds.s*2)/2)),y=Math.max(1,Math.min(9,Math.round((10-(e.clientY-b.top-bounds.top)/bounds.s)*2)/2));api.setParameter('goal_x',x);api.setParameter('goal_y',y);api.announce(`Destination ${x} east, ${y} north`);});
  screen.element.addEventListener('keydown',e=>{const axes={ArrowLeft:['goal_x',-.5],ArrowRight:['goal_x',.5],ArrowUp:['goal_y',.5],ArrowDown:['goal_y',-.5]};if(axes[e.key]){const [key,delta]=axes[e.key];api.setParameter(key,Math.max(1,Math.min(9,p[key]+delta)));e.preventDefault();}});
  const bar=toolbar(stage,[['Replay mission',()=>{start=now;replay=true;}],['Hide route',b=>{showPath=!showPath;b.textContent=showPath?'Hide route':'Show route';b.setAttribute('aria-pressed',String(showPath));}]]);
  const scrub=el('input');scrub.type='range';scrub.min=0;scrub.max=1;scrub.value=0;scrub.setAttribute('aria-label','Mission replay position');scrub.style.width='100px';scrub.addEventListener('input',()=>{replay=false;index=Number(scrub.value);});bar.append(scrub);
  return {update(params,r,motion){p=params;result=r;screen.motion(motion);if(r?.data?.positions&&r.id!==last){last=r.id;start=now;index=0;scrub.max=r.data.positions.length-1;}const same=r?.data?.positions&&Object.keys(p).every(k=>p[k]===r.parameters[k]);tag.textContent=same?'RECORDED MISSION':'DESTINATION PREVIEW';info.textContent=same?'Replay the route your simulated rover actually travelled.':'Click open floor, then send the rover.';}};
}
