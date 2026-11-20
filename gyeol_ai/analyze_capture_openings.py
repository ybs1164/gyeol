"""Replay facing-free-start games and count turns with at least one capture."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'facing-free-start'))
from facing_free_game import FacingFreeStartGame
from gyeol import GyeolLogic as L
import numpy as np


def key(board):
    return min(L.recenter(L.transform_board(board, s)).tobytes() for s in L.SYMMETRIES).hex()


def replay(game, board, actions, result, final_board=None):
    player = 1
    captures = []
    placements = 0
    for action in actions:
        action = int(action)
        assert not game.getGameEnded(board, player)
        assert game.getValidMoves(board, player)[action]
        setup = np.count_nonzero(board) < 2
        own = int(np.count_nonzero(board * player > 0))
        enemy = int(np.count_nonzero(board * player < 0))
        moved, next_player = game.getNextState(board, player, action)
        if not setup:
            placed = action != game.regular_action_size - 1
            captured = int(np.count_nonzero(moved * player > 0)) - own - int(placed)
            assert captured >= 0
            assert enemy - int(np.count_nonzero(moved * player < 0)) == captured
            captures.append(captured)
            placements += placed
        board, player = moved, next_player
    assert game.getGameEnded(board, 1) == result
    if final_board is not None:
        np.testing.assert_array_equal(board, np.array(final_board, dtype=np.int8))
    assert captures
    streak = longest = 0
    for captured in captures:
        streak = streak + 1 if captured else 0
        longest = max(longest, streak)
    return dict(turns=len(captures), placements=int(placements),
                capture_turns=sum(c > 0 for c in captures), captured_tiles=sum(captures),
                first_capture_turn=next((i + 1 for i, c in enumerate(captures) if c), None),
                first_six_capture_turns=sum(c > 0 for c in captures[:6]),
                longest_capture_streak=longest, captures_by_turn=captures,
                first_won=result == 1)


def summarize(records):
    games = len(records)
    turns = sum(r['turns'] for r in records)
    capture_turns = sum(r['capture_turns'] for r in records)
    placements = sum(r['placements'] for r in records)
    frequencies = np.array([r['capture_turns'] / r['turns'] for r in records])
    first = [r['first_capture_turn'] for r in records if r['first_capture_turn'] is not None]
    return dict(games=games, turns=turns, capture_turns=capture_turns,
                capture_turn_rate=capture_turns / turns,
                capture_per_placement=capture_turns / placements,
                mean_game_capture_rate=float(frequencies.mean()),
                game_capture_rate_standard_error=float(frequencies.std(ddof=1) / np.sqrt(games)) if games > 1 else None,
                mean_capture_turns=capture_turns / games,
                mean_captured_tiles=sum(r['captured_tiles'] for r in records) / games,
                mean_first_capture_turn=float(np.mean(first)) if first else None,
                games_without_capture=games - len(first),
                mean_first_six_capture_turns=sum(r['first_six_capture_turns'] for r in records) / games,
                mean_longest_capture_streak=sum(r['longest_capture_streak'] for r in records) / games,
                first_win_rate=sum(r['first_won'] for r in records) / games)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--experiments', type=Path, nargs='+', required=True)
    parser.add_argument('--training-log', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    opts = parser.parse_args()
    opts.output.mkdir(parents=True, exist_ok=True)
    game = FacingFreeStartGame()
    catalog = {}
    groups = []
    for path in opts.experiments:
        data = path.read_bytes()
        experiment = json.loads(data)
        assert experiment['complete']
        assert experiment['settings']['rule'] == 'facing-free-start'
        for e in experiment['screen']:
            catalog[key(np.array(e['board'], dtype=np.int8))] = e
        entries = []
        for e in experiment['openings']:
            records = []
            for rec in e['records']:
                board = L.recenter(L.transform_board(np.array(e['board'], dtype=np.int8),
                                                      L.SYMMETRIES[rec['orientation']]))
                metrics = replay(game, board, rec['actions'], rec['result'], rec['final_board'])
                records.append(dict(game_index=rec['game_index'], **metrics))
            entries.append(dict(id=e['id'], board=e['board'], summary=summarize(records), records=records))
        entries.sort(key=lambda e: (-e['summary']['capture_turn_rate'], e['id']))
        groups.append(dict(source=str(path), source_sha256=hashlib.sha256(data).hexdigest(),
                           model_sha256=experiment['sha256'], settings=experiment['settings'], openings=entries))
    training = None
    if opts.training_log:
        data = opts.training_log.read_bytes()
        rows = data.decode('utf-8').splitlines()
        collected = defaultdict(list)
        skipped_partial = random_games = 0
        for i, line in enumerate(rows):
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                assert i == len(rows) - 1
                skipped_partial += 1
                continue
            if row['random_opponent'] is not None:
                random_games += 1
                continue
            opening_key = key(np.array(row['opening'], dtype=np.int8))
            assert opening_key == row['opening_key'] and opening_key in catalog
            metrics = replay(game, game.getInitBoard(), row['actions'], row['result'])
            collected[catalog[opening_key]['id']].append(metrics)
        training = dict(source=str(opts.training_log), source_sha256=hashlib.sha256(data).hexdigest(),
                        partial_lines_skipped=skipped_partial, random_opponent_games_excluded=random_games,
                        warning='Exploratory only: training checkpoints and game sampling change across records.',
                        openings=sorted([dict(id=cid, summary=summarize(records)) for cid, records in collected.items()],
                                        key=lambda e: (-e['summary']['capture_turn_rate'], e['id'])))
        (opts.output / 'training_snapshot.jsonl').write_bytes(data)
    report = dict(metric='turns with >= 1 captured tile / regular turns, including passes; exclude setup',
                  fixed_model_groups=groups, training=training)
    (opts.output / 'capture_metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    for group in groups:
        print('EXPERIMENT', group['source'])
        for e in group['openings'][:12]:
            print(e['id'], e['summary'])
    if training:
        print('TRAINING coverage', len(training['openings']), 'games',
              sum(e['summary']['games'] for e in training['openings']))
        for e in [e for e in training['openings'] if e['summary']['games'] >= 8][:12]:
            print(e['id'], e['summary'])


if __name__ == '__main__':
    main()
