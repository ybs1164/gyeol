"""Audit and summarize a frozen facing-model balance evaluation."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform

import numpy as np
import torch

from facing.rules import FacingGame
from find_fair_opening import key
from gyeol import GyeolLogic as L
from report_rule_balance import audit, read


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('facing_balance_20261024'))
    opts = parser.parse_args()
    folder = opts.output / 'facing'
    meta = read(folder / 'model_metadata.json')
    digest = hashlib.sha256((folder / 'model.pth.tar').read_bytes()).hexdigest()
    assert digest == meta['sha256']
    diag = read(folder / 'diagnostics.json')
    game = FacingGame()
    assert diag['legal_moves'] == 9
    assert all(o['reply_count'] == 18 and o['capturing_replies'] == 0 for o in diag['openings'])
    tactics = []
    initial = game.getInitBoard()
    for action in np.flatnonzero(game.getValidMoves(initial, 1)):
        child, player = game.getNextState(initial, 1, int(action))
        best_captures = []
        for reply in np.flatnonzero(game.getValidMoves(child, player)):
            board, next_player = game.getNextState(child, player, int(reply))
            maximum = 0
            for move in np.flatnonzero(game.getValidMoves(board, next_player)):
                final, _ = game.getNextState(board, next_player, int(move))
                maximum = max(maximum, int(np.count_nonzero(final > 0) - np.count_nonzero(board > 0) - 1))
            best_captures.append(maximum)
        assert best_captures == [1] * 18
        tactics.append(dict(action=int(action), first_can_capture_on_third=sum(x > 0 for x in best_captures),
                            reply_count=len(best_captures), max_capture_on_third=max(best_captures)))
    (opts.output / 'third_ply_tactics.json').write_text(json.dumps(tactics, indent=2), encoding='utf-8')
    experiments, audits, details = [], {}, {}
    for path in sorted(folder.glob('selfplay_*.json')):
        exp = read(path)
        assert exp['settings']['sha256'] == digest
        audits[path.name] = audit(game, exp)
        experiments.append(exp)
        opening_groups = {}
        full_boards = 0
        placements = Counter()
        captures = Counter()
        for rec in exp['records']:
            board = L.recenter(L.transform_board(game.getInitBoard(), L.SYMMETRIES[rec['orientation']]))
            player = 1
            opening = None
            game_placements = Counter()
            game_captures = Counter()
            for i, action in enumerate(rec['actions']):
                assert key(game.getCanonicalForm(board, player)).hex() == rec['trajectory'][i]
                moved, next_player = game.getNextState(board, player, action)
                if action != game.getActionSize() - 1:
                    captured = int(np.count_nonzero(moved * player > 0) - np.count_nonzero(board * player > 0) - 1)
                    assert captured >= 0
                    game_placements[player] += 1
                    game_captures[player] += captured
                board, player = moved, next_player
                if i == 0:
                    opening = key(board).hex()
            assert rec['margin'] == game_placements[1] - game_placements[-1] + 2 * (game_captures[1] - game_captures[-1])
            placements.update(game_placements)
            captures.update(game_captures)
            assert rec['passes'] == rec['actions'].count(game.getActionSize() - 1)
            full_boards += int(np.count_nonzero(board) == 25)
            opening_groups.setdefault(opening, []).append(rec['result'])
        margins = np.array([r['margin'] for r in exp['records']], dtype=float)
        details[path.name] = dict(
            full_boards=full_boards,
            margin_counts=dict(Counter(map(int, margins))),
            margin_standard_error=float(margins.std(ddof=1) / np.sqrt(len(margins))),
            mean_first_placement_advantage=(placements[1] - placements[-1]) / len(margins),
            mean_first_net_captures=(captures[1] - captures[-1]) / len(margins),
            opening_groups={k: dict(games=len(v), first_wins=v.count(1), second_wins=v.count(-1))
                            for k, v in opening_groups.items()},
            orientation_summaries=exp['orientation_summaries'])
    assert experiments, 'No completed experiments found'
    sources = ['evaluate_rule_balance.py', 'report_facing_balance.py', 'report_rule_balance.py',
               'MCTS.py', 'facing/rules.py', 'facing/network.py', 'gyeol/GyeolLogic.py',
               'gyeol/GyeolGame.py', 'gyeol/pytorch/NNet.py', 'gyeol/pytorch/GyeolNNet.py',
               'validate_fair_opening_batch.py', 'validate_fair_opening.py', 'find_fair_opening.py']
    data = dict(created_utc=datetime.now(timezone.utc).isoformat(), model_sha256=digest,
                experiments=audits, details=details, verified_opening_reply_pairs=162,
                environment=dict(python=platform.python_version(), numpy=np.__version__, torch=torch.__version__),
                source_sha256={p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in sources})
    (opts.output / 'audit.json').write_text(json.dumps(data, indent=2), encoding='utf-8')
    randomized = sorted((e for e in experiments if e['settings']['random_plies']),
                        key=lambda e: e['settings']['sims'])
    strict = [e for e in experiments if not e['settings']['random_plies']]
    if randomized and all(e['summary']['wilson_95'][0] > .5 for e in randomized):
        conclusion = '현재 가중치에서는 측정한 모든 탐색량에서 선공 우세가 뚜렷하다. 모든 선공 승률의 95% 구간 하한이 50%를 넘는다.'
    elif randomized and all(e['summary']['wilson_95'][1] < .5 for e in randomized):
        conclusion = '현재 가중치에서는 측정한 모든 탐색량에서 후공 우세가 뚜렷하다. 모든 선공 승률의 95% 구간 상한이 50%보다 낮다.'
    else:
        conclusion = '탐색 조건에 따라 추정치 또는 불확실성이 달라 선후공 우세를 한 방향으로 단정하기 어렵다.'
    lines = ['# 현재 facing 가중치의 선후공 분석 — 2026-10-24', '',
             conclusion, '',
             f"대상: `facing/temp/best.pth.tar`, SHA-256 `{digest}`. 분석 시작 때 복사한 `facing/model.pth.tar`를 모든 실험에서 사용했다.", '',
             '같은 모델이 선공과 후공 모두를 맡았다. 초기 배치는 초록 → / 갈색 ← 두 장이며 초록이 먼저 둔다. 새 타일은 방금 돌린 상대 타일을 바라본다.', '',
             '## 동일 가중치 자가대국', '',
             '| 수당 MCTS | 대국 수 | 선공 승 | 후공 승 | 선공 승률 | 선공 승률 95% 구간 | 선공 평균 타일 차 |',
             '|---:|---:|---:|---:|---:|---:|---:|']
    for exp in randomized:
        s = exp['summary']
        lo, hi = s['wilson_95']
        lines.append(f"| {exp['settings']['sims']} | {s['games']} | {s['first_wins']} | {s['second_wins']} | {s['first_win_rate']:.1%} | {lo:.1%}–{hi:.1%} | {s['mean_margin']:+.3f}장 |")
    lines += ['', '첫 6수는 MCTS 방문 비율대로 확률 선택하고 이후에는 최다 방문 수를 선택했다. 회전·반사 8개 변환을 균등 배분했다(서로 다른 초기 보드는 4개). 양쪽 탐색량 동일, cpuct=1.5, 루트 노이즈 없음. seed=2026102400+대국 번호. 탐색량별 결과는 합산하지 않는다.', '',
              '95% 구간은 해당 모델·초반 선택 방식 아래의 Wilson 이항 근사 구간이다. 방향별 성능 차이, 모델의 판단 오류, 최적 플레이와의 차이는 이 구간에 반영되지 않는다.', '',
              '## 초반 확률 선택 없는 확인 대국', '']
    for exp in strict:
        s = exp['summary']
        lines += [f"- MCTS {exp['settings']['sims']}회: {s['games']}국 중 선공 {s['first_wins']}승, 후공 {s['second_wins']}승, 무승부 {s['draws']}국. 선공 평균 타일 차 {s['mean_margin']:+.3f}장.",
                  f"- 대칭을 동일시한 고유 진행 {s['unique_trajectories']}종. 네 가지 초기 방향을 확인하는 진단이며 독립적인 대규모 승률 추정으로 해석하지 않는다."]
    lines += ['', '## 방향별 결과', '',
              '| 탐색 횟수 | 방향 변환 번호 | 선공 승 / 대국 수 | 선공 평균 타일 차 |',
              '|---:|---:|---:|---:|']
    for exp in randomized:
        for orientation, s in sorted(exp['orientation_summaries'].items()):
            lines.append(f"| {exp['settings']['sims']} | {orientation} | {s['first_wins']} / {s['games']} | {s['mean_margin']:+.2f} |")
    lines += ['', '## 초기 평가와 첫 수', '',
              f"신경망 초기 가치: {diag['value']:+.4f}. 서로 다른 보드 방향의 값 범위: {min(diag['symmetry_values']):+.4f}~{max(diag['symmetry_values']):+.4f}. 대칭 8개 값 평균: {np.mean(diag['symmetry_values']):+.4f}.", '',
              '| 초기 탐색 횟수 | 최다 방문 수 Q | 방문 가중 평균 Q | 탐색한 첫 수 |',
              '|---:|---:|---:|---:|']
    for s in diag['searches']:
        lines.append(f"| {s['sims']} | {s['best_q']:+.4f} | {s['mean_q']:+.4f} | {s['visited']}/{diag['legal_moves']} |")
    lines += ['', '값과 Q는 선공 관점의 -1~+1 승패 추정값이며 실측 승률이 아니다. 큰 양수는 선공을 좋게 평가한다는 뜻이다.', '',
              '기본 보드에서 추천 첫 수는 갈색 ←를 ↓로 돌리고 그 오른쪽에 초록 ←를 놓는 수(action 393)다. ↑로 돌리는 action 385는 이 수의 반사 대칭이다. 결과는 초록 → / 갈색 ↓ / 초록 ←의 일자 배치다.', '',
              '기본 보드 신경망 정책의 합법 수 내 비중:', '',
              '| 첫 수 | 정책 비중 | 첫 수 직후 선공 관점 가치 |',
              '|---|---:|---:|']
    for opening in sorted(diag['openings'], key=lambda o: -o['prior']):
        lines.append(f"| {opening['action']}: {opening['description']} | {opening['prior']:.2%} | {opening['first_value']:+.4f} |")
    lines += ['', '정책의 대부분은 일자 배치 두 수에 집중돼 있다. 3200회 탐색에서도 9개 중 3개 첫 수를 방문했으므로, 해당 탐색이 모든 첫 수의 최적 가치를 엄밀히 검증한 것은 아니다.', '',
              '합법 첫 수 9개와 각 첫 수에 대한 후공 응수 18개, 총 162개 조합을 전수 확인했다. 모든 경우 후공의 첫 응수에는 즉시 포획이 없고, 선공은 다음 자기 차례(전체 3수째)에 상대 1장을 포획할 수 있는 합법 수를 갖는다. `third_ply_tactics.json`에 기록했다. 초기 포획 기회가 있다는 사실이며 그 수가 최선이거나 이득이 유지된다는 증명은 아니다.', '',
              '선공이 기본 배치를 선택할 기회가 있으며, 패스 없이 25장이 차면 선공은 12회, 후공은 11회 놓고 선공이 마지막에 둔다. 이 사실들은 전략적 유불리의 가능성을 설명하지만 측정된 승률의 원인을 분리해 증명하지는 않는다.', '',
              '최종 타일 차이는 `놓은 타일 수 차이 + 2 × 포획 수 차이`로 분해된다(재포획 포함). 실측 평균은 다음과 같다. 이는 점수의 산술적 분해이며 인과 효과의 분리는 아니다.', '',
              '| 수당 탐색 | 선공의 놓은 수 우위 | 선공의 순포획 수 우위 | 최종 타일 차 |',
              '|---:|---:|---:|---:|']
    for exp in randomized:
        st = exp['settings']
        detail = details[f"selfplay_{st['sims']}_temp{st['random_plies']}.json"]
        lines.append(f"| {st['sims']} | {detail['mean_first_placement_advantage']:+.3f} | {detail['mean_first_net_captures']:+.3f} | {exp['summary']['mean_margin']:+.3f} |")
    lines += ['',
              '## 해석 범위', '',
              '이 결과는 현재 가중치와 위 MCTS 조건에서의 유불리다. 규칙 자체의 필승·필패, 충분히 학습된 최강 모델의 승률, 인간 대국의 승률은 확정할 수 없다. 초반 확률 선택 여부에 따라 서로 다른 경기 분포가 된다.', '',
              '이전 `rule_balance_20261023/facing` 평가의 가중치 해시는 `7995af9e4679ac85bf66e3bae598a1eaf02cebc038d9ccb351d102e0872c3e63`로 현재와 다르다. 이전 승률을 현재 가중치의 실측값으로 사용하거나 이번 결과와 합산하지 않는다.', '',
              '## 검증 및 재현', '',
              f"모든 {sum(a['games'] for a in audits.values())}국, {sum(a['moves'] for a in audits.values())}수를 재생해 합법성·종료·최종 보드·승패·타일 수·패스 수·대칭 정규화 진행 기록·seed·방향별 균등 배분을 검증했다. 환경과 분석 코드 해시는 `audit.json`에 저장했다.", '',
              '```powershell']
    for exp in experiments:
        st = exp['settings']
        lines.append(f"python evaluate_rule_balance.py --rule facing --output {opts.output.as_posix()} --sims {st['sims']} --games {exp['target_games']} --batch-size 16 --random-plies {st['random_plies']} --seed {st['seed']} --random-games 0")
    lines += [f"python report_facing_balance.py --output {opts.output.as_posix()}", '```', '',
              '같은 출력 폴더로 다시 실행하면 저장한 가중치와 완료된 대국을 재사용한다. 새로 재현하려면 다른 출력 폴더와 `--model facing_balance_20261024/facing/model.pth.tar`를 지정한다.']
    report = opts.output / 'REPORT.md'
    report.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps(audits, indent=2))
    print(report)


if __name__ == '__main__':
    main()
