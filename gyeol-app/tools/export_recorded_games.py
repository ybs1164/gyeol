"""실제로 저장된 facing 대국만 재현·검사해서 퍼즐 원본으로 보관한다."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
AI = ROOT.parent / 'gyeol_ai'
sys.path.insert(0, str(AI))
from facing import rules as F
from gyeol import GyeolLogic as L
import numpy as np

OUT = ROOT / 'tools' / 'record-puzzles'
OUT.mkdir(parents=True, exist_ok=True)
games, rejected, files = [], [], []

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def canonical_key(board):
    return min(L.recenter(L.transform_board(board, s)).tobytes() for s in L.SYMMETRIES).hex()

def accept(source, index, initial, actions, winner, margin=None, trajectory=None, final=None, initial_player=1, boards=None, opening_proof=None):
    board, player = initial.copy(), initial_player
    try:
        for ply, action in enumerate(actions):
            assert L.game_result(board, player) == 0, f'continued after end at {ply}'
            assert F.valid_vector(board, player)[action], f'illegal action at {ply}'
            if trajectory is not None:
                assert canonical_key((board * player).astype(np.int8)) == trajectory[ply], f'trajectory mismatch at {ply}'
            if boards is not None:
                assert np.array_equal(board, np.asarray(boards[ply])), f'board mismatch at {ply}'
            board = F.apply_move(board, player, action)
            player = -player
        assert L.game_result(board, 1) in (-1, 1), 'not a complete decisive game'
        assert int(L.game_result(board, 1)) == winner, 'winner mismatch'
        actual_margin = int(np.sign(board).sum())
        if margin is not None:
            assert actual_margin == margin, 'margin mismatch'
        if final is not None:
            assert np.array_equal(board, np.asarray(final)), 'final board mismatch'
        record = dict(source=source, sourceIndex=index, initial=initial.reshape(-1).astype(int).tolist(), initialPlayer=initial_player,
                      moves=actions, winner=winner, margin=actual_margin)
        if opening_proof is not None:
            record['openingProof'] = opening_proof
        record['hash'] = digest(record)
        record['id'] = 'game-' + record['hash'][:16]
        games.append(record)
    except (AssertionError, IndexError, ValueError) as error:
        rejected.append(dict(source=source, sourceIndex=index, reason=str(error)))

for folder in [AI / 'facing_balance_20261024' / 'facing', AI / 'rule_balance_20261023' / 'facing']:
    for path in sorted(folder.glob('selfplay_*.json')):
        raw = path.read_bytes()
        data = json.loads(raw)
        if data['settings']['rule'] != 'facing':
            continue
        source = path.relative_to(ROOT.parent).as_posix()
        files.append(dict(path=source, sha256=hashlib.sha256(raw).hexdigest(), records=len(data['records'])))
        for record in data['records']:
            opening = L.recenter(L.transform_board(L.initial_board(), L.SYMMETRIES[record['orientation']]))
            accept(source, record['game_index'], opening, record['actions'], int(record['result']),
                   record['margin'], record['trajectory'], record['final_board'])

for relative in [
    'first_move_balance_20261024/facing/first_moves_100.json',
    'first_move_balance_20261024/facing/two_ply_100.json',
    'first_move_balance_20261024/confirm/facing/two_ply_100.json',
]:
    path = AI / relative
    raw = path.read_bytes()
    data = json.loads(raw)
    source = path.relative_to(ROOT.parent).as_posix()
    files.append(dict(path=source, sha256=hashlib.sha256(raw).hexdigest(), records=sum(len(o.get('records', [])) for o in data['openings'])))
    for opening in data['openings']:
        if not opening.get('records'):
            continue
        prefix = opening.get('prefix', [opening['action']])
        start, first_player = L.initial_board(), 1
        for action in prefix:
            start = F.apply_move(start, first_player, action)
            first_player = -first_player
        for record in opening['records']:
            sym = record['orientation']
            initial = L.recenter(L.transform_board(start, L.SYMMETRIES[sym]))
            assert np.array_equal(initial, np.asarray(record['boards'][0])), 'opening prefix mismatch'
            accept(source, f"{opening['id']}/{record['game_index']}", initial, record['actions'], int(record['result']),
                   record['margin'], final=record['boards'][-1], initial_player=first_player, boards=record['boards'],
                   opening_proof=dict(prefix=prefix, orientation=sym))

online = ROOT / 'packages' / 'server' / 'data' / 'gyeol.json'
if online.exists():
    data = json.loads(online.read_text(encoding='utf-8'))
    for record in data['games'].values():
        if record['status'] == 'finished' and record.get('endReason') == 'normal':
            accept('online-record', record['id'], L.initial_board(), record['moves'], record['winner'])

assert games, 'No verified recorded games'
payload = dict(schema=2, rule='facing-25', games=games, sources=files, rejected=rejected,
               policy='Only existing completed AI self-play or online records; no random position synthesis.')
(OUT / 'source-games.json').write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(json.dumps(dict(accepted=len(games), rejected=len(rejected), sources=files, rejection_examples=rejected[:3]), indent=2))
assert not rejected, 'A source replay failed; inspect before mining puzzles'
