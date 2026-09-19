import {canvas,grid,line,circle,words,toolbar,badge,label} from '/graphics.mjs';
export function mount(stage,api){
  let result,hover=-1,showHoldout=true,p=api.getParameters();
  const info=label(stage,'The interesting part is what actually happened.'),tag=badge(stage,'CPU EXPERIMENT');
  const screen=canvas(stage,(ctx,w,h)=>{
    const left=58,right=w-28,top=w<500?80:60,bottom=h-115,curve=result?.data?.curve;
    if(!curve){grid(ctx,w,h);words(ctx,'An experiment is a question you can measure.',30,h/2,'#b2d8d9',14);return;}
    const values=curve.map(row=>row[1]),held=result.data.heldoutBpc,low=Math.min(...values,held)-.2,high=Math.max(...values,held)+.2,maxStep=curve.at(-1)[0];
    const x=step=>left+step/maxStep*(right-left),y=value=>bottom-(value-low)/(high-low)*(bottom-top);
    for(let i=0;i<5;i++){const value=low+(high-low)*i/4;line(ctx,[[left,y(value)],[right,y(value)]],'#ffffff12',1);words(ctx,value.toFixed(1),19,y(value)+4,'#88a7ab',10);}
    words(ctx,'BITS / CHARACTER',18,top-13,'#88a7ab',9);for(let i=0;i<5;i++)words(ctx,String(Math.round(maxStep*i/4)),x(maxStep*i/4)-5,bottom+23,'#88a7ab',10);
    const points=curve.map(row=>[x(row[0]),y(row[1])]);ctx.beginPath();ctx.moveTo(left,bottom);points.forEach(pt=>ctx.lineTo(...pt));ctx.lineTo(right,bottom);ctx.closePath();const gradient=ctx.createLinearGradient(0,top,0,bottom);gradient.addColorStop(0,'#9fe1dc30');gradient.addColorStop(1,'#9fe1dc00');ctx.fillStyle=gradient;ctx.fill();line(ctx,points,'#a0e0da',2.5);
    if(showHoldout){ctx.setLineDash([5,5]);line(ctx,[[left,y(held)],[right,y(held)]],'#dfb986',1);ctx.setLineDash([]);words(ctx,'HELD-OUT · FINAL EVALUATION',left+8,y(held)-8,'#dfb986',9);}
    const i=hover>=0?Math.min(hover,curve.length-1):curve.length-1,pt=points[i];circle(ctx,...pt,5,'#a0e0da');circle(ctx,...pt,10,'#a0e0da25');words(ctx,`Step ${curve[i][0]} · ${curve[i][1].toFixed(3)} bits/char`,left,bottom+43,'#c4e9e5',11);
  },api.signal);screen.element.setAttribute('aria-label','Measured training loss curve and final held-out loss');screen.element.tabIndex=0;
  screen.element.addEventListener('pointermove',e=>{if(!result?.data?.curve)return;const b=screen.element.getBoundingClientRect();hover=Math.max(0,Math.min(result.data.curve.length-1,Math.round((e.clientX-b.left-58)/(b.width-86)*(result.data.curve.length-1))));});
  screen.element.addEventListener('keydown',e=>{if(!result?.data?.curve)return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){hover=Math.max(0,Math.min(result.data.curve.length-1,(hover<0?0:hover)+(e.key==='ArrowRight'?1:-1)));api.announce(`Step ${result.data.curve[hover][0]}, loss ${result.data.curve[hover][1].toFixed(3)}`);e.preventDefault();}});
  toolbar(stage,[['Hide held-out score',b=>{showHoldout=!showHoldout;b.textContent=showHoldout?'Hide held-out score':'Show held-out score';b.setAttribute('aria-pressed',String(showHoldout));}],['Try another seed',()=>api.setParameter('seed',p.seed%99+1)]]);
  return {update(params,r,motion){p=params;result=r;screen.motion(motion);info.textContent=r?.data?.status??'Change one thing. Run. Follow the evidence.';tag.textContent=r?.engine==='Native MLX'?'MLX EXPERIMENT':'CPU EXPERIMENT';}};
}
