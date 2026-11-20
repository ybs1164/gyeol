"""Audit the frozen opening experiment and export its chosen starting layout."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from select_facing_openings import evaluation
from evaluate_rule_balance import save
from find_fair_opening import key
from gyeol import GyeolLogic as L


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--recommend-id', type=int, choices=[8, 11], required=True)
    opts = parser.parse_args()
    out = opts.output
    pilot = json.loads((out / 'pilot.json').read_text(encoding='utf-8'))
    confirm = json.loads((out / 'confirm.json').read_text(encoding='utf-8'))
    digest = hashlib.sha256((out / 'model.pth.tar').read_bytes()).hexdigest()
    game = evaluation.FacingFreeStartGame()
    for report in (pilot, confirm):
        assert report['complete'] and report['sha256'] == digest
        for entry in report['openings']:
            evaluation.audit(game, entry)
            assert entry['summary'] == evaluation.summary(entry['records'])
            assert {r['game_index'] for r in entry['records']} == set(range(report['settings']['games']))
            assert all(sum(r['orientation'] == sym for r in entry['records']) == report['settings']['games'] // 8
                       for sym in range(8))
    recommended = next(e for e in confirm['openings'] if e['id'] == opts.recommend_id)
    gap = 2 if opts.recommend_id == 8 else 1
    setup_actions = [game.placement(0, 0, 1), game.placement(0, gap, 3)]
    board, player = game.getInitBoard(), 1
    for action in setup_actions:
        assert game.getValidMoves(board, player)[action]
        board, player = game.getNextState(board, player, action)
    assert player == 1 and key(board) == key(np.array(recommended['board'], dtype=np.int8))
    title = '한 칸 띄워 마주보기' if gap == 2 else '인접 마주보기'
    diagram = 'G→ ' + ('· ' if gap == 2 else '') + 'B←'
    artifact = dict(rule='facing-free-start', layout_id=opts.recommend_id, name=title,
                    model_sha256=digest, first_player='green', player_to_move=1,
                    green=dict(relative_position=[0, 0], direction='E'),
                    brown=dict(relative_position=[0, gap], direction='W'),
                    setup_actions=setup_actions, board=board.tolist(),
                    confirmation_settings=confirm['settings'], confirmation_summary=recommended['summary'])
    save(out / 'recommended_opening.json', artifact)
    lines = ['# 현재 facing-free-start 오프닝 추천 — 2026-10-26', '',
             f'추천: **{title} (배치 {opts.recommend_id})**.', '',
             '```text', diagram, '```', '',
             'G는 초록, B는 갈색이다. 두 초기 타일을 놓은 뒤 초록이 정규 첫 수를 둔다. '
             '빈 판에서 두 사람이 자유롭게 배치를 고르는 전략의 최적성을 평가한 실험은 아니다.', '',
             f'초록 (행, 열)=(0,0), 방향 →. 갈색 (0,{gap}), 방향 ←. '
             '행은 아래쪽, 열은 오른쪽이 양수다. 회전·반사한 배치도 같은 오프닝이다.', '',
             '## 비교 방법', '',
             '최신 best.pth.tar를 복사한 한 모델을 양쪽에 동일하게 사용했다. 168개 배치를 모두 신경망으로 선별하고, '
             '맨해튼 거리 2 이하인 28개 배치 및 과거 후보 21·22를 예비 대국으로 비교했다. '
             '예비 비교는 배치당 8국·수당 MCTS 24회다. '
             '간결한 마주보기 배치 중 한 칸 간격 배치 8을 후보로 골랐고, 기존 인접 마주보기 11을 대조군으로 정했다.', '',
             '후보를 고른 뒤 별도 seed로 각 32국·수당 MCTS 100회 독립 검증했다. '
             '첫 6수는 방문 비율로 추첨하고 이후에는 최대 방문 수를 택한다. '
             '8개 회전·반사를 균등 사용하며, cpuct=1.5이고 루트 노이즈는 없다. '
             '탐색량과 seed가 다른 예비·확인 대국의 승률은 합산하지 않는다.', '',
             '## 독립 확인 결과', '',
             '| 배치 | 선공 / 후공 승 | 선공 승률 | Wilson 95% 구간 | 선공 평균 타일 차 | 서로 다른 수순 |',
             '|---|---:|---:|---:|---:|---:|']
    for e in confirm['openings']:
        s = e['summary']; lo, hi = s['wilson_95']
        name = '한 칸 띄워 마주보기' if e['id'] == 8 else '인접 마주보기'
        lines.append(f"| {name} ({e['id']}) | {s['first_wins']} / {s['second_wins']} | "
                     f"{s['first_win_rate']:.1%} | {lo:.1%}~{hi:.1%} | {s['mean_margin']:+.2f} | "
                     f"{s['unique_trajectories']}/{s['games']} |")
    lines += ['', '## 직관성과 초반 전술', '',
              '두 타일을 한 줄에 놓고 서로 바라보게 한다는 설명이 간단하다. '
              '한 칸 간격 배치 8은 시작 범위가 1×3이라 5×5 한도를 처음부터 꽉 채우지 않는다. '
              '기존 후보 21·22는 시작부터 가로 5칸을 사용한다.', '',
              '첫 수와 그에 대한 모든 응수를 전수 조사했다. '
              '배치 8은 합법 첫 수 12개 모두 첫 수 포획이 없고, 모든 후공 응수에도 즉시 포획이 없다. '
              '배치 11도 첫 두 수에 포획이 없지만 첫 수 선택은 9개다. '
              '인접 평행 배치 7은 첫 수 9개 중 3개가 즉시 포획이므로 입문용 우선순위에서 뒤로 뒀다. '
              '이 전술 수치는 장기 균형이나 최적 수의 증명은 아니다.', '',
              '## 해석 범위', '',
              '추천은 이 고정 모델과 대국 방식에서 측정한 결과 및 설명의 단순성을 함께 고려한 것이다. '
              '32국의 구간은 넓고, 승률이 50%에 가깝다는 관찰이나 구간에 50%가 포함된다는 사실만으로 '
              '공정성이 입증되지는 않는다. 최적 플레이와 사람 간 승률은 확인하지 않았다. '
              '방향별 표본은 4국이며, Wilson 구간은 이 절차에 조건부인 근사치다.', '',
              '## 예비 비교 전체', '',
              '초록 방향을 ↑로 놓았을 때 갈색의 상대 위치와 방향을 표시한다. 행 +는 아래, 열 +는 오른쪽이다.', '',
              '| ID | 갈색 상대 (행, 열) | 갈색 방향 | 선공 / 후공 승 | 선공 평균 타일 차 |',
              '|---:|---|---|---:|---:|']
    for e in pilot['openings']:
        b = np.array(e['board'], dtype=np.int8)
        green = np.argwhere(b > 0)[0]; brown = np.argwhere(b < 0)[0]
        assert b[tuple(green)] == 1
        offset = tuple(int(x) for x in brown - green)
        s = e['summary']
        lines.append(f"| {e['id']} | {offset} | {L.ARROWS[abs(int(b[tuple(brown)]))-1]} | "
                     f"{s['first_wins']} / {s['second_wins']} | {s['mean_margin']:+.2f} |")
    lines += ['', '## 검증과 재현', '',
              '모든 대국을 재생해 매 수의 합법성, 진행 기록, 최종 보드, 승패, 타일 차, 패스 수를 확인했다. '
              '방향별 대국 수와 집계도 확인했다. 가속 PUCT는 배치 11·13·21에서 기존 MCTS와 '
              '100회 탐색의 모든 방문 수·Q 값이 정확히 일치함을 별도로 확인했다.', '',
              f'고정 모델 SHA-256: `{digest}`. `model_metadata.json`에 원본 모델과 일치하는 학습 기록을 저장했다.', '',
              '`recommended_opening.json`에는 추천 배치의 실제 7×7 보드, 두 초기 배치 action, '
              '초록의 다음 차례와 독립 검증 결과를 저장했다.', '', '```powershell']
    for label, report in [('pilot', pilot), ('confirm', confirm)]:
        settings = report['settings']
        ids = ' '.join(str(i) for i in settings['ids'])
        lines.append(f"python select_facing_openings.py --output {out.as_posix()} --label {label} "
                     f"--ids {ids} --games {settings['games']} --sims {settings['sims']} "
                     f"--seed {settings['seed']} --batch-size 32")
    lines += [f'python report_intuitive_facing.py --output {out.as_posix()} --recommend-id {opts.recommend_id}',
              '```', '']
    (out / 'RECOMMENDATION.md').write_text('\n'.join(lines), encoding='utf-8')
    print('Recommendation:', title, recommended['summary'])
    print('Audited games:', sum(len(e['records']) for r in (pilot, confirm) for e in r['openings']))


if __name__ == '__main__':
    main()
