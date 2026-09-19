import {canvas,round,line,circle,words,toolbar,badge,label,el} from '/graphics.mjs';
export function mount(stage,api){
  let p=api.getParameters(),result,index=0,playing=true,rate=8,now=0,start=0,last='',follow=false,followId=null,bounds;
  label(stage,'Every little journey has somewhere to be.');const tag=badge(stage,'TRAFFIC REPLAY');
  const screen=canvas(stage,(ctx,w,h,t)=>{
    now=t;const size=Math.min(w-50,h-170),left=(w-size)/2,top=70,s=size/400;bounds={left,top,s};const map=(x,y)=>[left+x*s,top+(400-y)*s];
    const frames=result?.data?.frames;if(frames?.length&&playing)index=Math.floor(((t-start)*rate/2)%frames.length);const frame=frames?.[index];
    const tracked=follow&&(frame?.cars.find(car=>car.id===followId)??frame?.cars[0]);if(tracked)followId=tracked.id;
    ctx.save();ctx.beginPath();ctx.rect(0,58,w,h-128);ctx.clip();if(tracked){const [x,y]=map(tracked.x,tracked.y);ctx.translate(w/2,top+size/2);ctx.scale(2.6,2.6);ctx.translate(-x,-y);}
    round(ctx,left,top,size,size,14,'#2e4230');
    const mid=left+size/2,cy=top+size/2,road=28;
    ctx.fillStyle='#b9bfaa';ctx.fillRect(left,cy-road/2-4,size,road+8);ctx.fillRect(mid-road/2-4,top,road+8,size);
    ctx.fillStyle='#39433c';ctx.fillRect(left,cy-road/2,size,road);ctx.fillRect(mid-road/2,top,road,size);
    for(let i=0;i<4;i++){const x=left+(i%2?size*.67:size*.13),y=top+(i>1?size*.67:size*.13);round(ctx,x+3,y+5,size*.19,size*.16,4,'#11271955');round(ctx,x,y,size*.19,size*.16,4,['#acb68d','#7d9475','#889780','#b4ae8c'][i]);line(ctx,[[x+5,y+6],[x+size*.19-5,y+6]],'#e5e6c333',1);circle(ctx,x+size*.1,y+size*.23,9,'#698952');circle(ctx,x+size*.16,y+size*.23,7,'#76975b');}
    ctx.setLineDash([6,8]);line(ctx,[[left,cy],[mid-22,cy]],'#b6c3a04d',1);line(ctx,[[mid+22,cy],[left+size,cy]],'#b6c3a04d',1);line(ctx,[[mid,top],[mid,cy-22]],'#b6c3a04d',1);line(ctx,[[mid,cy+22],[mid,top+size]],'#b6c3a04d',1);ctx.setLineDash([]);
    if(frames?.length){scrub.value=index;tag.textContent=`SUMO · ${frame.time.toFixed(0)} S`;
      frame.cars.forEach((car,i)=>{const [x,y]=map(car.x,car.y);ctx.save();ctx.translate(x,y);ctx.rotate(car.angle*Math.PI/180);round(ctx,-1,-2.5,2,5,1,car.speed<.1?'#e79c75':'#d5e9a2');ctx.restore();if(tracked&&car.id===tracked.id){circle(ctx,x,y,10,'#e5f8bd25');words(ctx,car.id,x+11,y-7,'#e5f8bd',9);}});
      ctx.restore();
      if(w>570){round(ctx,15,48,150,90,9,'#182c23df');words(ctx,'CITY CLOCK',24,69,'#a7c292',9);words(ctx,`${frame.time.toFixed(0)} s`,24,98,'#e1edc5',23);words(ctx,`${frame.cars.length} moving stories`,24,122,'#9cb78b',10);}
    }else{ctx.restore();words(ctx,'Run the city to record its traffic.',left,top+size/2,'#d5e9a2',11);}
    words(ctx,`${result?.parameters.green??p.green}s RECORDED EAST–WEST GREEN`,left,top+size+20,'#9cb78b',9);
  },api.signal);screen.element.setAttribute('aria-label','SUMO traffic replay on a four-way city intersection');
  const bar=toolbar(stage,[['Pause traffic',b=>{playing=!playing;if(playing)start=now-index*2/rate;b.textContent=playing?'Pause traffic':'Play traffic';b.setAttribute('aria-pressed',String(playing));}],['8× speed',b=>{rate=rate===8?16:rate===16?1:8;start=now-index*2/rate;b.textContent=`${rate}× speed`;}],['Follow a car',b=>{follow=!follow;b.textContent=follow?'See the city':'Follow a car';b.setAttribute('aria-pressed',String(follow));}]]);
  const scrub=el('input');scrub.type='range';scrub.min=0;scrub.max=1;scrub.value=0;scrub.style.width='95px';scrub.setAttribute('aria-label','Traffic replay position');scrub.addEventListener('input',()=>{playing=false;index=Number(scrub.value);bar.firstChild.textContent='Play traffic';});bar.append(scrub);
  return {update(params,r,motion){p=params;result=r;screen.motion(motion);if(r?.data?.frames&&r.id!==last){last=r.id;start=now;index=0;followId=null;scrub.max=r.data.frames.length-1;}}};
}
