"""Batch independent MCTS leaf evaluations without changing search rules."""
import argparse
import json

import numpy as np
import torch

from find_fair_opening import OUT, key
from validate_fair_opening import summary
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper
from MCTS import MCTS
from utils import dotdict


class Pending(Exception):
    pass


class DeferredNet:
    def __init__(self):
        self.ready = {}
        self.pending = None

    def predict(self, board):
        k = board.tobytes()
        if k in self.ready:
            return self.ready.pop(k)
        self.pending = board.copy()
        raise Pending()


@torch.no_grad()
def simulations(states, net, count):
    for _ in range(count):
        waiting = []
        for st in states:
            try:
                st['tree'].search(st['canonical'], root=True)
            except Pending:
                waiting.append(st)
        if waiting:
            boards = torch.from_numpy(np.stack([st['proxy'].pending for st in waiting])).to(net.device)
            pi, v = net.nnet(boards)
            pi, v = torch.exp(pi).cpu().numpy(), v.cpu().numpy().reshape(-1)
            for i, st in enumerate(waiting):
                proxy = st['proxy']
                proxy.ready[proxy.pending.tobytes()] = (pi[i], float(v[i]))
                # search only mutates edge counts/Q after its recursive child returns.
                st['tree'].search(st['canonical'], root=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ids', type=int, nargs='+', required=True)
    ap.add_argument('--games', type=int, default=32)
    ap.add_argument('--sims', type=int, default=100)
    ap.add_argument('--seed', type=int, default=2026101800)
    ap.add_argument('--label', default='batch_pilot')
    ap.add_argument('--batch-size', type=int, default=32)
    ap.add_argument('--threads', type=int, default=2)
    args = ap.parse_args()
    candidates = json.loads((OUT/'screen.json').read_text())
    game = GyeolGame()
    net = NNetWrapper(game)
    net.load_checkpoint(str(OUT),'model.pth.tar')
    net.nnet.eval()
    torch.set_num_threads(args.threads)
    entries = [dict(id=cid,diagram=candidates[cid]['diagram'],records=[]) for cid in args.ids]
    results = dict(settings=vars(args),candidates=entries)
    tasks = [(entry,gi) for gi in range(args.games) for entry in entries]
    target = OUT/f'{args.label}.json'
    for offset in range(0,len(tasks),args.batch_size):
        active = []
        for entry,gi in tasks[offset:offset+args.batch_size]:
            b = L.recenter(L.transform_board(np.array(candidates[entry['id']]['board'],dtype=np.int8),L.SYMMETRIES[gi%8]))
            proxy = DeferredNet()
            tree = MCTS(game,proxy,dotdict(numMCTSSims=args.sims,cpuct=1.5,dirichletAlpha=0))
            tree.root_prior = tree.root_noise = None
            active.append(dict(entry=entry,gi=gi,board=b,player=1,canonical=b,proxy=proxy,tree=tree,
                rng=np.random.RandomState(args.seed+gi),actions=[],trajectory=[]))
        ply = 0
        while active:
            simulations(active,net,args.sims)
            remaining = []
            for st in active:
                s = game.stringRepresentation(st['canonical'])
                counts = np.array([st['tree'].Nsa.get((s,a),0) for a in range(L.ACTION_SIZE)],dtype=float)
                if len(st['actions'])<6:
                    a = int(st['rng'].choice(len(counts),p=counts/counts.sum()))
                else:
                    a = int(st['rng'].choice(np.flatnonzero(counts==counts.max())))
                assert game.getValidMoves(st['board'],st['player'])[a]
                st['actions'].append(a)
                st['trajectory'].append(key(st['canonical']).hex())
                st['board'],st['player'] = game.getNextState(st['board'],st['player'],a)
                result = game.getGameEnded(st['board'],1)
                if result:
                    st['entry']['records'].append(dict(seed=args.seed+st['gi'],orientation=st['gi']%8,
                        result=float(result),margin=int(np.sign(st['board']).sum()),
                        passes=st['actions'].count(L.PASS_ACTION),actions=st['actions'],trajectory=st['trajectory']))
                else:
                    st['canonical'] = game.getCanonicalForm(st['board'],st['player'])
                    remaining.append(st)
            active = remaining
            ply += 1
            assert ply<100
            if ply%6==0:
                print('batch',offset,'ply',ply,'active',len(active),flush=True)
        for entry in entries:
            if entry['records']:
                entry['summary'] = summary(entry['records'])
        target.write_text(json.dumps(results,indent=2),encoding='utf-8')
        print('completed',offset+len(tasks[offset:offset+args.batch_size]),
              [(e['id'],e.get('summary')) for e in entries],flush=True)


if __name__ == '__main__':
    main()
