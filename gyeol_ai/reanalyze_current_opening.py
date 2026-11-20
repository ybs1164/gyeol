"""Reevaluate the actual current opening with a frozen current model."""
import argparse, hashlib, io, json
from pathlib import Path
import numpy as np
import torch
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper
from MCTS import MCTS
from utils import dotdict
from find_fair_opening import key, search
from validate_fair_opening import summary
from validate_fair_opening_batch import DeferredNet, simulations

ap = argparse.ArgumentParser()
ap.add_argument('--resume', action='store_true')
ap.add_argument('--output', default='current_opening_analysis')
ap.add_argument('--deep-games', type=int, default=32)
ap.add_argument('--deep-sims', type=int, default=200)
args = ap.parse_args()
out = Path(args.output)
out.mkdir(exist_ok=True)
data = (out/'model.pth.tar' if args.resume else Path('temp/best.pth.tar')).read_bytes()
(out/'model.pth.tar').write_bytes(data)
game = GyeolGame()
net = NNetWrapper(game)
net.nnet.load_state_dict(torch.load(io.BytesIO(data), map_location=net.device)['state_dict'])
net.nnet.eval()
torch.set_num_threads(1)
b = game.getInitBoard()
report = dict(sha256=hashlib.sha256(data).hexdigest(), board=b.tolist(),
              symmetry_values=[float(net.predict(L.recenter(L.transform_board(b,s)))[1]) for s in L.SYMMETRIES],
              legal_moves=len(L.legal_moves(b,1)), searches=[], experiments=[])
if args.resume:
    report = json.loads((out/'results.json').read_text())
    assert report['sha256'] == hashlib.sha256(data).hexdigest()
def save():
    (out/'results.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print('model',report['sha256'],'values',report['symmetry_values'],flush=True)
for sims in (100,800,3200):
    if any(s['sims'] == sims for s in report['searches']):
        continue
    r=search(game,net,b,sims,uniform=0)
    r.update(sims=sims,description=L.action_to_str(r['best_action']))
    report['searches'].append(r)
    print('search',json.dumps(r,ensure_ascii=True),flush=True)
    save()
for sims,games in ((100,64),(args.deep_sims,args.deep_games)):
    entry=next((e for e in report['experiments'] if e['sims']==sims),None)
    if entry is None:
        entry=dict(sims=sims,games=games,random_opening_plies=6,records=[])
        report['experiments'].append(entry)
    entry['games']=games
    for offset in range(len(entry['records']),games,16):
        active=[]
        for gi in range(offset,min(offset+16,games)):
            board=L.recenter(L.transform_board(b,L.SYMMETRIES[gi%8]))
            proxy=DeferredNet()
            tree=MCTS(game,proxy,dotdict(numMCTSSims=sims,cpuct=1.5,dirichletAlpha=0))
            tree.root_prior=tree.root_noise=None
            active.append(dict(gi=gi,board=board,player=1,canonical=board,proxy=proxy,tree=tree,
                rng=np.random.RandomState(2026101900+gi),actions=[],trajectory=[]))
        ply=0
        while active:
            simulations(active,net,sims)
            remaining=[]
            for st in active:
                s=game.stringRepresentation(st['canonical'])
                counts=np.array([st['tree'].Nsa.get((s,a),0) for a in range(L.ACTION_SIZE)],dtype=float)
                a=int(st['rng'].choice(len(counts),p=counts/counts.sum())) if ply<6 else int(st['rng'].choice(np.flatnonzero(counts==counts.max())))
                assert game.getValidMoves(st['board'],st['player'])[a]
                st['actions'].append(a)
                st['trajectory'].append(key(st['canonical']).hex())
                st['board'],st['player']=game.getNextState(st['board'],st['player'],a)
                result=game.getGameEnded(st['board'],1)
                if result:
                    entry['records'].append(dict(seed=2026101900+st['gi'],orientation=st['gi']%8,result=float(result),margin=int(np.sign(st['board']).sum()),passes=st['actions'].count(L.PASS_ACTION),actions=st['actions'],trajectory=st['trajectory']))
                else:
                    st['canonical']=game.getCanonicalForm(st['board'],st['player'])
                    remaining.append(st)
            active=remaining
            ply+=1
            assert ply<100
            if ply%8==0: print('progress',sims,offset,ply,len(active),flush=True)
        entry['summary']=summary(entry['records'])
        save()
        print('summary',sims,entry['summary'],flush=True)
report['source_model_unchanged']=hashlib.sha256(Path('temp/best.pth.tar').read_bytes()).hexdigest()==report['sha256']
save()
