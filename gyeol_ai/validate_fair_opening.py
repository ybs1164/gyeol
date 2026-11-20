"""Same frozen network on both sides, randomized openings and balanced orientations."""
import argparse
import json
import math
from pathlib import Path

import numpy as np

from find_fair_opening import OUT, key
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper
from MCTS import MCTS
from utils import dotdict


def summary(records):
    n = len(records)
    w = sum(r['result'] == 1 for r in records)
    losses = sum(r['result'] == -1 for r in records)
    p = w/n
    z = 1.96
    center = (p+z*z/(2*n))/(1+z*z/n)
    half = z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/(1+z*z/n)
    return dict(games=n, first_wins=w, second_wins=losses, draws=n-w-losses,
        first_win_rate=p, wilson_95=[center-half,center+half],
        mean_margin=float(np.mean([r['margin'] for r in records])),
        unique_trajectories=len({tuple(r['trajectory']) for r in records}),
        mean_passes=float(np.mean([r['passes'] for r in records])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', type=int, nargs='+', required=True)
    ap.add_argument('--games', type=int, default=16)
    ap.add_argument('--sims', type=int, default=100)
    ap.add_argument('--seed', type=int, default=202610180)
    ap.add_argument('--label', default='pilot')
    args = ap.parse_args()
    candidates = json.loads((OUT/'screen.json').read_text())
    game = GyeolGame()
    net = NNetWrapper(game)
    net.load_checkpoint(str(OUT), 'model.pth.tar')
    results = dict(settings=vars(args), candidates=[])
    target = OUT/f'{args.label}.json'
    for cid in args.ids:
        c = next(c for c in candidates if c['id']==cid)
        records = []
        entry = dict(id=cid, diagram=c['diagram'], records=records)
        results['candidates'].append(entry)
        for gi in range(args.games):
            np.random.seed(args.seed+gi)
            b = L.recenter(L.transform_board(np.array(c['board'],dtype=np.int8),L.SYMMETRIES[gi%8]))
            p = 1
            tree = MCTS(game,net,dotdict(numMCTSSims=args.sims,cpuct=1.5,dirichletAlpha=0))
            actions, trajectory = [], []
            while game.getGameEnded(b,1)==0:
                cb = game.getCanonicalForm(b,p)
                probs = tree.getActionProb(cb,temp=int(len(actions)<6))
                a = int(np.random.choice(len(probs),p=probs))
                assert game.getValidMoves(b,p)[a]
                actions.append(a)
                trajectory.append(key(cb).hex())
                b,p = game.getNextState(b,p,a)
                assert len(actions)<100
            records.append(dict(seed=args.seed+gi,orientation=gi%8,result=float(game.getGameEnded(b,1)),
                margin=int(np.sign(b).sum()),passes=actions.count(L.PASS_ACTION),
                actions=actions,trajectory=trajectory))
            entry['summary'] = summary(records)
            target.write_text(json.dumps(results,indent=2),encoding='utf-8')
            if (gi+1)%4 == 0:
                print(args.label,cid,gi+1,entry['summary'],flush=True)


if __name__ == '__main__':
    main()
