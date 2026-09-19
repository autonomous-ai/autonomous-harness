import heapq
import json
import math
import shutil
import xml.etree.ElementTree as ET
import mujoco
import numpy as np
from studio_runtime import execute, metric, command


def obstacles(layout):
    return [[4,3,2,3],[7,5,2,1],[2.5,7,2,1]] if layout=='office' else [[3,3,1.4,1.4],[6,3,1.4,1.4],[4.5,6,1.4,1.4],[7.5,7.5,1.4,1.4]]


def plan(goal, blocks):
    spacing=.25;start=(4,4);target=(round(goal[0]/spacing),round(goal[1]/spacing))
    def blocked(node):
        x,y=node[0]*spacing,node[1]*spacing
        return x<.5 or y<.5 or x>9.5 or y>9.5 or any(abs(x-cx)<w/2+.32 and abs(y-cy)<h/2+.32 for cx,cy,w,h in blocks)
    if blocked(target):raise ValueError('That destination is inside a wall or too close to it. Pick open floor.')
    queue=[(0,start)];cost={start:0};previous={}
    while queue:
        _,node=heapq.heappop(queue)
        if node==target:
            route=[node]
            while node!=start:node=previous[node];route.append(node)
            return [[x*spacing,y*spacing] for x,y in reversed(route)]
        for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]:
            nxt=(node[0]+dx,node[1]+dy)
            if blocked(nxt):continue
            new=cost[node]+1
            if new<cost.get(nxt,math.inf):
                cost[nxt]=new;previous[nxt]=node;heapq.heappush(queue,(new+abs(nxt[0]-target[0])+abs(nxt[1]-target[1]),nxt))
    raise ValueError('There is no clear route to that destination.')


def simulate(p,out):
    blocks=obstacles(p['layout']);route=plan([p['goal_x'],p['goal_y']],blocks)
    root=ET.Element('mujoco',model='Harness office rover');ET.SubElement(root,'option',timestep='0.01',gravity='0 0 0')
    world=ET.SubElement(root,'worldbody');ET.SubElement(world,'geom',type='plane',size='10 10 .1',rgba='.2 .25 .2 1')
    for i,(x,y,w,h) in enumerate(blocks):ET.SubElement(world,'geom',name=f'wall{i}',type='box',pos=f'{x} {y} .5',size=f'{w/2} {h/2} .5')
    body=ET.SubElement(world,'body',name='rover',pos='0 0 .2')
    ET.SubElement(body,'joint',name='east',type='slide',axis='1 0 0',damping='3')
    ET.SubElement(body,'joint',name='north',type='slide',axis='0 1 0',damping='3')
    ET.SubElement(body,'geom',name='rover_body',type='cylinder',size='.2 .12',mass='1',rgba='.75 .9 .5 1')
    actuators=ET.SubElement(root,'actuator')
    for name in ['east','north']:ET.SubElement(actuators,'velocity',joint=name,kv='10',ctrlrange='-1.5 1.5')
    xml=ET.tostring(root,encoding='unicode');(out/'mission.xml').write_text(xml)
    model=mujoco.MjModel.from_xml_string(xml);data=mujoco.MjData(model);data.qpos[:2]=[1,1]
    mujoco.mj_forward(model,data);positions=[];waypoint=1;distance=0.;contacts=0;last=np.array([1.,1.]);success=False
    for step in range(30000):
        target=np.array(route[min(waypoint,len(route)-1)]);delta=target-data.qpos[:2]
        if np.linalg.norm(delta)<.12:
            if waypoint>=len(route)-1:success=True;break
            waypoint+=1;target=np.array(route[waypoint]);delta=target-data.qpos[:2]
        control=delta*4;length=np.linalg.norm(control)
        data.ctrl[:]=control*min(1,p['speed']/max(length,1e-9))
        mujoco.mj_step(model,data)
        distance+=float(np.linalg.norm(data.qpos[:2]-last));last=data.qpos[:2].copy();contacts+=data.ncon
        if step%10==0:positions.append([round(data.time,2),round(float(data.qpos[0]),4),round(float(data.qpos[1]),4)])
    if not success:raise RuntimeError('The rover did not reach its destination within the simulation budget.')
    positions.append([round(data.time,2),round(float(data.qpos[0]),4),round(float(data.qpos[1]),4)])
    telemetry={'route':route,'positions':positions,'obstacles':blocks,'goal':[p['goal_x'],p['goal_y']],'success':success,'contacts':contacts,'layout':p['layout']}
    (out/'mission.json').write_text(json.dumps(telemetry,indent=2))
    return {'title':f'Arrived · {distance:.1f} metre adventure','description':'A planned route executed in MuJoCo dynamics. Replay uses the recorded robot positions, with no physical robot involved.','engine':f'MuJoCo {mujoco.__version__} · simulated rover','metrics':[metric('Distance',round(distance,1),'m'),metric('Travel time',round(data.time,1),'s'),metric('Wall contacts',contacts)],'data':telemetry,'files':[{'label':'Mission telemetry','name':'mission.json'},{'label':'MuJoCo world','name':'mission.xml'}]}


def dimos(p,out):
    executable=shutil.which('dimos')
    if not executable:raise RuntimeError('The DimOS daemon is not installed on this machine. Use the local MuJoCo mission, or follow upstream/docs/installation for DimOS.')
    log=command([executable,'status'],timeout=15)
    (out/'dimos-status.txt').write_text(log)
    return {'title':'DimOS status','description':'Read the local daemon state. No mission or hardware command was sent.','engine':'Native DimOS CLI','metrics':[],'data':{'status':log},'files':[{'label':'Daemon status','name':'dimos-status.txt'}]}


if __name__=='__main__':execute({'simulate':simulate,'dimos':dimos})
