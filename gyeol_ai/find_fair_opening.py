"""Screen adjacent two-tile and all balanced 2x2 starts using a fixed model."""
import hashlib
import io
import itertools
import json
import time
from pathlib import Path

import numpy as np
import torch

from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper
from MCTS import MCTS
from utils import dotdict


OUT = Path('fair_opening_analysis')


def key(board):
    return min(L.recenter(L.transform_board(board, s)).tobytes() for s in L.SYMMETRIES)


def diagram(board):
    r0, r1, c0, c1 = L.bbox(board)
    return board[r0:r1+1, c0:c1+1].tolist()


def search(game, net, board, sims, uniform=.1):
    tree = MCTS(game, net, dotdict(numMCTSSims=sims-1, cpuct=1.5, dirichletAlpha=0))
    tree.search(board)
    s = game.stringRepresentation(board)
    valid = tree.Vs[s]
    tree.Ps[s] = (1-uniform)*tree.Ps[s] + uniform*valid/valid.sum()
    probs = tree.getActionProb(board, temp=1)
    a = int(np.argmax(probs))
    return dict(mean_q=float(sum(probs[x]*tree.Qsa[(s,int(x))] for x in np.flatnonzero(probs))),
                best_q=float(tree.Qsa[(s,a)]), best_action=a,
                best_visits=int(tree.Nsa[(s,a)]), visited=len(np.flatnonzero(probs)))


def main():
    OUT.mkdir(exist_ok=True)
    data = Path('temp/best.pth.tar').read_bytes()
    meta = dict(sha256=hashlib.sha256(data).hexdigest(), source='temp/best.pth.tar',
                seed=20261018, root_uniform_mix=.1,
                scope='Adjacent one tile per color; all balanced 2x2 four-tile starts, modulo D4. Green moves first.')
    (OUT/'model.pth.tar').write_bytes(data)
    game = GyeolGame()
    net = NNetWrapper(game)
    net.nnet.load_state_dict(torch.load(io.BytesIO(data), map_location=net.device)['state_dict'])
    np.random.seed(meta['seed'])
    candidates = []
    seen = set()
    original = L.initial_board()
    for count in (2,4):
        cells = [(3,2),(3,3)] if count == 2 else [(2,2),(2,3),(3,2),(3,3)]
        for green in itertools.combinations(range(count), count//2):
            for dirs in itertools.product(range(1,5), repeat=count):
                b = np.zeros((7,7), dtype=np.int8)
                for i, cell in enumerate(cells):
                    b[cell] = dirs[i] * (1 if i in green else -1)
                k = key(b)
                if k in seen:
                    continue
                seen.add(k)
                symvalues = [float(net.predict(L.recenter(L.transform_board(b,s)))[1]) for s in L.SYMMETRIES]
                candidates.append(dict(id=len(candidates), tiles=count, board=b.tolist(), diagram=diagram(b),
                    original=key(b)==key(original), network_mean=float(np.mean(symvalues)),
                    network_range=[min(symvalues),max(symvalues)]))
    print('Candidates:',len(candidates),flush=True)
    (OUT/'metadata.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
    t = time.time()
    for i, c in enumerate(candidates):
        c['screen'] = search(game,net,np.array(c['board'],dtype=np.int8),200)
        if (i+1)%20 == 0:
            print('screen',i+1,'/',len(candidates),'seconds',round(time.time()-t),flush=True)
    (OUT/'screen.json').write_text(json.dumps(candidates,indent=2),encoding='utf-8')
    ranked = sorted(candidates,key=lambda c:abs(c['screen']['best_q']))
    finalists = ranked[:12]
    # Include the best two-tile starts and original as explicit controls.
    for c in sorted((c for c in candidates if c['tiles']==2),key=lambda c:abs(c['screen']['best_q']))[:2] + [c for c in candidates if c['original']]:
        if c not in finalists:
            finalists.append(c)
    for c in finalists:
        c['deep'] = search(game,net,np.array(c['board'],dtype=np.int8),2000)
        print('deep',c['id'],c['diagram'],c['deep'],flush=True)
        (OUT/'finalists.json').write_text(json.dumps(finalists,indent=2),encoding='utf-8')


if __name__ == '__main__':
    main()
