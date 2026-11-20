"""Reproducible, frozen-network first-player evaluation for both Gyeol rules."""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import time

import numpy as np
import torch

from facing.network import FacingNet
from facing import rules as F
from find_fair_opening import key, search
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper
from MCTS import MCTS
from utils import dotdict
from validate_fair_opening import summary
from validate_fair_opening_batch import DeferredNet, simulations


def save(path, obj):
    pending = path.with_suffix('.pending')
    pending.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')
    pending.replace(path)


def describe(rule, action):
    return L.action_to_str(F.base_action(action) if rule == 'facing' else action)


def cache_transitions(game):
    """Reuse immutable child boards; no change to move/search calculations."""
    original_next = game.getNextState
    cache = {}

    def next_state(board, player, action):
        entry = (board.tobytes(), int(player), int(action))
        if entry not in cache:
            cache[entry] = original_next(board, player, action)
        return cache[entry]

    game.getNextState = next_state
    game.clear_transition_cache = cache.clear


def provenance(source, out):
    target = out / 'model.pth.tar'
    meta_path = out / 'model_metadata.json'
    if target.exists():
        data = target.read_bytes()
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
        assert hashlib.sha256(data).hexdigest() == meta['sha256']
        return data, meta
    data = source.read_bytes()
    # Deserialize the exact bytes before saving a snapshot of a live training file.
    torch.load(io.BytesIO(data), map_location='cpu', weights_only=True)
    target.write_bytes(data)
    metrics = source.parent / 'training_metrics.jsonl'
    rows = []
    if metrics.exists():
        for line in metrics.read_text(encoding='utf-8').splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # A running trainer can leave its final line incomplete.
    matching = []
    for row in rows:
        candidate = source.parent / row.get('candidate', '__missing__')
        if candidate.exists() and hashlib.sha256(candidate.read_bytes()).digest() == hashlib.sha256(data).digest():
            matching.append({k: row.get(k) for k in (
                'run_id', 'iteration', 'candidate', 'accepted', 'new_wins', 'previous_wins',
                'unique_games', 'validation_suite', 'validation_suite_games')})
    meta = dict(source=str(source.resolve()), sha256=hashlib.sha256(data).hexdigest(),
                captured_utc=datetime.now(timezone.utc).isoformat(),
                training_log_rows=len(rows), matching_training_records=matching)
    save(meta_path, meta)
    return data, meta


def diagnostics(game, net, rule):
    board = game.getInitBoard()
    pi, value = net.predict(board)
    valid = game.getValidMoves(board, 1)
    pi = pi * valid
    pi /= pi.sum()
    openings = []
    for action in np.flatnonzero(valid):
        child, player = game.getNextState(board, 1, int(action))
        replies = []
        for reply in np.flatnonzero(game.getValidMoves(child, player)):
            final, _ = game.getNextState(child, player, int(reply))
            captured = (np.count_nonzero(final < 0) - np.count_nonzero(child < 0) - 1)
            replies.append(dict(action=int(reply), captured=int(captured)))
        openings.append(dict(action=int(action), description=describe(rule, int(action)),
                             prior=float(pi[action]),
                             first_value=-float(net.predict(-child)[1]),
                             reply_count=len(replies),
                             capturing_replies=sum(r['captured'] > 0 for r in replies),
                             max_reply_capture=max(r['captured'] for r in replies)))
    searches = []
    for sims in (100, 800, 3200):
        entry = search(game, net, board, sims, uniform=0)
        entry.update(sims=sims, description=describe(rule, entry['best_action']))
        searches.append(entry)
        print('root', rule, entry, flush=True)
    return dict(value=float(value), legal_moves=int(valid.sum()), openings=openings,
                symmetry_values=[float(net.predict(L.recenter(L.transform_board(board, s)))[1])
                                 for s in L.SYMMETRIES], searches=searches)


def play_batch(game, net, opts, indices):
    game.clear_transition_cache()
    active = []
    for gi in indices:
        board = L.recenter(L.transform_board(game.getInitBoard(), L.SYMMETRIES[gi % 8]))
        proxy = DeferredNet()
        tree = MCTS(game, proxy, dotdict(numMCTSSims=opts.sims, cpuct=1.5, dirichletAlpha=0))
        tree.root_prior = tree.root_noise = None
        active.append(dict(gi=gi, board=board, canonical=board, player=1, proxy=proxy,
                           tree=tree, rng=np.random.RandomState(opts.seed + gi),
                           actions=[], trajectory=[]))
    records = []
    ply = 0
    while active:
        simulations(active, net, opts.sims)
        remaining = []
        for st in active:
            state_key = game.stringRepresentation(st['canonical'])
            counts = np.array([st['tree'].Nsa.get((state_key, a), 0)
                               for a in range(game.getActionSize())], dtype=float)
            assert counts.sum() > 0
            if ply < opts.random_plies:
                action = int(st['rng'].choice(len(counts), p=counts / counts.sum()))
            else:
                action = int(st['rng'].choice(np.flatnonzero(counts == counts.max())))
            assert game.getValidMoves(st['board'], st['player'])[action]
            st['actions'].append(action)
            st['trajectory'].append(key(st['canonical']).hex())
            st['board'], st['player'] = game.getNextState(st['board'], st['player'], action)
            result = game.getGameEnded(st['board'], 1)
            if result:
                records.append(dict(game_index=st['gi'], seed=opts.seed + st['gi'],
                    orientation=st['gi'] % 8, result=float(result),
                    margin=int(np.sign(st['board']).sum()),
                    first_tiles=int(np.count_nonzero(st['board'] > 0)),
                    second_tiles=int(np.count_nonzero(st['board'] < 0)),
                    passes=st['actions'].count(game.getActionSize() - 1),
                    actions=st['actions'], trajectory=st['trajectory'],
                    final_board=st['board'].tolist()))
            else:
                st['canonical'] = game.getCanonicalForm(st['board'], st['player'])
                remaining.append(st)
        active = remaining
        ply += 1
        assert ply < 100
        if ply % 8 == 0:
            print('progress', opts.rule, opts.sims, indices[0], 'ply', ply,
                  'active', len(active), flush=True)
    return records


