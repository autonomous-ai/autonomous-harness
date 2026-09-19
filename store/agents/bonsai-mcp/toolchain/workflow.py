import csv
import json
import math
import sys
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element
import numpy as np
from studio_runtime import execute, metric, package


def build(p,out):
    f=ifcopenshell.file(schema='IFC4')
    def api(operation,**args):return ifcopenshell.api.run(operation,f,**args)
    def entity(kind,name):return api('root.create_entity',ifc_class=kind,name=name)
    project=entity('IfcProject','House of ideas')
    api('unit.assign_unit',units=[api('unit.add_si_unit',unit_type='LENGTHUNIT'),api('unit.add_si_unit',unit_type='AREAUNIT'),api('unit.add_si_unit',unit_type='VOLUMEUNIT')])
    model=api('context.add_context',context_type='Model')
    context=api('context.add_context',context_type='Model',context_identifier='Body',target_view='MODEL_VIEW',parent=model)
    site=entity('IfcSite','Studio garden');building=entity('IfcBuilding','A small possibility')
    api('aggregate.assign_object',products=[site],relating_object=project)
    api('aggregate.assign_object',products=[building],relating_object=site)
    width,depth,height=p['width'],p['depth'],p['height'];spaces=[];elements=[]
    def place(product,x,y,z,angle=0):
        a=math.radians(angle);m=np.eye(4);m[:2,:2]=[[math.cos(a),-math.sin(a)],[math.sin(a),math.cos(a)]];m[:3,3]=[x,y,z]
        api('geometry.edit_object_placement',product=product,matrix=m,is_si=True)
    def geometry(product,representation):api('geometry.assign_representation',product=product,representation=representation)
    for level in range(p['storeys']):
        z=level*(height+.2);storey=entity('IfcBuildingStorey',f'Level {level+1}');storey.Elevation=z
        api('aggregate.assign_object',products=[storey],relating_object=building);place(storey,0,0,z)
        slab=entity('IfcSlab',f'Floor {level+1}');api('spatial.assign_container',products=[slab],relating_structure=storey)
        geometry(slab,api('geometry.add_slab_representation',context=context,depth=.2,polyline=[(0.,0.),(width,0.),(width,depth),(0.,depth),(0.,0.)]));place(slab,0,0,z)
        elements.append({'id':slab.GlobalId,'kind':'slab','x':0,'y':0,'z':z,'width':width,'depth':depth,'height':.2,'level':level})
        walls=[]
        for label,x,y,length,angle in [('South',0,0,width,0),('East',width,0,depth,90),('North',width,depth,width,180),('West',0,depth,depth,270),('Partition',width*.55,0,depth,90)]:
            wall=entity('IfcWall',f'{label} wall · level {level+1}');api('spatial.assign_container',products=[wall],relating_structure=storey)
            geometry(wall,api('geometry.add_wall_representation',context=context,length=length,height=height,thickness=.2));place(wall,x,y,z+.2,angle);walls.append(wall)
            elements.append({'id':wall.GlobalId,'kind':'wall','x':x,'y':y,'z':z+.2,'length':length,'height':height,'angle':angle,'level':level})
        opening=entity('IfcOpeningElement',f'Garden window opening {level+1}')
        geometry(opening,api('geometry.add_wall_representation',context=context,length=1.8,height=1.4,thickness=.4));place(opening,1,-.1,z+1)
        api('feature.add_feature',feature=opening,element=walls[0])
        window=entity('IfcWindow',f'Garden window {level+1}');window.OverallHeight=1.4;window.OverallWidth=1.8
        api('spatial.assign_container',products=[window],relating_structure=storey)
        geometry(window,api('geometry.add_wall_representation',context=context,length=1.8,height=1.4,thickness=.06));place(window,1,.07,z+1)
        api('feature.add_filling',opening=opening,element=window)
        names=['Studio','Reading room'] if p['use']=='studio' else ['Living room','Bedroom']
        for room,(x,roomwidth) in enumerate([(.2,width*.55-.4),(width*.55+.2,width*.45-.4)]):
            roomdepth=depth-.4;space=entity('IfcSpace',f'{names[room]} · level {level+1}')
            api('aggregate.assign_object',products=[space],relating_object=storey)
            profile=f.create_entity('IfcRectangleProfileDef',ProfileType='AREA',XDim=roomwidth,YDim=roomdepth)
            geometry(space,api('geometry.add_profile_representation',context=context,profile=profile,depth=height));place(space,x+roomwidth/2,.2+roomdepth/2,z+.2)
            qto=api('pset.add_qto',product=space,name='Qto_SpaceBaseQuantities')
            api('pset.edit_qto',qto=qto,properties={'NetFloorArea':roomwidth*roomdepth,'NetVolume':roomwidth*roomdepth*height,'Height':height})
            spaces.append({'id':space.GlobalId,'name':space.Name,'x':x,'y':.2,'width':roomwidth,'depth':roomdepth,'level':level})
    f.write(out/'building.ifc')
    # Read quantities back from the actual saved IFC, rather than trusting UI dimensions.
    checked=ifcopenshell.open(out/'building.ifc');total=0;rows=[]
    for space in checked.by_type('IfcSpace'):
        q=ifcopenshell.util.element.get_psets(space,qtos_only=True)['Qto_SpaceBaseQuantities'];total+=q['NetFloorArea'];rows.append([space.GlobalId,space.Name,q['NetFloorArea'],q['NetVolume']])
    if len(rows)!=2*p['storeys'] or len(checked.by_type('IfcOpeningElement'))!=p['storeys']:raise RuntimeError('The IFC read-back did not match the building.')
    with (out/'quantities.csv').open('w',newline='') as stream:
        writer=csv.writer(stream);writer.writerow(['global_id','room','net_area_m2','net_volume_m3']);writer.writerows(rows)
    data={'spaces':spaces,'elements':elements,'width':width,'depth':depth,'height':height,'storeys':p['storeys'],'area':total}
    (out/'building.json').write_text(json.dumps(data,indent=2))
    return {'title':f'{p["storeys"]}-storey {p["use"]} · {total:.1f} m²','description':'A real IFC4 model with walls, slabs, spaces and window openings. Quantities were read back from the saved file; the viewer is a schematic inspector.','engine':f'IfcOpenShell {ifcopenshell.version} · IFC4','metrics':[metric('Net floor area',round(total,1),'m²'),metric('Rooms',len(rows)),metric('Storeys',p['storeys'])],'data':data,'files':[{'label':'IFC building','name':'building.ifc'},{'label':'Room quantities','name':'quantities.csv'},{'label':'Viewer geometry','name':'building.json'}]}


def bonsai(p,out):
    sys.path.insert(0,str(package()/'upstream/src'))
    from bonsai_mcp.blender_client import BlenderBridgeClient
    client=BlenderBridgeClient(timeout=3)
    try:scene=client.send('get_scene_info',{'limit':50})
    finally:client.close()
    (out/'bonsai-scene.json').write_text(json.dumps(scene,indent=2))
    return {'title':'Bonsai scene snapshot','description':'Read directly from the Blender/Bonsai bridge. No geometry was changed.','engine':'Native Bonsai MCP bridge','metrics':[],'data':{'scene':scene},'files':[{'label':'Scene snapshot','name':'bonsai-scene.json'}]}


if __name__=='__main__':execute({'build':build,'bonsai':bonsai})
