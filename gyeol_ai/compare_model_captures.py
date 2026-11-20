"""Compare captured-tile counts in matched original/facing self-play records."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from analyze_capture_openings import replay, summarize
from facing.rules import FacingGame, base_action
from gyeol.GyeolGame import GyeolGame
from gyeol import GyeolLogic as L
from select_facing_openings import evaluation


def load(path, kind):
    data = path.read_bytes()
    report = json.loads(data)
    assert report['complete'] and report['settings']['rule'] == kind
    assert report['sha256'] == hashlib.sha256((path.parent / 'model.pth.tar').read_bytes()).hexdigest()
    game = GyeolGame() if kind == 'original' else FacingGame() if kind == 'facing' else evaluation.FacingFreeStartGame()
    game.regular_action_size = game.getActionSize() if kind != 'facing-free-start' else game.regular_action_size
    entry = next(e for e in report['openings'] if e['id'] == 11)
    records = []
    for rec in sorted(entry['records'], key=lambda r: r['game_index']):
        board = L.recenter(L.transform_board(np.array(entry['board'], dtype=np.int8),
                                              L.SYMMETRIES[rec['orientation']]))
        metrics = replay(game, board, rec['actions'], rec['result'], rec['final_board'])
        green_flips = sum(metrics['captures_by_turn'][::2])
        brown_flips = sum(metrics['captures_by_turn'][1::2])
        green_placed = sum(a != game.regular_action_size - 1 for a in rec['actions'][::2])
        brown_placed = sum(a != game.regular_action_size - 1 for a in rec['actions'][1::2])
        assert rec['margin'] == green_placed - brown_placed + 2 * (green_flips - brown_flips)
        assert rec['seed'] == report['settings']['seed'] + rec['game_index']
        if rec['game_index'] == 0:
            # Verify the count against explicit capture paths, including multi-tile captures.
            player = 1
            for index, action in enumerate(rec['actions']):
                original_action = action if kind == 'original' else base_action(action)
                expected, info = L.apply_move_verbose(board, player, original_action)
                assert len(info.get('flipped', [])) == metrics['captures_by_turn'][index]
                board, player = game.getNextState(board, player, action)
                np.testing.assert_array_equal(board, expected)
        records.append(dict(game_index=rec['game_index'], orientation=rec['orientation'],
                            green_flips=green_flips, brown_flips=brown_flips, **metrics))
    assert [r['game_index'] for r in records] == list(range(report['settings']['games']))
    assert all(sum(r['orientation'] == sym for r in records) == len(records) // 8 for sym in range(8))
    summary = summarize(records)
    summary.update(total_flipped=sum(r['captured_tiles'] for r in records),
                   mean_green_flips=float(np.mean([r['green_flips'] for r in records])),
                   mean_brown_flips=float(np.mean([r['brown_flips'] for r in records])),
                   mean_flips_per_turn=sum(r['captured_tiles'] for r in records) / summary['turns'],
                   mean_flips_per_capture_turn=sum(r['captured_tiles'] for r in records) / summary['capture_turns'])
    print(kind, summary, flush=True)
    return dict(kind=kind, source=str(path), source_sha256=hashlib.sha256(data).hexdigest(),
                model_sha256=report['sha256'], settings=report['settings'], board=entry['board'],
                summary=summary, records=records)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original', type=Path, required=True)
    parser.add_argument('--facing', type=Path, required=True)
    parser.add_argument('--free-start', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    opts = parser.parse_args()
    entries = [load(opts.original, 'original'), load(opts.facing, 'facing')]
    if opts.free_start:
        entries.append(load(opts.free_start, 'facing-free-start'))
    settings = entries[0]['settings']
    for e in entries:
        assert e['board'] == entries[0]['board']
        for name in ['games', 'sims', 'seed', 'random_plies', 'cpuct', 'root_noise']:
            assert e['settings'][name] == settings[name]
    n = settings['games']
    rng = np.random.default_rng(2026102642)
    indices = (np.arange(8)[None, :, None] + 8 * rng.integers(0, n // 8,
                size=(10000, 8, n // 8))).reshape(10000, n)
    samples = {}
    for e in entries:
        values = np.array([r['captured_tiles'] for r in e['records']])
        samples[e['kind']] = values[indices].mean(axis=1)
        e['mean_flips_bootstrap_95'] = np.quantile(samples[e['kind']], [.025, .975]).tolist()
    difference = dict(facing_minus_original=entries[1]['summary']['mean_captured_tiles'] - entries[0]['summary']['mean_captured_tiles'],
                      relative_change=entries[1]['summary']['mean_captured_tiles'] / entries[0]['summary']['mean_captured_tiles'] - 1,
                      bootstrap_95=np.quantile(samples['facing'] - samples['original'], [.025, .975]).tolist())
    result = dict(metric='Combined flipped tiles per game, including repeated captures',
                  models=entries, difference=difference, bootstrap=dict(samples=10000, seed=2026102642,
                  unit='whole games resampled within orientation; paired game indices'))
    opts.output.mkdir(parents=True, exist_ok=True)
    (opts.output / 'comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    names = {'original': '기존 모델 (방향 자유)', 'facing': 'facing 모델 (상대 바라보기)',
             'facing-free-start': '참고: facing-free-start 모델'}
    direction = '적었다' if difference['facing_minus_original'] < 0 else '많았다'
    lines = ['# 기존 모델과 facing 모델의 평균 포획 타일 비교 — 2026-10-26', '',
             f"현재 모델의 동일 조건 비교에서 기존 모델은 한 판 평균 {entries[0]['summary']['mean_captured_tiles']:.2f}장, "
             f"facing은 {entries[1]['summary']['mean_captured_tiles']:.2f}장을 뒤집었다. "
             f"facing의 포획량이 {abs(difference['facing_minus_original']):.2f}장"
             f"({abs(difference['relative_change']):.1%}) {direction}.", '',
             '두 모델은 각자의 규칙에서 같은 가중치가 양쪽을 맡는 자가대국으로 비교했다. '
             '시작은 모두 인접 마주보기 `초록→ 갈색←`이며 초록이 정규 첫 수를 둔다. '
             '양쪽이 한 판에서 뒤집은 누적 타일 수를 합산하고 재포획도 다시 센다.', '',
             f"배치당 {settings['games']}국·수당 MCTS {settings['sims']}회, "
             f"seed={settings['seed']}, 첫 {settings['random_plies']}수 확률 선택, 이후 최다 방문 수, "
             '8개 회전·반사 균등 배분, cpuct=1.5, 루트 노이즈 없음. 모델·수순을 고정하고 모든 대국을 재생했다.', '',
             '| 모델 | 한 판 평균 포획 | 턴당 평균 | 포획 턴 비율 | 포획 한 번당 평균 |',
             '|---|---:|---:|---:|---:|']
    for e in entries:
        s = e['summary']
        lines.append(f"| {names[e['kind']]} | {s['mean_captured_tiles']:.2f}장 | "
                     f"{s['mean_flips_per_turn']:.2f}장 | {s['capture_turn_rate']:.1%} | "
                     f"{s['mean_flips_per_capture_turn']:.2f}장 |")
    lines += ['', f"facing − 기존의 한 판 평균 차이는 {difference['facing_minus_original']:+.3f}장, "
              f"기존 대비 변화율은 {difference['relative_change']:+.1%}다. "
              f"대국 단위 재표집 차이의 근사 95% 구간은 {difference['bootstrap_95'][0]:+.3f}~"
              f"{difference['bootstrap_95'][1]:+.3f}장이다. 방향 안에서 대국을 10,000회 재표집했으며 "
              '같은 대국 번호를 짝지었다. 한 대국 안의 턴을 독립 표본으로 취급하지 않았다.', '',
              '## 양쪽의 포획량', '',
              '| 모델 | 선공 평균 포획 | 후공 평균 포획 | 평균 첫 포획 턴 |',
              '|---|---:|---:|---:|']
    for e in entries:
        s = e['summary']
        lines.append(f"| {names[e['kind']]} | {s['mean_green_flips']:.2f}장 | "
                     f"{s['mean_brown_flips']:.2f}장 | {s['mean_first_capture_turn']:.2f}수 |")
    lines += ['', '## 해석 범위와 검증', '',
              '기존 모델은 새 타일 방향을 자유롭게 선택하며 facing은 돌린 상대 타일을 바라보게 놓는다. '
              '별도로 학습한 모델도 함께 다르므로 차이를 규칙 변경만의 인과 효과로 해석하지 않는다. '
              '같은 탐색 횟수라도 합법 수의 개수는 다르다. 이 결과는 현재 두 모델과 인접 마주보기 배치에 조건부이며 '
              '다른 배치나 최적 플레이에서의 차이를 확정하지 않는다. 포획량과 승률도 별개다.', '',
              '매 수의 합법성, 최종 보드·승패, 양쪽 포획량과 점수 차이의 일치, seed·방향 배분을 확인했다. '
              '각 모델의 첫 대국은 별도로 엔진의 뒤집힌 칸 목록과 포획 수열을 매 턴 대조했다. '
              '기존 모델의 새 32국과 앞서 완료된 facing 32국을 비교했으며 과거 facing 모델의 결과는 섞지 않았다.', '',
              '## 모델 해시', '']
    for e in entries:
        lines.append(f"- {names[e['kind']]}: `{e['model_sha256']}`")
    lines += ['', '## 재현', '', '```powershell',
              'python select_facing_openings.py --model-kind original --model temp/best.pth.tar --output capture_model_comparison_20261026/original --label confirm --ids 11 --games 32 --sims 100 --seed 2026102617 --batch-size 32',
              f'python compare_model_captures.py --original {opts.original.as_posix()} --facing {opts.facing.as_posix()}'
              + (f' --free-start {opts.free_start.as_posix()}' if opts.free_start else '')
              + f' --output {opts.output.as_posix()}', '```', '',
              '같은 출력 폴더에서는 고정 모델과 완료된 대국을 재사용한다. 새로운 폴더에서 같은 모델로 재현하려면 --model에 저장된 original/model.pth.tar를 지정한다.']
    (opts.output / 'REPORT.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print('difference', difference)


if __name__ == '__main__':
    main()