def random_baseline(game, games, seed):
    records = []
    for gi in range(games):
        rng = np.random.RandomState(seed + gi)
        board, player = game.getInitBoard(), 1
        actions = []
        trajectory = []
        while not game.getGameEnded(board, 1):
            action = int(rng.choice(np.flatnonzero(game.getValidMoves(board, player))))
            actions.append(action)
            # No neural tree or symmetry key is needed for this weak-play reference.
            trajectory.append(board.tobytes().hex())
            board, player = game.getNextState(board, player, action)
            assert len(actions) < 100
        records.append(dict(game_index=gi, seed=seed + gi,
            result=float(game.getGameEnded(board, 1)), margin=int(np.sign(board).sum()),
            passes=actions.count(game.getActionSize() - 1), actions=actions, trajectory=trajectory))
    return dict(seed=seed, summary=summary(records), records=records)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rule', choices=('original', 'facing'), required=True)
    parser.add_argument('--output', default='rule_balance_20261023')
    parser.add_argument('--model', type=Path, help='Explicit checkpoint for a new output folder')
    parser.add_argument('--sims', type=int, default=100)
    parser.add_argument('--games', type=int, default=128)
    parser.add_argument('--batch-size', type=int, default=16)
    parser.add_argument('--random-plies', type=int, default=6)
    parser.add_argument('--seed', type=int, default=2026102300)
    parser.add_argument('--random-games', type=int, default=1000)
    opts = parser.parse_args()
    if opts.sims < 2 or opts.games < 8 or opts.games % 8 or opts.batch_size < 1:
        parser.error('Require sims >= 2, games >= 8 divisible by 8, batch-size >= 1')
    torch.set_num_threads(1)
    torch.manual_seed(0)
    out = Path(opts.output) / opts.rule
    out.mkdir(parents=True, exist_ok=True)
    source = opts.model or Path('facing/temp/best.pth.tar' if opts.rule == 'facing' else 'temp/best.pth.tar')
    data, meta = provenance(source, out)
    if opts.model is not None:
        assert hashlib.sha256(source.read_bytes()).hexdigest() == meta['sha256'], 'Output folder already has a different frozen model'
    game = F.FacingGame() if opts.rule == 'facing' else GyeolGame()
    net = FacingNet(game) if opts.rule == 'facing' else NNetWrapper(game)
    net.nnet.load_state_dict(torch.load(io.BytesIO(data), map_location=net.device, weights_only=True)['state_dict'])
    net.nnet.eval()
    cache_transitions(game)
    print('model', opts.rule, meta, flush=True)
    if not (out / 'diagnostics.json').exists():
        save(out / 'diagnostics.json', diagnostics(game, net, opts.rule))
    if opts.random_games and not (out / 'random_baseline.json').exists():
        baseline = random_baseline(game, opts.random_games, opts.seed + 100000)
        save(out / 'random_baseline.json', baseline)
        print('random', baseline['summary'], flush=True)
    target = out / f'selfplay_{opts.sims}_temp{opts.random_plies}.json'
    settings = dict(rule=opts.rule, sims=opts.sims, random_plies=opts.random_plies,
                    seed=opts.seed, cpuct=1.5, root_noise=False, sha256=meta['sha256'])
    report = dict(settings=settings, target_games=opts.games, records=[])
    if target.exists():
        report = json.loads(target.read_text(encoding='utf-8'))
        assert report['settings'] == settings
    report['target_games'] = opts.games
    completed = {r['game_index'] for r in report['records']}
    pending = [i for i in range(opts.games) if i not in completed]
    started = time.monotonic()
    for offset in range(0, len(pending), opts.batch_size):
        report['records'].extend(play_batch(game, net, opts, pending[offset:offset + opts.batch_size]))
        report['records'].sort(key=lambda r: r['game_index'])
        report['summary'] = summary(report['records'])
        report['orientation_summaries'] = {
            str(o): summary([r for r in report['records'] if r['orientation'] == o])
            for o in range(8) if any(r['orientation'] == o for r in report['records'])}
        report['elapsed_seconds_this_run'] = time.monotonic() - started
        save(target, report)
        print('summary', opts.rule, opts.sims, report['summary'],
              'seconds', round(time.monotonic() - started, 1), flush=True)
    print('DONE', target, flush=True)


if __name__ == '__main__':
    main()
