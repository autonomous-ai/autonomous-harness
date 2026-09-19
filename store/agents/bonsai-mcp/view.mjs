import {canvas,grid,line,words,toolbar,badge,label,el} from '/graphics.mjs';
function inside(point,poly){let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const [xi,yi]=poly[i],[xj,yj]=poly[j];if((yi>point[1])!==(yj>point[1])&&point[0]<(xj-xi)*(point[1]-yi)/(yj-yi)+xi)hit=!hit;}return hit;}
export function mount(stage,api){
  let p=api.getParameters(),result,angle=-.65,plan=false,explode=false,selected=0,drag=null,hitAreas=[],level=0;
  const info=label(stage,'A place to think, make, and let the light in.'),tag=badge(stage,'IFC SCHEMATIC');
  const screen=canvas(stage,(ctx,w,h)=>{
    grid(ctx,w,h,34);const bw=p.width,bd=p.depth,levels=p.storeys;const scale=Math.min((w-80)/(bw+bd), (h-115)/(bw*.4+bd*.4+(plan?0:levels*p.height*.8+(explode?levels*1.4:0))))*1.2;
    const project=(x,y,z)=>{x-=bw/2;y-=bd/2;if(plan)return [w/2+x*scale,h/2+y*scale];const a=x*Math.cos(angle)-y*Math.sin(angle),b=x*Math.sin(angle)+y*Math.cos(angle);return [w/2+a*scale,h*.64+b*scale*.46-z*scale*.72];};
    const polygon=(points,fill,stroke='#dce7c255')=>{ctx.beginPath();points.forEach((pt,i)=>i?ctx.lineTo(...pt):ctx.moveTo(...pt));ctx.closePath();ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();};
    hitAreas=[];
    for(let floor=0;floor<levels;floor++){
      if(plan&&floor!==level)continue;
      const z=floor*(p.height+.2+(explode?1.8:0));const corners=[[0,0],[bw,0],[bw,bd],[0,bd]];
      polygon(corners.map(([x,y])=>project(x,y,z)),floor===level?'#b4c69b':'#8d9d80');
      for(let room=0;room<2;room++){
        const x0=room?bw*.55+.2:.2,x1=room?bw-.2:bw*.55-.2;const id=floor*2+room;
        const poly=[[x0,.2],[x1,.2],[x1,bd-.2],[x0,bd-.2]].map(([x,y])=>project(x,y,z+.02));polygon(poly,selected===id?'#d6e5ad':'#a5b78d');hitAreas.push({poly,id});
        if(plan){const name=p.use==='studio'?['Studio','Reading room'][room]:['Living room','Bedroom'][room];const pt=project((x0+x1)/2,bd/2,z);words(ctx,name,pt[0]-30,pt[1]-4,'#324832',11);words(ctx,`${((x1-x0)*(bd-.4)).toFixed(1)} m²`,pt[0]-24,pt[1]+14,'#566b45',10);}
      }
      if(!plan){
        for(const [[x0,y0],[x1,y1]] of [[corners[0],corners[1]],[corners[1],corners[2]],[corners[2],corners[3]]])polygon([project(x0,y0,z),project(x1,y1,z),project(x1,y1,z+p.height),project(x0,y0,z+p.height)],'#cdd7ba50');
        polygon([project(1,0,z+.8),project(2.8,0,z+.8),project(2.8,0,z+2.2),project(1,0,z+2.2)],'#8ab3b477','#a7d4cd');
        line(ctx,[project(bw*.55,0,z),project(bw*.55,bd,z)],'#e8f0d1',2);
      }
    }
    const names=p.use==='studio'?['Studio','Reading room']:['Living room','Bedroom'];words(ctx,`${names[selected%2]} · level ${Math.floor(selected/2)+1}`,24,h-70,'#dcebc1',13);

  },api.signal);screen.element.setAttribute('aria-label','Interactive building schematic; drag or use arrow keys to orbit');screen.element.tabIndex=0;
  screen.element.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY};screen.element.setPointerCapture(e.pointerId);});
  screen.element.addEventListener('pointermove',e=>{if(!drag||plan)return;angle+=(e.clientX-drag.x)*.008;drag.x=e.clientX;});
  screen.element.addEventListener('pointerup',e=>{if(drag&&Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)<5){const box=screen.element.getBoundingClientRect(),hit=hitAreas.findLast(h=>inside([e.clientX-box.left,e.clientY-box.top],h.poly));if(hit){selected=hit.id;api.announce(`Room ${selected%2+1}, level ${Math.floor(selected/2)+1}`);}}drag=null;});
  screen.element.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){angle+=e.key==='ArrowRight'?.2:-.2;e.preventDefault();}if(e.key==='Enter'){selected=(selected+1)%(p.storeys*2);api.announce(`Room ${selected%2+1}, level ${Math.floor(selected/2)+1}`);}});
  const bar=toolbar(stage,[['Floor plan',b=>{plan=!plan;b.textContent=plan?'Orbit view':'Floor plan';b.setAttribute('aria-pressed',String(plan));}],['Separate floors',b=>{explode=!explode;b.textContent=explode?'Bring together':'Separate floors';b.setAttribute('aria-pressed',String(explode));}],['Next room',()=>{selected=(selected+1)%(p.storeys*2);level=Math.floor(selected/2);api.announce(`Room ${selected%2+1}, level ${level+1}`);}]]);
  return {update(params,r,motion){p=params;result=r;selected=Math.min(selected,p.storeys*2-1);level=Math.min(level,p.storeys-1);screen.motion(motion);tag.textContent=r?.data?.spaces&&Object.keys(p).every(k=>p[k]===r.parameters[k])?'SAVED IFC MODEL':'DESIGN PREVIEW';}};
}
