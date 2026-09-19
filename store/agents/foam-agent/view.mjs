import {canvas,grid,line,words,circle,toolbar,badge,label} from '/graphics.mjs';
export function mount(stage,api){
  let p=api.getParameters(),field,pressure=false,arrows=false,tracers=[],lastT=0,bounds;
  const info=label(stage,'An invitation to follow the flow.'),tag=badge(stage,'FLOW SKETCH');
  const screen=canvas(stage,(ctx,w,h,t)=>{
    grid(ctx,w,h,32);const scaleX=Math.min((w-48)/120,(h-(w<500?180:155))/56),scaleY=scaleX,left=(w-120*scaleX)/2,top=65,fh=56*scaleY;bounds={left,top,scaleX};
    const speed=p.speed/100,cx=left+36*scaleX,cy=top+28*scaleY;
    if(field){
      for(let row=0;row<field.ux.length;row++)for(let col=0;col<field.ux[row].length;col++){
        if(field.solid[row][col])continue;
        const magnitude=Math.hypot(field.ux[row][col],field.uy[row][col]);
        const v=pressure?Math.max(0,Math.min(1,.5+(field.pressure[row][col]-1/3)*20)):Math.min(1,magnitude/.13);
        ctx.fillStyle=`hsla(${205-v*150},60%,${25+v*30}%,${.06+v*.3})`;ctx.fillRect(left+col*2*scaleX,top+row*2*scaleY,2*scaleX+1,2*scaleY+1);
        if(arrows&&col%4===0&&row%4===0){const x=left+col*2*scaleX,y=top+row*2*scaleY;line(ctx,[[x,y],[x+field.ux[row][col]*90,y+field.uy[row][col]*90]],'#d0eeec66',1);}
      }
    }
    if(!field)for(let row=0;row<19;row++){
      const y0=top+row/18*fh,points=[];
      for(let x=left;x<left+120*scaleX;x+=4){const near=Math.exp(-(((x-cx)/(30*scaleX))**2)),dy=(y0-cy),spread=Math.sign(dy)*p.radius*scaleY*Math.exp(-((dy/(p.radius*scaleY*2))**2))*near;points.push([x,y0+spread]);}
      line(ctx,points,'#b3e5e42f',.8);
      if(!field){const x=left+((t*p.speed*22+row*53)%(120*scaleX)),near=Math.exp(-(((x-cx)/(30*scaleX))**2)),dy=y0-cy;circle(ctx,x,y0+Math.sign(dy)*p.radius*scaleY*Math.exp(-((dy/(p.radius*scaleY*2))**2))*near,1.4,'#a1dadba0');}
    }
    ctx.fillStyle='#cedad4';ctx.strokeStyle='#f0faf0';ctx.lineWidth=2;ctx.beginPath();
    if(p.shape==='square')ctx.rect(cx-p.radius*scaleX,cy-p.radius*scaleY,p.radius*2*scaleX,p.radius*2*scaleY);
    else ctx.ellipse(cx,cy,p.radius*scaleX*(p.shape==='ellipse'?1.8:1),p.radius*scaleY*(p.shape==='ellipse'?.55:1),0,0,Math.PI*2);
    ctx.fill();ctx.stroke();
    const dt=Math.min(.05,Math.max(0,t-lastT));lastT=t;
    if(field&&tracers.length<80&&dt>0)tracers.push({x:1,y:2+Math.random()*52});
    for(const dot of tracers){let ux=speed,uy=0;if(field){const row=Math.max(0,Math.min(field.ux.length-1,Math.floor(dot.y/2))),col=Math.max(0,Math.min(field.ux[0].length-1,Math.floor(dot.x/2)));ux=field.ux[row][col];uy=field.uy[row][col];}dot.x+=ux*dt*120;dot.y+=uy*dt*120;circle(ctx,left+dot.x*scaleX,top+dot.y*scaleY,1.8,'#c6fbf3');}
    tracers=tracers.filter(dot=>dot.x<120&&dot.y>0&&dot.y<56);
    words(ctx,pressure?'PRESSURE':'VELOCITY',left,top+fh+17,'#99b9bf',9);words(ctx,field?'Measured field':'Illustrative field',left+120*scaleX-105,top+fh+17,'#99b9bf',9);
  },api.signal);
  screen.element.setAttribute('aria-label','Interactive flow field; click to release a tracer');screen.element.tabIndex=0;
  screen.element.addEventListener('click',e=>{const b=screen.element.getBoundingClientRect();tracers.push({x:(e.clientX-b.left-bounds.left)/bounds.scaleX,y:(e.clientY-b.top-bounds.top)/bounds.scaleX});api.announce('Tracer released.');});
  screen.element.addEventListener('keydown',e=>{if(e.key==='Enter'){tracers.push({x:1,y:20});api.announce('Tracer released.');}});
  toolbar(stage,[['Show pressure',b=>{pressure=!pressure;b.textContent=pressure?'Show velocity':'Show pressure';b.setAttribute('aria-pressed',String(pressure));}],['Show vectors',b=>{arrows=!arrows;b.textContent=arrows?'Hide vectors':'Show vectors';b.setAttribute('aria-pressed',String(arrows));}],['Release tracers',()=>{for(let i=0;i<15;i++)tracers.push({x:1,y:3+i*3.3});api.announce('Fifteen tracers released.');}]]);
  return {update(params,result,motion){p=params;field=result?.data?.ux&&Object.keys(p).every(k=>p[k]===result.parameters[k])?result.data:null;tag.textContent=field?'SIMULATION REPLAY':'FLOW SKETCH';info.textContent=field?'Particles follow your measured velocity field.':'Adjust the body, then run to calculate the flow.';screen.motion(motion);}};
}
