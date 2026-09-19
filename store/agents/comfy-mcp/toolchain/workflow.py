import hashlib
import json
import math
import os
from pathlib import Path
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from studio_runtime import execute, metric, workspace, contained

PALETTES={'orchard':['#ecefdc','#47764e','#b8cf79','#d6a877','#253e31'],
          'dusk':['#e8e2f0','#7163a7','#afa9d8','#dba8ae','#302741'],
          'citrus':['#faead4','#cf6e51','#f1c579','#e6a79a','#623d36']}


def artwork(p,seed):
    rng=random.Random(seed);palette=PALETTES[p['palette']]
    parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640"><rect width="640" height="640" fill="{palette[0]}"/>',
           '<defs><filter id="shadow"><feGaussianBlur stdDeviation="9"/></filter></defs>',
           f'<ellipse cx="326" cy="490" rx="128" ry="22" fill="{palette[4]}" opacity=".12" filter="url(#shadow)"/>']
    center=(320+rng.uniform(-25,25),310+rng.uniform(-20,20))
    for ring in [1,.62]:
        for i in range(p['complexity']):
            angle=i*360/p['complexity']+rng.uniform(-10,10);x=center[0]+math.cos(math.radians(angle))*85*ring;y=center[1]+math.sin(math.radians(angle))*85*ring
            color=palette[1+(i+seed)%3]
            parts.append(f'<ellipse cx="{x:.2f}" cy="{y:.2f}" rx="{75*ring:.2f}" ry="{132*ring:.2f}" transform="rotate({angle+90:.2f} {x:.2f} {y:.2f})" fill="{color}" opacity=".83"/>')
    parts.append(f'<circle cx="{center[0]:.2f}" cy="{center[1]:.2f}" r="39" fill="{palette[4]}"/>')
    for i in range(65):
        angle=rng.random()*math.tau;distance=rng.random()**.5*32
        parts.append(f'<circle cx="{center[0]+math.cos(angle)*distance:.2f}" cy="{center[1]+math.sin(angle)*distance:.2f}" r="{rng.uniform(.5,1.8):.2f}" fill="{palette[0]}" opacity=".55"/>')
    parts.extend([f'<path d="M320 451 Q335 504 308 545" stroke="{palette[1]}" fill="none" stroke-width="3"/>',
                  f'<path d="M320 501 Q359 477 372 503 Q337 524 320 501" fill="{palette[2]}"/>',
                  f'<text x="35" y="42" font-family="sans-serif" font-size="10" letter-spacing="3" fill="{palette[4]}">VARIATION GARDEN</text>',
                  f'<text x="35" y="602" font-family="sans-serif" font-size="12" fill="{palette[4]}">STUDY {seed:04d}</text>',
                  f'<text x="488" y="602" font-family="sans-serif" font-size="10" fill="{palette[4]}">{p["palette"].upper()}</text></svg>'])
    return ''.join(parts)


def generate(p,out):
    images=[];files=[]
    for i in range(p['variations']):
        seed=p['seed']+i;name=f'study-{seed}.svg';content=artwork(p,seed);(out/name).write_text(content)
        images.append({'seed':seed,'name':name,'sha256':hashlib.sha256(content.encode()).hexdigest()})
        files.append({'label':f'Study {seed} · SVG','name':name})
    (out/'recipe.json').write_text(json.dumps({'engine':'Original procedural SVG generator','parameters':p,'images':images},indent=2))
    files.append({'label':'Reproduction recipe','name':'recipe.json'})
    return {'title':f'{p["palette"].capitalize()} · {len(images)} new possibilities','description':'Original procedural vector studies, each with a reproducible seed. These are local generative graphics; no diffusion model or paid service was used.','engine':'Local procedural SVG · deterministic seeds','metrics':[metric('Variations',len(images)),metric('First seed',p['seed']),metric('Canvas',640,'× 640')],'data':{'images':images},'files':files}


def comfy(p,out):
    base=os.environ.get('COMFYUI_URL','http://127.0.0.1:8188').rstrip('/')
    url=urllib.parse.urlparse(base)
    if url.scheme!='http' or url.hostname not in ('127.0.0.1','localhost','::1') or url.username or url.password or url.path or url.query or url.fragment:
        raise ValueError('This local studio expects COMFYUI_URL to be a loopback HTTP address.')
    path=contained(workspace()/'workflow.json')
    if path.stat().st_size>1_000_000:raise ValueError('workflow.json is too large')
    workflow=json.loads(path.read_text())
    if not isinstance(workflow,dict) or not workflow or any(not isinstance(v,dict) or not isinstance(v.get('class_type'),str) for v in workflow.values()):
        raise ValueError('Save an API-format ComfyUI workflow in workflow.json.')
    class LocalOnly(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise urllib.error.URLError('Local ComfyUI requests cannot follow redirects.')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),LocalOnly())
    def request(endpoint,data=None):
        req=urllib.request.Request(base+endpoint,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
        try:
            with opener.open(req,timeout=5) as response:
                return json.loads(response.read(2_000_000))
        except urllib.error.URLError as exc:
            raise RuntimeError('Start local ComfyUI on port 8188, then run again. '+str(exc)) from exc
    response=request('/prompt',{'prompt':workflow,'client_id':'harness-studio'})
    if response.get('node_errors') or not response.get('prompt_id'):
        raise RuntimeError('ComfyUI rejected the workflow: '+json.dumps(response.get('node_errors',response))[:800])
    prompt_id=response['prompt_id'];deadline=time.monotonic()+float(os.environ.get('STUDIO_COMFY_TIMEOUT','90'));job=None
    print('ComfyUI accepted the workflow. Waiting for its outputs…',flush=True)
    while time.monotonic()<deadline:
        history=request('/history/'+urllib.parse.quote(prompt_id,safe=''))
        job=history.get(prompt_id)
        if job:
            if job.get('status',{}).get('status_str')=='error':raise RuntimeError('ComfyUI execution failed: '+json.dumps(job['status'])[:800])
            if job.get('outputs'):break
        time.sleep(.5)
    else:raise RuntimeError('ComfyUI did not finish before the local time limit. Check its queue; the remote job may still be running.')
    images=[];files=[]
    for output in job['outputs'].values():
        for asset in output.get('images',[]):
            query=urllib.parse.urlencode({k:asset[k] for k in ['filename','subfolder','type'] if k in asset})
            with opener.open(base+'/view?'+query,timeout=10) as response:
                content=response.read(32*1024*1024+1)
            if len(content)>32*1024*1024:raise RuntimeError('A ComfyUI image exceeded the local download limit.')
            if not content.startswith(b'\x89PNG\r\n\x1a\n'):raise RuntimeError('This image workflow must produce PNG outputs.')
            name=f'comfy-{len(images)+1}.png';(out/name).write_bytes(content);images.append({'seed':None,'name':name});files.append({'label':f'ComfyUI image {len(images)}','name':name})
    if not images:raise RuntimeError('The workflow produced no images. Use SaveImage in workflow.json.')
    (out/'comfy-history.json').write_text(json.dumps(job,indent=2));files.append({'label':'ComfyUI run record','name':'comfy-history.json'})
    return {'title':f'ComfyUI · {len(images)} image outputs','description':'These images were returned by the saved workflow running on local ComfyUI. Model and node requirements belong to that workflow.','engine':'Native ComfyUI · local workflow','metrics':[metric('Images',len(images))],'data':{'images':images,'promptId':prompt_id},'files':files}


if __name__=='__main__':execute({'generate':generate,'comfy':comfy})
