"""Frozen original free-start opening selection with independent confirmation."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'facing-free-start'))
spec = importlib.util.spec_from_file_location('generic_opening_evaluation', ROOT / 'facing-free-start/evaluate.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

from free_game import FreeStartGame
from free_net import FreeStartNet
from evaluate_rule_balance import cache_transitions, save
from gyeol import GyeolLogic as L
import numpy as np
import torch
from validate_fair_opening import summary

DEFAULT_OUT = ROOT / 'free-start/evaluations/balance-20261024'


def display(board):
    """Put green's arrow north; reflect to put brown to the right if possible."""
    variants = []
    for sym in L.SYMMETRIES:
        b = L.recenter(L.transform_board(np.array(board, dtype=np.int8), sym))
        gr, gc = np.argwhere(b > 0)[0]
        br, bc = np.argwhere(b < 0)[0]
        if b[gr, gc] == 1:
            variants.append((int(bc-gc), int(br-gr), -abs(int(b[br, bc])), b))
    _, dr, _, board = max(variants, key=lambda item: item[:3])
    gr, gc = np.argwhere(board > 0)[0]
    br, bc = np.argwhere(board < 0)[0]
    r0, r1, c0, c1 = L.bbox(board)
    rows = []
    for r in range(r0, r1+1):
        row = []
        for c in range(c0, c1+1):
            v = int(board[r, c])
            row.append(('G' if v > 0 else 'B') + L.ARROWS[abs(v)-1] if v else ' ·')
        rows.append(' '.join(row))
    return dict(second_offset=[int(br-gr), int(bc-gc)], second_direction=L.ARROWS[abs(int(board[br, bc]))-1],
                diagram='\n'.join(rows))


