import json
import shutil
import numpy as np
from studio_runtime import execute, metric, command, workspace, contained


def simulate(p, out):
    width, height = 120, 56
    x, y = np.meshgrid(np.arange(width), np.arange(height))
    cx, cy, radius = 36, height // 2, p["radius"]
    if p["shape"] == "circle":
        body = (x-cx)**2 + (y-cy)**2 <= radius**2
    elif p["shape"] == "square":
        body = (abs(x-cx) <= radius) & (abs(y-cy) <= radius)
    else:
        body = ((x-cx)/(radius*1.8))**2 + ((y-cy)/(radius*.55))**2 <= 1
    solid = body.copy(); solid[0,:] = True; solid[-1,:] = True
    c = np.array([[0,0],[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]])
    weights = np.array([4/9]+[1/9]*4+[1/36]*4)
    opposite = [0,3,4,1,2,7,8,5,6]
    speed = p["speed"] / 100
    rho = np.ones((height,width)); ux = np.full_like(rho,speed); uy = np.zeros_like(rho)
    def equilibrium():
        cu = c[:,0,None,None]*ux + c[:,1,None,None]*uy
        return weights[:,None,None]*rho*(1+3*cu+4.5*cu**2-1.5*(ux**2+uy**2))
    f = equilibrium(); inlet = f[:,:,0].copy(); changes=[]
    for step in range(p["steps"]):
        previous = ux.copy()
        rho = f.sum(axis=0)
        ux = np.sum(f*c[:,0,None,None],axis=0)/rho
        uy = np.sum(f*c[:,1,None,None],axis=0)/rho
        ux[solid]=0; uy[solid]=0
        f += (equilibrium()-f)/(3*p["viscosity"]+.5)
        for i,(dx,dy) in enumerate(c):
            f[i]=np.roll(np.roll(f[i],dx,axis=1),dy,axis=0)
        bounced=f[opposite][:,solid].copy();f[:,solid]=bounced
        f[:,:,0]=inlet;f[:,:,-1]=f[:,:,-2]
        if step%40==0:
            change=float(np.sqrt(np.mean((ux-previous)**2)));changes.append([step,round(change,8)])
            print(f'Simulating flow · {step}/{p["steps"]} steps',flush=True)
    if not np.all(np.isfinite(f)) or np.max(abs(ux))>.6:
        raise RuntimeError('The flow became unstable. Use a slower wind or higher viscosity.')
    velocity=np.sqrt(ux**2+uy**2);fluid=~solid
    field=np.stack([x,y,ux,uy,rho/3,solid.astype(float)],axis=-1).reshape(-1,6)
    np.savetxt(out/'flow.csv',field,delimiter=',',header='x,y,ux,uy,pressure,solid',comments='')
    stride=2
    data={"width":width,"height":height,"stride":stride,"shape":p["shape"],"radius":radius,
          "ux":np.round(ux[::stride,::stride],5).tolist(),"uy":np.round(uy[::stride,::stride],5).tolist(),
          "pressure":np.round(rho[::stride,::stride]/3,6).tolist(),
          "solid":solid[::stride,::stride].astype(int).tolist(),"convergence":changes}
    (out/'field.json').write_text(json.dumps(data))
    return {"title":f'{p["shape"].capitalize()} · wind {p["speed"]}',"description":"A real coarse-grid 2D flow simulation. Compare the velocity field under the same settings; this is not a validated drag estimate.",
            "engine":"Local D2Q9 lattice Boltzmann simulation","metrics":[metric("Reynolds number",round(speed*2*radius/p["viscosity"],1)),metric("Peak velocity",round(float(velocity[fluid].max()),3),"lattice"),metric("Solver steps",p["steps"])],"data":data,
            "files":[{"label":"Velocity field CSV","name":"flow.csv"},{"label":"Flow data","name":"field.json"}]}


def openfoam(p,out):
    if not shutil.which('icoFoam') or not shutil.which('blockMesh'):
        raise RuntimeError('OpenFOAM Foundation v10 is not active. Source its etc/bashrc, then run again. The local flow simulation is available now.')
    source=contained(workspace()/'openfoam-cavity')
    if not source.is_dir():
        raise RuntimeError('The workspace needs the supplied openfoam-cavity benchmark.')
    target=out/'cavity';shutil.copytree(source,target)
    mesh=command(['blockMesh','-case',target],timeout=60)
    log=command(['icoFoam','-case',target],timeout=300)
    (out/'openfoam.log').write_text(mesh+'\n'+log)
    if not (target/'0.5/U').exists():
        raise RuntimeError('OpenFOAM did not produce the final velocity field.')
    shutil.make_archive(str(out/'cavity'),'zip',target)
    return {"title":"Lid-driven cavity · OpenFOAM","description":"The Foundation v10 reference case completed. Inspect its mesh, residuals and final fields before drawing conclusions.","engine":"Native OpenFOAM · icoFoam", "metrics":[metric("Final time",.5,"s"),metric("Mesh",400,"cells")],"data":{"log":log[-3000:]},"files":[{"label":"OpenFOAM case","name":"cavity.zip"},{"label":"Solver log","name":"openfoam.log"}]}


if __name__=='__main__':
    execute({'simulate':simulate,'openfoam':openfoam})
