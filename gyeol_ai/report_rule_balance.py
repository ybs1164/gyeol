"""Audit all recorded moves and render the two-rule neural evaluation."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform

import numpy as np
import torch

from facing.rules import FacingGame
from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from validate_fair_opening import summary


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def audit(game, experiment):
    records = experiment['records']
    assert len(records) == experiment['target_games']
    assert {r['game_index'] for r in records} == set(range(experiment['target_games']))
    counts = np.bincount([r['orientation'] for r in records], minlength=8)
    assert len(set(counts)) == 1
    for r in records:
        board = L.recenter(L.transform_board(game.getInitBoard(), L.SYMMETRIES[r['orientation']]))
        player = 1
        for a in r['actions']:
            assert not game.getGameEnded(board, 1)
            assert game.getValidMoves(board, player)[a]
            board, player = game.getNextState(board, player, a)
        np.testing.assert_array_equal(board, np.array(r['final_board'], dtype=np.int8))
        assert game.getGameEnded(board, 1) == r['result']
        assert int(np.sign(board).sum()) == r['margin']
        assert int(np.count_nonzero(board > 0)) == r['first_tiles']
        assert int(np.count_nonzero(board < 0)) == r['second_tiles']
        assert r['seed'] == experiment['settings']['seed'] + r['game_index']
    assert summary(records) == experiment['summary']
    return dict(games=len(records), moves=sum(len(r['actions']) for r in records),
                orientation_counts=counts.tolist(), passed=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='rule_balance_20261023')
    opts = parser.parse_args()
    out = Path(opts.output)
    loaded = {}
    audits = {}
    for rule, game in [('original', GyeolGame()), ('facing', FacingGame())]:
        folder = out / rule
        meta = read(folder / 'model_metadata.json')
        assert hashlib.sha256((folder / 'model.pth.tar').read_bytes()).hexdigest() == meta['sha256']
        loaded[rule] = dict(meta=meta, diagnostics=read(folder / 'diagnostics.json'),
                            random=read(folder / 'random_baseline.json'), experiments={})
        for path in sorted(folder.glob('selfplay_*_temp6.json')):
            experiment = read(path)
            assert experiment['settings']['sha256'] == meta['sha256']
            audits[f'{rule}/{path.name}'] = audit(game, experiment)
            loaded[rule]['experiments'][experiment['settings']['sims']] = experiment
    initial = loaded['facing']['diagnostics']
    assert initial['legal_moves'] == 9
    assert all(o['reply_count'] == 18 and o['capturing_replies'] == 0
               for o in initial['openings'])
    files = ['evaluate_rule_balance.py', 'report_rule_balance.py', 'MCTS.py',
             'facing/rules.py', 'facing/network.py', 'gyeol/GyeolLogic.py',
             'gyeol/GyeolGame.py', 'gyeol/pytorch/NNet.py', 'gyeol/pytorch/GyeolNNet.py',
             'validate_fair_opening_batch.py', 'validate_fair_opening.py', 'find_fair_opening.py']
    audit_data = dict(created_utc=datetime.now(timezone.utc).isoformat(), experiments=audits,
        environment=dict(python=platform.python_version(), numpy=np.__version__, torch=torch.__version__),
        source_sha256={f: hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in files})
    (out / 'audit.json').write_text(json.dumps(audit_data, indent=2), encoding='utf-8')
    lines = ['# 방향 고정 규칙의 선후공 비교 (2026-10-23)', '',
        '두 규칙 모두 `초록 → / 갈색 ←` 두 타일에서 초록이 먼저 둔다. 방향 고정 규칙에서는 새 타일이 반드시 방금 돌린 상대 타일을 바라본다. 다른 규칙은 동일하다.', '',
        '## 실제 동일 모델 대국', '',
        '| 수당 MCTS | 규칙 | 대국 수 | 선공 승 / 후공 승 | 선공 승률 | 95% 구간 | 선공 평균 타일 차이 |',
        '|---:|---|---:|---:|---:|---:|---:|']
    labels = dict(original='방향 자유 (기존)', facing='상대 타일 방향으로 고정')
    for sims in sorted(loaded['facing']['experiments']):
        for rule in ('original', 'facing'):
            s = loaded[rule]['experiments'][sims]['summary']
            lo, hi = s['wilson_95']
            lines.append(f"| {sims} | {labels[rule]} | {s['games']} | {s['first_wins']} / {s['second_wins']} | {s['first_win_rate']:.1%} | {lo:.1%}–{hi:.1%} | {s['mean_margin']:+.3f}장 |")
    lines += ['', '선공 승률의 차이(방향 고정 − 기존):', '']
    for sims in sorted(loaded['facing']['experiments']):
        old = loaded['original']['experiments'][sims]['summary']['first_win_rate']
        new = loaded['facing']['experiments'][sims]['summary']['first_win_rate']
        lines.append(f'- 수당 {sims}회: {(new-old)*100:+.1f}%p.')
    lines += ['',
        '각 규칙에 맞춰 따로 학습된 모델을 분석 시작 시점에 복사하고, 한 대국에서는 동일한 고정 모델이 선공과 후공 모두를 맡았다. 회전·반사 8개 변환을 같은 횟수로 사용했다(초기 배치에서 중복 제거 시 4종). 첫 6수는 MCTS 방문 비율로 확률 선택하고 이후는 최대 방문 수를 선택했다. 루트 노이즈 없음, cpuct=1.5, 대국별 seed=2026102300+번호. 탐색량이 다른 실험은 합산하지 않는다.', '',
        '95% 구간은 고정 AI와 해당 대국 방식에서의 Wilson 이항 구간이다. 방향별 성능이 서로 다를 수 있어 근사치이며, 모델 편향과 학습 부족을 포함하지 않는다. 별도로 학습한 두 모델의 강도와 학습 이력이 달라 승률 차이 전체를 규칙 변경만의 인과 효과로 볼 수 없다. 인간 대국 승률이나 최적 플레이의 승패를 증명하지 않는다.', '',
        '## 신경망 및 초기 배치 탐색', '',
        '| 규칙 | 신경망 값 | 대칭별 값 범위 | 합법 첫 수 |',
        '|---|---:|---:|---:|']
    for rule in ('original', 'facing'):
        d = loaded[rule]['diagnostics']
        lines.append(f"| {labels[rule]} | {d['value']:+.4f} | {min(d['symmetry_values']):+.4f} ~ {max(d['symmetry_values']):+.4f} | {d['legal_moves']} |")
    lines += ['', '값과 Q는 선공 관점의 -1~+1 승패 평가이며 실측 승률이 아니다.', '',
        '| 규칙 | 초기 배치 MCTS | 방문 가중 Q | 최다 방문 수 Q | 탐색한 첫 수 | 추천 |',
        '|---|---:|---:|---:|---:|---|']
    for rule in ('original', 'facing'):
        d = loaded[rule]['diagnostics']
        for s in d['searches']:
            lines.append(f"| {labels[rule]} | {s['sims']} | {s['mean_q']:+.4f} | {s['best_q']:+.4f} | {s['visited']}/{d['legal_moves']} | {s['description']} |")
    lines += ['',
        '방향 고정 규칙의 첫 수 9개와 각각의 후공 응수 18개를 전수 확인했다. 어느 첫 수 뒤에도 후공의 즉시 포획은 없다. 이는 두 수까지의 사실이며 장기적 공정성의 증명은 아니다.', '',
        '## 무작위 대국 기준선', '',
        '| 규칙 | 대국 수 | 선공 승 / 후공 승 | 선공 승률 | 95% 구간 |',
        '|---|---:|---:|---:|---:|']
    for rule in ('original', 'facing'):
        s = loaded[rule]['random']['summary']
        lo, hi = s['wilson_95']
        lines.append(f"| {labels[rule]} | {s['games']} | {s['first_wins']} / {s['second_wins']} | {s['first_win_rate']:.1%} | {lo:.1%}–{hi:.1%} |")
    lines += ['', '무작위 합법 수 선택은 약한 플레이의 기준선이다. 신경망 대국과 다른 양상이 나와도 이를 합산하거나 전략적 균형의 증거로 쓰지 않는다.', '',
        '## 재현 및 검증', '']
    for rule in ('original', 'facing'):
        m = loaded[rule]['meta']
        lines += [f"- {labels[rule]} 모델: `{rule}/model.pth.tar`, SHA-256 `{m['sha256']}`, 캡처 UTC `{m['captured_utc']}`."]
    lines += ['',
        f"모든 {sum(a['games'] for a in audits.values())}국의 {sum(a['moves'] for a in audits.values())}수를 다시 재생해 합법성, 종료, 최종 보드, 승패, 타일 개수, seed와 균등한 방향 배분을 검사했다. `audit.json`에 검사 결과, 환경 버전, 관련 코드 해시를 저장했다. 실행 중인 학습과 기존 모델/리플레이는 수정하지 않았다.", '',
        '```powershell',
        'python evaluate_rule_balance.py --rule facing --games 128 --sims 100',
        'python evaluate_rule_balance.py --rule original --games 128 --sims 100',
        'python evaluate_rule_balance.py --rule facing --games 64 --sims 200',
        'python evaluate_rule_balance.py --rule original --games 64 --sims 200',
        'python report_rule_balance.py',
        '```', '',
        '동일 출력 폴더를 사용하면 저장된 고정 모델과 완료된 대국을 재사용한다. 최신 모델을 새로 분석하려면 다른 `--output` 폴더를 지정한다. 같은 모델로 처음부터 재실행하려면 새 `--output` 폴더와 `--model rule_balance_20261023/facing/model.pth.tar`(기존 규칙은 original 폴더)를 함께 지정한다.']
    (out / 'REPORT.md').write_text('\n'.join(lines), encoding='utf-8')
    print(json.dumps(audit_data['experiments'], indent=2))
    print('Report:', out / 'REPORT.md')


if __name__ == '__main__':
    main()
