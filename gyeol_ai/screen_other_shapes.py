"""Broaden the search to selected directions on other connected tetrominoes."""
import itertools
import json
import numpy as np
from find_fair_opening import OUT, key, diagram, search
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper


def main():
    rows=json.loads((OUT/'screen.json').read_text())
    known={key(np.array(c['board'],dtype=np.int8)) for c in rows}
    shapes=[[(0,0),(0,1),(0,2),(0,3)],[(0,0),(0,1),(0,2),(1,1)],
            [(0,0),(1,0),(2,0),(2,1)],[(0,0),(0,1),(1,1),(1,2)]]
    directions=[(d,d,d,d) for d in range(1,5)]+[(1,3,1,3),(1,2,3,4),(2,4,2,4),(2,2,4,4)]
    game=GyeolGame(); net=NNetWrapper(game); net.load_checkpoint(str(OUT),'model.pth.tar')
    added=[]
    for shape in shapes:
        for green in itertools.combinations(range(4),2):
            for ds in directions:
                b=np.zeros((7,7),dtype=np.int8)
                for i,(r,c) in enumerate(shape): b[r+1,c+1]=ds[i]*(1 if i in green else -1)
                b=L.recenter(b); k=key(b)
                if k in known: continue
                known.add(k)
                c=dict(id=len(rows),tiles=4,board=b.tolist(),diagram=diagram(b),original=False,source='other_tetrominoes')
                c['screen']=search(game,net,b,200)
                rows.append(c); added.append(c)
                if len(added)%20==0: print('other shapes',len(added),flush=True)
    (OUT/'screen.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
    # Pilot results suggest targeting slightly negative search values as well as zero.
    ranked=sorted(added,key=lambda c:abs(c['screen']['best_q']+.10))
    finalists=ranked[:8]
    for c in finalists:
        c['deep']=search(game,net,np.array(c['board'],dtype=np.int8),2000)
        print('shape finalist',c['id'],c['diagram'],c['deep'],flush=True)
        (OUT/'other_shape_finalists.json').write_text(json.dumps(finalists,indent=2),encoding='utf-8')


if __name__=='__main__': main()
