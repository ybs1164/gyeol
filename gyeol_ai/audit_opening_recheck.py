"""Replay completed games and report opening evidence without changing training."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from validate_fair_opening import summary

sys.stdout.reconfigure(encoding='utf-8')

ap = argparse.ArgumentParser()
ap.add_argument('output')
ap.add_argument('--sims', type=int, help='Audit only this completed search budget')
args = ap.parse_args()
out = Path(args.output)
r = json.loads((out / 'results.json').read_text(encoding='utf-8'))
assert hashlib.sha256((out / 'model.pth.tar').read_bytes()).hexdigest() == r['sha256']
if args.sims is not None:
    r['experiments'] = [e for e in r['experiments'] if e['sims'] == args.sims]
    assert r['experiments'], 'Requested search budget not found'
game = GyeolGame()
b = np.array(r['board'], dtype=np.int8)
assert np.array_equal(b, game.getInitBoard())
tactics = []
for a in L.legal_moves(b, 1):
    child, p = game.getNextState(b, 1, a)
    replies = [game.getNextState(child, p, reply)[0] for reply in L.legal_moves(child, p)]
    tactics.append(dict(action=int(a), description=L.action_to_str(a),
        first_margin=int(np.sign(child).sum()), replies=len(replies),
        capturing_replies=int(sum(np.count_nonzero(x < 0) > 2 for x in replies))))
lines = ['# 오프닝 재분석 — 2026-10-19 시작', '',
    '배치: 초록 → / 갈색 ←, 초록 선공. 최신 모델을 복사해 고정하고 양쪽에 동일하게 사용했다.', '',
    '| 수당 탐색 | 대국 | 선공 승 | 후공 승 | 선공 승률 (95% Wilson 구간) | 평균 점수 차 |',
    '|---:|---:|---:|---:|---:|---:|']
for e in r['experiments']:
    assert len(e['records']) == e['games']
    last_first = 0
    final_lead_changes = 0
    for rec in e['records']:
        board = L.recenter(L.transform_board(b, L.SYMMETRIES[rec['orientation']]))
        player = 1
        for a in rec['actions']:
            assert game.getGameEnded(board, 1) == 0
            assert game.getValidMoves(board, player)[a]
            before_margin = int(np.sign(board).sum())
            last_player = player
            board, player = game.getNextState(board, player, a)
        assert game.getGameEnded(board, 1) == rec['result']
        assert int(np.sign(board).sum()) == rec['margin']
        last_first += last_player == 1
        final_lead_changes += before_margin * rec['margin'] < 0
    e['audit'] = dict(first_moved_last=last_first, final_move_lead_changes=final_lead_changes)
    s = summary(e['records'])
    assert s == e['summary']
    lo, hi = s['wilson_95']
    lines.append(f"| {e['sims']} | {s['games']} | {s['first_wins']} | {s['second_wins']} | {s['first_win_rate']:.1%} ({lo:.1%}–{hi:.1%}) | {s['mean_margin']:+.3f} |")
if all(e['summary']['wilson_95'][0] > .5 for e in r['experiments']):
    lines += ['', '판단: 검증한 모든 탐색량에서 현재 AI 기준 선공 우세를 뒷받침한다. 공정한 50:50 배치라고 판단하기 어렵다. 다만 선공 필승이나 정확한 게임 이론적 우위의 증명은 아니다.']
else:
    lines += ['', '판단: 탐색량별 승률과 불확실성을 각각 봐야 한다. 모든 실험에서 선공 우세가 통계적으로 뚜렷하다고 단정할 수는 없다. 선공 필승이나 정확한 게임 이론적 우위의 증명도 아니다.']
lines += ['', '첫 6수는 방문 비율로 추첨하고 이후에는 최대 방문 수를 선택했다. 회전·반사 8개 변환을 균등 배분했다. 탐색량별 결과는 합산하지 않는다. 구간은 이 모델과 대국 절차에 조건부인 근사치이며 최적 플레이나 인간 승률을 뜻하지 않는다.', '',
    '## 첫 수 탐색', '', '| 탐색 | 평균 Q | 추천 수 Q | 탐색된 첫 수 | 추천 |', '|---:|---:|---:|---:|---|']
for s in r['searches']:
    lines.append(f"| {s['sims']} | {s['mean_q']:+.4f} | {s['best_q']:+.4f} | {s['visited']}/{r['legal_moves']} | {s['description']} |")
lines += ['', 'Q는 신경망을 사용하는 탐색 평가이며 실측 승률이 아니다. 방문하지 않은 첫 수가 있으면 모든 첫 수의 비교나 최선 수 증명이 아니다.', '', '## 전술 및 검증', '']
for s in r['searches']:
    t = next(t for t in tactics if t['action'] == s['best_action'])
    lines.append(f"- {s['sims']}회 추천 뒤 후공 응수 {t['replies']}개 중 즉시 포획 가능 응수 {t['capturing_replies']}개.")
lines += [f"- 첫 수 {len(tactics)}개와 각각의 후공 응수를 전수 조사했다. 모든 첫 수의 점수 차: {sorted(set(t['first_margin'] for t in tactics))}.",
    f"- 후공의 즉시 포획 응수가 없는 첫 수는 {sum(t['capturing_replies'] == 0 for t in tactics)}개다. 즉시 포획 여부만으로 장기 유불리를 판단할 수 없다.",
    '- 저장된 모든 대국을 다시 재생해 합법성, 종료 결과, 점수 차와 집계를 검증했다.',
    f"- 시작 배치 대칭별 신경망 평가: {min(r['symmetry_values']):+.4f}~{max(r['symmetry_values']):+.4f}.",
    '- 패스가 없다면 선공은 추가 23수 중 12수를 두고 마지막 수를 둔다. 이것이 실제 우세를 얼마나 설명하는지는 별도로 검증하지 않았다.', '',
    f"고정 모델 SHA-256: `{r['sha256']}`", '',
    '기존 분석(다른 모델): 100회 탐색 45/64승, 200회 탐색 24/32승. 모델이 다르므로 승률 변화는 배치 자체의 공정성 변화가 아니다.']
lines += ['', '## 방향별 선공 승수 / 대국 수', '']
for e in r['experiments']:
    groups = []
    for orientation in range(8):
        records = [x for x in e['records'] if x['orientation'] == orientation]
        groups.append(f"{orientation}: {sum(x['result'] == 1 for x in records)}/{len(records)}")
    lines.append(f"- {e['sims']}회: " + ', '.join(groups))
    lines.append(f"  대칭 정규화 수순 종류: {e['summary']['unique_trajectories']}/{e['games']}")
    lines.append(f"  선공이 마지막 수를 둔 대국: {e['audit']['first_moved_last']}/{e['games']}; 마지막 수 직전 열세였던 쪽이 승리한 대국: {e['audit']['final_move_lead_changes']}/{e['games']} (직전 동점 제외, 인과 효과 추정 아님).")
lines += ['', '## 재현', '', '```powershell',
    f'python reanalyze_current_opening.py --resume --output {out.as_posix()} --deep-sims 200 --deep-games 32',
    f'python audit_opening_recheck.py {out.as_posix()}', '```', '',
    'results.json에 모델 해시, 초기 배치, 대국별 난수·방향·수순·결과를 저장했다. tactics.json은 첫 수별 즉시 응수 조사다. 기존 분석 폴더는 보존했다.']
(out / 'tactics.json').write_text(json.dumps(tactics, ensure_ascii=False, indent=2), encoding='utf-8')
(out / 'REPORT.md').write_text('\n'.join(lines), encoding='utf-8')
print('\n'.join(lines))
