"""Reproduce initial-position model evaluation; leaves training files untouched."""
import hashlib
import json
import pickle
from pathlib import Path

import numpy as np

from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper
from MCTS import MCTS
from utils import dotdict


def stats(values):
    return dict(games=len(values), first_wins=sum(v > .5 for v in values),
                second_wins=sum(v < -.5 for v in values), draws=sum(abs(v) < .5 for v in values))


def main():
    np.random.seed(20261018)
    game = GyeolGame()
    net = NNetWrapper(game)
    path = Path('temp/best.pth.tar')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    net.load_checkpoint('temp', path.name)
    b = game.getInitBoard()
    pi, value = net.predict(b)
    valid = game.getValidMoves(b, 1)
    pi = pi * valid
    pi /= pi.sum()
    report = dict(model=str(path), sha256=digest, value=float(value),
                  symmetry_values=[float(net.predict(L.transform_board(b, s))[1]) for s in L.SYMMETRIES],
                  openings=[], searches=[])
    for a in np.flatnonzero(valid):
        child = L.apply_move(b, 1, int(a))
        report['openings'].append(dict(action=int(a), description=L.action_to_str(int(a)),
            prior=float(pi[a]), first_value=-float(net.predict(-child)[1]),
            first_tiles=int((child > 0).sum()), second_tiles=int((child < 0).sum())))
    with open('temp/trainExamples.examples', 'rb') as f:
        history = pickle.load(f)
    report['replay_iterations'] = []
    for iteration in history:
        # Each actual starting position has exactly eight consecutive symmetries.
        starts = [float(e[2]) for e in iteration if np.count_nonzero(e[0]) == 2]
        assert len(starts) % 8 == 0
        assert all(len(set(starts[i:i+8])) == 1 for i in range(0, len(starts), 8))
        report['replay_iterations'].append(stats(starts[::8]))
    metrics = [json.loads(line) for line in Path('temp/training_metrics.jsonl').read_text().splitlines() if line.strip()]
    report['recent_arena'] = [dict(run=m['run_id'], iteration=m['iteration'],
        **stats([g['result'] for g in m['arena_games']]), unique_games=m['unique_games']) for m in metrics[-10:]]
    print(json.dumps({k:v for k,v in report.items() if k != 'openings'}), flush=True)
    for sims in (100, 800, 3200):
        tree = MCTS(game, net, dotdict(numMCTSSims=sims, cpuct=1.5, dirichletAlpha=0))
        probs = tree.getActionProb(b, temp=1)
        s = game.stringRepresentation(b)
        top = sorted(np.flatnonzero(probs), key=lambda a: probs[a], reverse=True)[:5]
        result = dict(sims=sims, mean_q=float(sum(probs[a]*tree.Qsa[(s,int(a))] for a in np.flatnonzero(probs))),
            top=[dict(action=int(a), description=L.action_to_str(int(a)), visits=tree.Nsa[(s,int(a))], q=float(tree.Qsa[(s,int(a))])) for a in top])
        report['searches'].append(result)
        print(json.dumps(result, ensure_ascii=True), flush=True)
    assert digest == hashlib.sha256(path.read_bytes()).hexdigest(), 'Model changed during evaluation'
    Path('opening_analysis.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
