import json
from pathlib import Path
import statistics
import xml.etree.ElementTree as ET
from studio_runtime import execute, metric, command, package


def binary(name):
    conda=package()/'.sumo/bin'/name
    return conda if conda.exists() else package()/'.venv/bin'/name


def simulate(p,out):
    points={'W':(0,200),'E':(400,200),'N':(200,400),'S':(200,0),'C':(200,200)}
    nodes=ET.Element('nodes')
    for id,(x,y) in points.items():ET.SubElement(nodes,'node',id=id,x=str(x),y=str(y),type='traffic_light' if id=='C' else 'priority')
    edges=ET.Element('edges')
    for id in ['W','E','N','S']:
        ET.SubElement(edges,'edge',id=id+'C',**{'from':id,'to':'C','numLanes':'1','speed':'13.9'})
        ET.SubElement(edges,'edge',id='C'+id,**{'from':'C','to':id,'numLanes':'1','speed':'13.9'})
    ET.ElementTree(nodes).write(out/'nodes.xml');ET.ElementTree(edges).write(out/'edges.xml')
    print('Building the intersection…',flush=True)
    command([binary('netconvert'),'--node-files',out/'nodes.xml','--edge-files',out/'edges.xml','--output-file',out/'city.net.xml','--no-turnarounds','true'],timeout=60)
    network=ET.parse(out/'city.net.xml');logic=network.find('.//tlLogic')
    if logic is None:raise RuntimeError('SUMO did not generate the traffic light.')
    phases=logic.findall('phase')
    # Detect which generated phase serves west/east straight connections instead of relying on link indices.
    eastwest=[int(c.attrib['linkIndex']) for c in network.findall('connection') if c.get('tl')=='C' and c.get('from') in ['WC','EC'] and c.get('dir')=='s']
    for phase in phases:
        s=phase.get('state','')
        if 'y' in s.lower():phase.set('duration','3')
        elif any(i<len(s) and s[i] in 'Gg' for i in eastwest):phase.set('duration',str(p['green']))
        else:phase.set('duration',str(80-p['green']))
    network.write(out/'city.net.xml')
    routes=ET.Element('routes');ET.SubElement(routes,'vType',id='car',accel='2.6',decel='4.5',sigma='.3',length='4.5',minGap='2.5',maxSpeed='13.9')
    for direction,opposite in [('W','E'),('E','W'),('N','S'),('S','N')]:
        ET.SubElement(routes,'route',id=direction,edges=f'{direction}C C{opposite}')
        ET.SubElement(routes,'flow',id=direction,type='car',route=direction,begin='0',end=str(p['duration']-30),vehsPerHour=str(p['demand']),departLane='best',departSpeed='max')
    ET.ElementTree(routes).write(out/'routes.xml')
    print('Simulating the rush…',flush=True)
    log=command([binary('sumo'),'-n',out/'city.net.xml','-r',out/'routes.xml','--begin','0','--end',str(p['duration']),'--seed',str(p['seed']),'--step-length','.5','--fcd-output',out/'traffic.xml','--tripinfo-output',out/'trips.xml','--tripinfo-output.write-unfinished','true','--no-step-log','true','--duration-log.disable','true'],timeout=90)
    (out/'sumo.log').write_text(log or 'SUMO completed successfully.\n')
    trips=ET.parse(out/'trips.xml').getroot().findall('tripinfo')
    completed=[v for v in trips if float(v.get('arrival','-1'))>=0]
    if not completed:raise RuntimeError('No trips finished. Increase the sample duration or reduce traffic demand.')
    frames=[];max_queue=0
    for t in ET.parse(out/'traffic.xml').getroot().findall('timestep'):
        cars=[{'id':v.get('id'),'x':round(float(v.get('x')),2),'y':round(float(v.get('y')),2),'speed':round(float(v.get('speed')),2),'angle':float(v.get('angle'))} for v in t]
        max_queue=max(max_queue,sum(v['speed']<.1 for v in cars))
        if round(float(t.get('time'))*2)%4==0:frames.append({'time':float(t.get('time')),'cars':cars})
    summary={'frames':frames,'extent':400,'phases':[dict(x.attrib) for x in phases],'finished':len(completed),'unfinished':len(trips)-len(completed),'maxQueue':max_queue}
    (out/'playback.json').write_text(json.dumps(summary))
    avg=statistics.mean(float(t.get('timeLoss')) for t in completed)
    (out/'trips.csv').write_text('id,duration,time_loss,waiting_time,finished\n'+'\n'.join(f'{t.get("id")},{t.get("duration")},{t.get("timeLoss")},{t.get("waitingTime")},{float(t.get("arrival","-1"))>=0}' for t in trips)+'\n')
    version=command([binary('sumo'),'--version'],timeout=15).splitlines()[0]
    return {'title':f'Rush hour · {len(completed)} trips completed','description':f'{len(trips)-len(completed)} vehicles were still travelling at the end. Trip delay is measured for completed trips; compare identical demand, duration and seed.','engine':version,'metrics':[metric('Mean trip delay',round(avg,1),'s'),metric('Finished trips',len(completed)),metric('Largest stopped queue',max_queue,'cars')],'data':summary,'files':[{'label':'Trip measurements','name':'trips.csv'},{'label':'SUMO network','name':'city.net.xml'},{'label':'Playback data','name':'playback.json'},{'label':'Raw vehicle traces','name':'traffic.xml'}]}


if __name__=='__main__':execute({'simulate':simulate})