def render(out, report):
    ranked = sorted(report['openings'], key=lambda e: (abs(e['summary']['first_win_rate']-.5),
                    abs(e['summary']['mean_margin']), e['balance_score']))
    lines = [f"# 기존 free-start 배치 비교 — {report['label']}", '',
        f"고정 모델 SHA-256: `{report['sha256']}`. 기존 free-start 규칙(정규 3137개 + 초기 배치 324개 출력)을 사용했다.", '',
        f"배치당 {report['settings']['games']}국, 수당 MCTS {report['settings']['sims']}회. 첫 6수 방문 비율 추첨, 이후 최다 방문 수. 회전·반사 8개를 균등 사용하고 색 교환은 중복으로 제거하지 않는다. 양쪽 모델과 탐색량 동일, cpuct=1.5, 루트 노이즈 없음.", '',
        '표의 순위는 선공 승률이 50%에 가까운 순서이며 동률은 평균 타일 차이의 절댓값, 신경망 선별 점수로 정렬한다. 신뢰구간은 이 모델과 대국 방식의 Wilson 이항 근사 구간이다. 배치당 표본이 작으므로 규칙 자체의 균형을 증명하지 않는다.', '',
        '| 배치 ID | 대국 수 | 선공 / 후공 승 | 선공 승률 | 95% 구간 | 선공 평균 타일 차 |',
        '|---:|---:|---:|---:|---:|---:|']
    for e in ranked:
        s = e['summary']; lo, hi = s['wilson_95']
        lines.append(f"| {e['id']} | {s['games']} | {s['first_wins']} / {s['second_wins']} | {s['first_win_rate']:.1%} | {lo:.1%}~{hi:.1%} | {s['mean_margin']:+.3f} |")
    lines += ['', 'G=초록(선공), B=갈색(후공). 아래 그림은 회전·반사로 초록이 ↑를 바라보고 갈색이 가능한 한 오른쪽에 오도록 정렬했다. 두 장이 놓인 뒤 초록이 정규 첫 수를 둔다.', '']
    for e in ranked:
        d = display(e['board'])
        lines += [f"## 배치 {e['id']}", '',
                  f"초록 위치 (0,0), 방향 ↑. 갈색 상대 위치 (행,열)={tuple(d['second_offset'])}, 방향 {d['second_direction']}. 행 +는 아래, 열 +는 오른쪽.", '',
                  '```text', d['diagram'], '```', '']
    lines += ['모든 저장 대국의 합법성, 정규화 진행 기록, 종료 결과, 최종 보드, 타일 차이와 패스 수를 재생해 검증했다. 예비 대국으로 고른 후보는 독립 seed의 확인 대국 결과를 우선 해석하며 예비 승률과 확인 승률을 합산하지 않는다.', '']
    (out / f"{report['label']}.md").write_text('\n'.join(lines), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--ids', type=int, nargs='+', required=True)
    parser.add_argument('--games', type=int, default=8)
    parser.add_argument('--sims', type=int, default=100)
    parser.add_argument('--seed', type=int, default=2026102400)
    parser.add_argument('--batch-size', type=int, default=16)
    parser.add_argument('--label', default='pilot')
    parser.add_argument('--fast', action='store_true', help='Use validated vectorized edge scoring')
    opts = parser.parse_args()
    if opts.fast:
        from opening_fast_mcts import OpeningFastMCTS
        helpers.MCTS = OpeningFastMCTS
    if (opts.games < 8 or opts.games % 8 or opts.sims < 2 or opts.batch_size < 1
            or len(set(opts.ids)) != len(opts.ids) or Path(opts.label).name != opts.label):
        parser.error('Require games divisible by 8, sims >= 2, batch-size >= 1, distinct IDs and a filename label')
    out = opts.output
    torch.set_num_threads(1)
    torch.manual_seed(0)
    game = FreeStartGame()
    net = FreeStartNet(game)
    assert game.getActionSize() == 3461 and net.nnet.p_conv.out_channels == 64
    snapshot = (out / 'model.pth.tar').read_bytes()
    digest = hashlib.sha256(snapshot).hexdigest()
    net.nnet.load_state_dict(torch.load(io.BytesIO(snapshot), map_location=net.device, weights_only=True)['state_dict'])
    net.nnet.eval()
    screen = json.loads((out / 'screen.json').read_text(encoding='utf-8'))
    if any(i < 0 or i >= len(screen) for i in opts.ids):
        parser.error('Invalid layout ID')
    settings = dict(ids=opts.ids, games=opts.games, sims=opts.sims, seed=opts.seed,
                    random_plies=6, cpuct=1.5, root_noise=False, rule='original-free-start',
                    engine='vectorized_puct' if opts.fast else 'MCTS')
    path = out / f'{opts.label}.json'
    report = dict(label=opts.label, sha256=digest, settings=settings, complete=False,
                  created_utc=datetime.now(timezone.utc).isoformat(),
                  openings=[dict(**screen[i], records=[]) for i in opts.ids])
    if path.exists():
        report = json.loads(path.read_text(encoding='utf-8'))
        report['settings'].setdefault('engine', 'MCTS')
        assert report['sha256'] == digest and report['settings'] == settings
    cache_transitions(game)
    tasks = [(entry, gi) for entry in report['openings'] for gi in range(opts.games)
             if gi not in {r['game_index'] for r in entry['records']}]
    for offset in range(0, len(tasks), opts.batch_size):
        helpers.play_batch(game, net, tasks[offset:offset+opts.batch_size], opts.sims, opts.seed)
        for entry in report['openings']:
            if entry['records']:
                entry['records'].sort(key=lambda r: r['game_index'])
                entry['summary'] = summary(entry['records'])
        save(path, report)
        print('completed', offset+len(tasks[offset:offset+opts.batch_size]), '/', len(tasks),
              [(e['id'], e.get('summary', {}).get('first_win_rate')) for e in report['openings']], flush=True)
    for entry in report['openings']:
        helpers.audit(game, entry)
        assert len(entry['records']) == opts.games
        assert {r['game_index'] for r in entry['records']} == set(range(opts.games))
        assert np.all(np.bincount([r['orientation'] for r in entry['records']], minlength=8) == opts.games//8)
        assert all(r['seed'] == opts.seed+r['game_index'] for r in entry['records'])
    report['complete'] = True
    report['source_sha256'] = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in (
        'select_free_start_openings.py', 'facing-free-start/evaluate.py', 'free-start/free_game.py',
        'free-start/free_net.py', 'MCTS.py', 'opening_fast_mcts.py', 'validate_fair_opening_batch.py', 'gyeol/GyeolLogic.py')}
    save(path, report)
    render(out, report)
    print('DONE', path, flush=True)


if __name__ == '__main__':
    main()
