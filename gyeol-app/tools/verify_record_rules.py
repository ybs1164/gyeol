"""Python 원본 facing 규칙과 모든 퍼즐 풀이 노드의 합법수·전이·종료 판정을 대조한다."""
import hashlib
import json
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / 'gyeol_ai'))
from facing import rules as F
from gyeol import GyeolLogic as L

data = json.load(sys.stdin)
verified = ROOT / 'tools/record-puzzles/verified.json'
assert hashlib.sha256(verified.read_bytes()).hexdigest() == data['puzzleSha256']
transitions = 0
for key, moves in data['states']:
    board = np.array([int(v) - 5 for v in key], dtype=np.int8).reshape(7, 7)
    expected_legal = set(int(a) for a in np.flatnonzero(F.valid_vector(board, 1)))
    assert {a for a, _, _ in moves} == expected_legal, 'Legal move set mismatch'
    for action, expected_key, expected_result in moves:
        child = F.apply_move(board, 1, action)
        actual_key = ''.join(str(int(v) + 5) for v in (-child).reshape(-1))
        assert actual_key == expected_key, 'Rule transition mismatch'
        assert L.game_result(child, -1) == expected_result, 'Terminal result mismatch'
        transitions += 1
report = dict(passed=True, puzzleSha256=data['puzzleSha256'], states=len(data['states']), transitions=transitions,
              method='All stored puzzle proof nodes cross-checked against independent Python facing rules: legal actions, child boards, terminal outcomes.')
(ROOT / 'tools/record-puzzles/rule-check-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
