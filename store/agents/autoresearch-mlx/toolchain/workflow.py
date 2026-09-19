import hashlib
import json
import math
import platform
import shutil
import sys
import numpy as np
from studio_runtime import execute, metric, command, workspace, package, contained, previous_runs


def evaluate(model, text):
    probabilities=model['probabilities'];contexts=model['contexts'].tolist();vocab=model['vocab'].tolist();n=int(model['context'])
    if probabilities.shape!=(len(contexts),len(vocab)) or not np.isfinite(probabilities).all() or np.min(probabilities)<=0 or not np.allclose(probabilities.sum(axis=1),1):
        raise ValueError('The saved model has invalid probabilities')
    rows={c:i for i,c in enumerate(contexts)};characters={c:i for i,c in enumerate(vocab)}
    losses=[]
    for i in range(n,len(text)):
        probability=float(probabilities[rows.get(text[i-n:i],0),characters[text[i]]]) if text[i] in characters else 1e-8
        losses.append(-math.log2(probability))
    if not losses:raise ValueError('The held-out text is too short')
    return sum(losses)/len(losses)


def train(p,out):
    for name in ['train.py','train.txt','holdout.txt']:
        if not contained(workspace()/name).is_file():raise RuntimeError(f'The workspace needs {name}')
    print('Training the CPU experiment…',flush=True)
    command([sys.executable,workspace()/'train.py',out],cwd=workspace(),timeout=90)
    model=np.load(out/'model.npz',allow_pickle=False)
    heldout=(workspace()/'holdout.txt').read_text()
    loss=evaluate(model,heldout)
    training=json.loads((out/'training.json').read_text())
    if not training['curve'] or not all(len(row)==2 and all(math.isfinite(v) for v in row) for row in training['curve']):
        raise ValueError('The training curve is invalid')
    hashes={name:hashlib.sha256((workspace()/name).read_bytes()).hexdigest() for name in ['train.py','train.txt','holdout.txt']}
    prior=[r for r in previous_runs() if r.get('action')=='train' and r.get('data',{}).get('hashes',{}).get('holdout.txt')==hashes['holdout.txt'] and r.get('data',{}).get('hashes',{}).get('train.txt')==hashes['train.txt']]
    best=min([r['data']['heldoutBpc'] for r in prior],default=None)
    delta=loss-best if best is not None else None
    status='First baseline' if best is None else ('New best' if loss<best else 'Keep exploring')
    data={'curve':training['curve'],'heldoutBpc':loss,'previousBest':best,'delta':delta,'hashes':hashes,'status':status}
    (out/'evaluation.json').write_text(json.dumps(data,indent=2,allow_nan=False))
    (out/'learning.csv').write_text('step,training_bits_per_character\n'+'\n'.join(f'{step},{value:.8f}' for step,value in training['curve'])+'\n')
    return {'title':f'{status} · {loss:.3f} bits/char','description':'The saved model was independently evaluated against the unchanged holdout text. One run is a measurement, not a significance test.','engine':'CPU character model · NumPy','metrics':[metric('Held-out loss',round(loss,3),'bits/char'),metric('Training steps',p['steps']),metric('Against best',f'{delta:+.3f}' if delta is not None else 'baseline','bits/char' if delta is not None else '')], 'data':data,
            'files':[{'label':'Model checkpoint','name':'model.npz'},{'label':'Evaluation record','name':'evaluation.json'},{'label':'Learning curve','name':'learning.csv'}]}


def mlx(p,out):
    if platform.system()!='Darwin' or platform.machine()!='arm64':
        raise RuntimeError('Upstream MLX needs Apple Silicon. This machine can run the CPU experiment above.')
    root=contained(workspace()/'mlx')
    if not (root/'train.py').is_file() or not (root/'.venv/bin/python').is_file():
        raise RuntimeError('Prepare a workspace mlx/ checkout and its data using the pinned upstream README before a native experiment.')
    print('Running the fixed-budget upstream MLX experiment…',flush=True)
    log=command([root/'.venv/bin/python','train.py'],cwd=root,timeout=600)
    (out/'mlx.log').write_text(log)
    import re
    match=re.search(r'val_bpb:\s*([0-9.]+)',log)
    if not match:raise RuntimeError('MLX did not report val_bpb. Inspect the training output.')
    return {'title':'Native MLX experiment','description':'The upstream training script completed on this Apple Silicon machine. Repeat before treating a small improvement as real.','engine':'Native MLX','metrics':[metric('Validation loss',float(match[1]),'bits/byte')],'data':{},'files':[{'label':'MLX training log','name':'mlx.log'}]}


if __name__=='__main__':execute({'train':train,'mlx':mlx})
