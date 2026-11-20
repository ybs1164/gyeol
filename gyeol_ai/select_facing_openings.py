"""Compare specified two-tile layouts with one frozen checkpoint."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'facing-free-start'))
spec = importlib.util.spec_from_file_location('facing_opening_helpers', ROOT / 'facing-free-start/evaluate.py')
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)

import torch
from opening_fast_mcts import OpeningFastMCTS
from evaluate_rule_balance import cache_transitions, provenance, save
from validate_fair_opening import summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True,
                        help='Folder containing the frozen model and screen.json from evaluate.py')
    parser.add_argument('--model', type=Path, help='Source checkpoint for a new output folder')
    parser.add_argument('--model-kind', choices=['facing-free-start', 'facing', 'original'], default='facing-free-start')
    parser.add_argument('--label', required=True)
    parser.add_argument('--ids', type=int, nargs='+', required=True)
    parser.add_argument('--games', type=int, default=16)
    parser.add_argument('--sims', type=int, default=100)
    parser.add_argument('--seed', type=int, default=2026102600)
    parser.add_argument('--batch-size', type=int, default=32)
    opts = parser.parse_args()
    if (opts.games < 8 or opts.games % 8 or opts.sims < 2 or opts.batch_size < 1
            or len(set(opts.ids)) != len(opts.ids) or Path(opts.label).name != opts.label):
        parser.error('Require games divisible by 8, sims >= 2, distinct IDs and a filename label')
    torch.set_num_threads(1)
    torch.manual_seed(0)
    if not (opts.output / 'model.pth.tar').exists():
        if opts.model is None:
            parser.error('A new output folder requires --model')
        opts.output.mkdir(parents=True, exist_ok=True)
        provenance(opts.model, opts.output)
    snapshot = (opts.output / 'model.pth.tar').read_bytes()
    digest = hashlib.sha256(snapshot).hexdigest()
    if opts.model_kind == 'facing':
        from facing.rules import FacingGame
        from facing.network import FacingNet
        game = FacingGame()
        game.regular_action_size = game.getActionSize()
        net = FacingNet(game)
    elif opts.model_kind == 'original':
        from gyeol.GyeolGame import GyeolGame
        from gyeol.pytorch.NNet import NNetWrapper
        game = GyeolGame()
        game.regular_action_size = game.getActionSize()
        net = NNetWrapper(game)
    else:
        game = evaluation.FacingFreeStartGame()
        net = evaluation.FacingFreeStartNet(game)
    net.nnet.load_state_dict(torch.load(io.BytesIO(snapshot), map_location=net.device,
                                        weights_only=True)['state_dict'])
    net.nnet.eval()
    screen_path = opts.output / 'screen.json'
    if screen_path.exists():
        screened = json.loads(screen_path.read_text(encoding='utf-8'))
        source_path = opts.output / 'results.json'
        if not source_path.exists():
            source_path = opts.output / 'model_metadata.json'
        source = json.loads(source_path.read_text(encoding='utf-8'))
        if source['sha256'] != digest:
            parser.error('Frozen model does not match the screening checkpoint')
    else:
        screened = evaluation.screen(evaluation.FacingFreeStartGame(), net)
        save(screen_path, screened)
    if any(i < 0 or i >= len(screened) for i in opts.ids):
        parser.error('Unknown layout ID')
    evaluation.MCTS = OpeningFastMCTS
    cache_transitions(game)
    settings = dict(games=opts.games, sims=opts.sims, seed=opts.seed, ids=opts.ids,
                    random_plies=6, cpuct=1.5, root_noise=False, rule=opts.model_kind,
                    search='OpeningFastMCTS')
    report = dict(sha256=digest, settings=settings, screen=screened,
                  openings=[dict(**screened[i], records=[]) for i in opts.ids])
    target = opts.output / (opts.label + '.json')
    if target.exists():
        report = json.loads(target.read_text(encoding='utf-8'))
        if report['sha256'] != digest or report['settings'] != settings:
            parser.error('Existing label has different settings')
    tasks = [(entry, gi) for entry in report['openings'] for gi in range(opts.games)
             if gi not in {r['game_index'] for r in entry['records']}]
    started = time.monotonic()
    for offset in range(0, len(tasks), opts.batch_size):
        evaluation.play_batch(game, net, tasks[offset:offset + opts.batch_size], opts.sims, opts.seed)
        for entry in report['openings']:
            if entry['records']:
                entry['records'].sort(key=lambda r: r['game_index'])
                entry['summary'] = summary(entry['records'])
                evaluation.audit(game, entry)
        report['complete'] = all(len(e['records']) == opts.games for e in report['openings'])
        save(target, report)
        print('completed', offset + len(tasks[offset:offset + opts.batch_size]), '/', len(tasks),
              'seconds', round(time.monotonic() - started),
              [(e['id'], e.get('summary', {}).get('first_win_rate')) for e in report['openings']],
              flush=True)
    assert all(len(e['records']) == opts.games for e in report['openings'])
    for entry in report['openings']:
        evaluation.audit(game, entry)
        assert {r['game_index'] for r in entry['records']} == set(range(opts.games))
        assert all(sum(r['orientation'] == sym for r in entry['records']) == opts.games // 8
                   for sym in range(8))
    report['complete'] = True
    save(target, report)


if __name__ == '__main__':
    main()
