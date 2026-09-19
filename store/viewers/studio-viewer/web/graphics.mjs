export function el(tag, text, className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
export function toolbar(stage, buttons){const bar=el('div','','domain-toolbar');for(const [label,click] of buttons){const b=el('button',label);b.type='button';b.addEventListener('click',()=>click(b));bar.append(b);}stage.append(bar);return bar;}
export function badge(stage,text){const n=el('span',text,'domain-badge');stage.append(n);return n;}
export function label(stage,text){const n=el('div',text,'domain-label');stage.append(n);return n;}
export function canvas(stage, draw, signal){
  const c=el('canvas');c.setAttribute('role','img');stage.append(c);const ctx=c.getContext('2d');let animate=true,raf,frame=0,previous=null;
  const paint=t=>{const box=c.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);if(c.width!==Math.round(box.width*dpr)||c.height!==Math.round(box.height*dpr)){c.width=Math.round(box.width*dpr);c.height=Math.round(box.height*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,box.width,box.height);const elapsed=previous===null?0:(t-previous)/1000;previous=t;if(animate&&!document.hidden)frame+=Math.min(elapsed,.1);draw(ctx,box.width,box.height,frame);raf=requestAnimationFrame(paint);};raf=requestAnimationFrame(paint);signal.addEventListener('abort',()=>cancelAnimationFrame(raf));return {element:c,motion:value=>{animate=value;}};
}
export function grid(ctx,w,h,spacing=32){ctx.strokeStyle='#ffffff0a';ctx.lineWidth=1;for(let x=0;x<w;x+=spacing){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}for(let y=0;y<h;y+=spacing){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}}
export function round(ctx,x,y,w,h,r,fill,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.stroke();}}
export function line(ctx,points,color,width=2){ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();}
export function circle(ctx,x,y,r,color){ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}
export function words(ctx,text,x,y,color='#c5d7c2',size=11){ctx.fillStyle=color;ctx.font=`${size}px -apple-system, sans-serif`;ctx.fillText(text,x,y);}
let audio;
export async function tone(frequency,seconds=.3,type='sine',gain=.12){
  audio??=new AudioContext();await audio.resume();const osc=audio.createOscillator(),amp=audio.createGain();osc.type=type;osc.frequency.value=frequency;osc.connect(amp);amp.connect(audio.destination);const now=audio.currentTime;amp.gain.setValueAtTime(0,now);amp.gain.linearRampToValueAtTime(gain,now+.02);amp.gain.exponentialRampToValueAtTime(.001,now+seconds);osc.start();osc.stop(now+seconds+.02);
}
