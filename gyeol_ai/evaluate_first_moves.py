"""Frozen-network first-player win rate for each distinct first move (original / facing rules).

Every legal first move from the standard start is reduced modulo rotation/reflection.
For each distinct first move, the same frozen model plays both sides from the position
after that move; the 8 board symmetries are used equally. Plies 2..random_plies are
sampled from MCTS visit counts, later plies take the most-visited move.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import time

import numpy as np
import torch

from evaluate_rule_balance import cache_transitions, describe, save
from facing.network import FacingNet
from facing import rules as F
from find_fair_opening import key
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper
from MCTS import MCTS
from utils import dotdict
from validate_fair_opening import summary
from validate_fair_opening_batch import DeferredNet, simulations


def distinct_first_moves(game):
    board = game.getInitBoard()
    seen = {}
    for action in np.flatnonzero(game.getValidMoves(board, 1)):
        child, _ = game.getNextState(board, 1, int(action))
        seen.setdefault(key(child), []).append(int(action))
    return [dict(id=i, actions=acts, action=acts[0])
            for i, (_, acts) in enumerate(sorted(seen.items()))]


def distinct_two_ply(game, net, first_ids, keep):
    """Second-ply openings after the given first moves, screened to the |value| closest to 0."""
    board = game.getInitBoard()
    firsts = distinct_first_moves(game)
    seen = {}
    for f in firsts:
        if f['id'] not in first_ids:
            continue
        child, _ = game.getNextState(board, 1, f['action'])
        for reply in np.flatnonzero(game.getValidMoves(child, -1)):
            grand, _ = game.getNextState(child, -1, int(reply))
            seen.setdefault(key(grand), dict(prefix=[f['action'], int(reply)], first_id=f['id']))
    entries = []
    for i, (_, e) in enumerate(sorted(seen.items())):
        b = game.getInitBoard()
        p = 1
        for a in e['prefix']:
            b, p = game.getNextState(b, p, a)
        values = [float(net.predict(L.recenter(L.transform_board(b, s)))[1]) for s in L.SYMMETRIES]
        entries.append(dict(id=i, prefix=e['prefix'], first_id=e['first_id'], action=e['prefix'][0],
                            screen_values=values, screen=max(abs(v) for v in values)))
    return sorted(entries, key=lambda e: e['screen'])[:keep]


def start_of(game, opening):
    board, player = game.getInitBoard(), 1
    for a in opening.get('prefix', [opening['action']]):
        board, player = game.getNextState(board, player, a)
    return board, player


def play_batch(game, net, opts, opening, indices):
    game.clear_transition_cache()
    start, first_player = start_of(game, opening)
    active = []
    for gi in indices:
        board = L.recenter(L.transform_board(start, L.SYMMETRIES[gi % 8]))
        proxy = DeferredNet()
        tree = MCTS(game, proxy, dotdict(numMCTSSims=opts.sims, cpuct=1.5, dirichletAlpha=0))
        tree.root_prior = tree.root_noise = None
        active.append(dict(gi=gi, board=board, player=first_player, proxy=proxy, tree=tree,
                           canonical=game.getCanonicalForm(board, first_player),
                           rng=np.random.RandomState(opts.seed + 1000 * opening['id'] + gi),
                           actions=[], boards=[board.tolist()]))
    records = []
    ply = len(opening.get('prefix', [0]))
    while active:
        simulations(active, net, opts.sims)
        remaining = []
        for st in active:
            s = game.stringRepresentation(st['canonical'])
            counts = np.array([st['tree'].Nsa.get((s, a), 0)
                               for a in range(game.getActionSize())], dtype=float)
            if ply < opts.random_plies:
                action = int(st['rng'].choice(len(counts), p=counts / counts.sum()))
            else:
                action = int(st['rng'].choice(np.flatnonzero(counts == counts.max())))
            assert game.getValidMoves(st['board'], st['player'])[action]
            st['actions'].append(action)
            st['board'], st['player'] = game.getNextState(st['board'], st['player'], action)
            st['boards'].append(st['board'].tolist())
            result = game.getGameEnded(st['board'], 1)
            if result:
                records.append(dict(game_index=st['gi'], orientation=st['gi'] % 8,
                    seed=opts.seed + 1000 * opening['id'] + st['gi'], result=float(result),
                    margin=int(np.sign(st['board']).sum()),
                    passes=st['actions'].count(game.getActionSize() - 1),
                    actions=st['actions'], boards=st['boards'],
                    trajectory=[key(np.array(b, dtype=st['board'].dtype)).hex() for b in st['boards']]))
            else:
                st['canonical'] = game.getCanonicalForm(st['board'], st['player'])
                remaining.append(st)
        active = remaining
        ply += 1
        assert ply < 100
    return records


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--rule', choices=('original', 'facing'), required=True)
    ap.add_argument('--output', default='first_move_balance_20261024')
    ap.add_argument('--model', type=Path)
    ap.add_argument('--sims', type=int, default=100)
    ap.add_argument('--games', type=int, default=16)
    ap.add_argument('--random-plies', type=int, default=6)
    ap.add_argument('--seed', type=int, default=2026102500)
    ap.add_argument('--ids', type=int, nargs='*')
    ap.add_argument('--two-ply-after', type=int, nargs='*', help='First-move ids; evaluate screened 2-ply openings instead')
    ap.add_argument('--keep', type=int, default=8)
    opts = ap.parse_args()
    assert opts.games % 8 == 0
    torch.set_num_threads(1)
    torch.manual_seed(0)
    out = Path(opts.output) / opts.rule
    out.mkdir(parents=True, exist_ok=True)
    snapshot = out / 'model.pth.tar'
    if not snapshot.exists():
        source = opts.model or Path('facing/temp/best.pth.tar' if opts.rule == 'facing' else 'temp/best.pth.tar')
        snapshot.write_bytes(source.read_bytes())
    data = snapshot.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    game = F.FacingGame() if opts.rule == 'facing' else GyeolGame()
    net = FacingNet(game) if opts.rule == 'facing' else NNetWrapper(game)
    net.nnet.load_state_dict(torch.load(io.BytesIO(data), map_location=net.device, weights_only=True)['state_dict'])
    net.nnet.eval()
    cache_transitions(game)
    target = out / (f'two_ply_{opts.sims}.json' if opts.two_ply_after else f'first_moves_{opts.sims}.json')
    settings = dict(rule=opts.rule, sims=opts.sims, random_plies=opts.random_plies,
                    seed=opts.seed, cpuct=1.5, root_noise=False, sha256=sha)
    if opts.two_ply_after:
        settings['two_ply_after'] = opts.two_ply_after
        settings['keep'] = opts.keep
    if target.exists():
        report = json.loads(target.read_text(encoding='utf-8'))
        assert report['settings'] == settings
    else:
        openings = (distinct_two_ply(game, net, opts.two_ply_after, opts.keep) if opts.two_ply_after
                    else distinct_first_moves(game))
        report = dict(settings=settings, openings=openings)
    root = game.getInitBoard()
    for op in report['openings']:
        child, p = start_of(game, op)
        op['description'] = ' / '.join(describe(opts.rule, a) for a in op.get('prefix', [op['action']]))
        op['value'] = p * float(net.predict(game.getCanonicalForm(child, p))[1])
    print('model', sha, 'distinct first moves', len(report['openings']), flush=True)
    started = time.monotonic()
    for op in report['openings']:
        if opts.ids and op['id'] not in opts.ids:
            continue
        done = {r['game_index'] for r in op.get('records', [])}
        pending = [i for i in range(opts.games) if i not in done]
        if not pending:
            continue
        op.setdefault('records', []).extend(play_batch(game, net, opts, op, pending))
        op['records'].sort(key=lambda r: r['game_index'])
        op['summary'] = summary(op['records'])
        save(target, report)
        print('opening', op['id'], op['description'], op['summary'],
              'seconds', round(time.monotonic() - started), flush=True)
    save(target, report)
    print('DONE', target, flush=True)


if __name__ == '__main__':
    main()
