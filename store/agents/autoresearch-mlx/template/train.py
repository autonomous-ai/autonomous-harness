"""Editable CPU experiment: fit a character transition model by gradient descent."""
import json
from pathlib import Path
import sys
import numpy as np

def fit(text, p, output):
    vocab=sorted(set(text));index={c:i for i,c in enumerate(vocab)};n=p['context']
    contexts=['']+sorted(set(text[i-n:i] for i in range(n,len(text))))
    rows={c:i for i,c in enumerate(contexts)}
    counts=np.full((len(contexts),len(vocab)),.01)
    for i in range(n,len(text)):
        counts[rows[text[i-n:i]],index[text[i]]]+=1
        counts[0,index[text[i]]]+=1
    targets=counts/counts.sum(axis=1,keepdims=True)
    rng=np.random.default_rng(p['seed']);logits=rng.normal(0,.03,counts.shape)
    curve=[]
    for step in range(p['steps']+1):
        values=np.exp(logits-logits.max(axis=1,keepdims=True));probabilities=values/values.sum(axis=1,keepdims=True)
        if step%10==0 or step==p['steps']:
            loss=float(-(counts*np.log2(probabilities)).sum()/counts.sum())
            curve.append([step,loss])
        logits-=p['learning_rate']*(probabilities-targets)
    np.savez_compressed(output/'model.npz',probabilities=probabilities,contexts=np.array(contexts),vocab=np.array(vocab),context=np.array(n))
    (output/'training.json').write_text(json.dumps({'curve':curve}))

if __name__=='__main__':
    fit(Path('train.txt').read_text(),json.loads(Path('studio.json').read_text())['parameters'],Path(sys.argv[1]))
