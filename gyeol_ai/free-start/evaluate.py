"""Compare sampled two-tile layouts using one frozen free-start model."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import sys
from datetime import datetime

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import numpy as np
import torch
from MCTS import MCTS
from utils import dotdict
from gyeol import GyeolLogic as L
from free_game import FreeStartGame, placement
from free_net import FreeStartNet


def layouts(game):
    unique = {}
    for d in range(4):
        first, player = game.getNextState(game.getInitBoard(), 1, game.placement(0, 0, d))
        for action in np.flatnonzero(game.getValidMoves(first, player)):
            board, _ = game.getNextState(first, player, int(action))
            key = min(L.recenter(L.transform_board(board, s)).tobytes() for s in L.SYMMETRIES)
            unique.setdefault(key, board)
    return list(unique.values())


def play(game, net, board, sims, seed, orientation):
    board = L.recenter(L.transform_board(board, L.SYMMETRIES[orientation]))
    rng = np.random.default_rng(seed)
    tree = MCTS(game, net, dotdict(numMCTSSims=sims, cpuct=1.5, dirichletAlpha=0))
    player, actions = 1, []
    while not game.getGameEnded(board, 1):
        pi = tree.getActionProb(game.getCanonicalForm(board, player), temp=1)
        action = int(rng.choice(len(pi), p=pi)) if len(actions) < 6 else int(rng.choice(np.flatnonzero(pi == pi.max())))
        assert game.getValidMoves(board, player)[action]
        actions.append(action)
        board, player = game.getNextState(board, player, action)
        assert len(actions) < 60
    return dict(seed=seed, orientation=orientation, actions=actions,
                result=float(game.getGameEnded(board, 1)), margin=int(np.sign(board).sum()))


def summarize(records):
    n = len(records)
    wins = sum(r['result'] == 1 for r in records)
    losses = sum(r['result'] == -1 for r in records)
    p, z = wins / n, 1.96
    center = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return dict(games=n, first_wins=wins, second_wins=losses, draws=n-wins-losses,
                first_win_rate=p, wilson_95=[center-half, center+half],
                mean_margin=float(np.mean([r['margin'] for r in records])))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--openings', type=int, default=16)
    ap.add_argument('--games', type=int, default=16, help='Games per layout; multiple of eight')
    ap.add_argument('--sims', type=int, default=100)
    ap.add_argument('--seed', type=int, default=20261020)
    opts = ap.parse_args()
    if opts.openings < 1 or opts.games < 8 or opts.games % 8 or opts.sims < 2:
        ap.error('openings >= 1, games a positive multiple of 8, sims >= 2 required')
    game = FreeStartGame()
    choices = layouts(game)
    if opts.openings > len(choices):
        ap.error(f'Only {len(choices)} distinct layouts exist modulo rotation/reflection')
    source = HERE / 'temp' / 'best.pth.tar'
    if not source.exists():
        ap.error('No free-start/temp/best.pth.tar yet; run free-start/main.py first')
    data = source.read_bytes()
    net = FreeStartNet(game)
    net.nnet.load_state_dict(torch.load(io.BytesIO(data), map_location=net.device)['state_dict'])
    net.nnet.eval()
    out = HERE / 'evaluations' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    out.mkdir(parents=True)
    (out / 'model.pth.tar').write_bytes(data)
    chosen = np.random.default_rng(opts.seed).choice(len(choices), opts.openings, replace=False)
    report = dict(settings=vars(opts), sha256=hashlib.sha256(data).hexdigest(),
                  population=len(choices), openings=[])
    for index in chosen:
        board = choices[index]
        records = []
        entry = dict(id=int(index), board=board.tolist(), records=records)
        report['openings'].append(entry)
        for gi in range(opts.games):
            records.append(play(game, net, board, opts.sims, opts.seed + gi, gi % 8))
            entry['summary'] = summarize(records)
            (out / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(f"Opening {len(report['openings'])}/{opts.openings}, game {gi+1}/{opts.games}", flush=True)
    lines = ['# Free-start 배치별 평가', '',
             '동일한 고정 모델끼리 비교. 첫 6수는 방문 비율로 추첨, 이후 최대 방문 수를 선택한다.',
             '회전·반사 8개를 균등 배분하며 색 교환은 대칭으로 제거하지 않는다.',
             '배치별로 같은 난수 번호를 사용한다. 승률은 이 AI와 절차에 한정되며 최적 플레이의 승률이 아니다.',
             '여러 배치를 동시에 검사하므로 우연히 극단적인 결과가 나올 수 있다. 선정된 배치는 독립 난수와 추가 대국으로 재검증해야 한다.', '',
             '| 배치 ID | 선공 승률 | 95% 구간 | 평균 점수 차 |', '|---:|---:|---:|---:|']
    for entry in sorted(report['openings'], key=lambda e: e['summary']['first_win_rate']):
        s = entry['summary']
        lo, hi = s['wilson_95']
        lines.append(f"| {entry['id']} | {s['first_win_rate']:.1%} | {lo:.1%}–{hi:.1%} | {s['mean_margin']:+.2f} |")
    for entry in report['openings']:
        lines += ['', f"## 배치 {entry['id']}", '', '```text',
                  L.board_to_str(np.array(entry['board'], dtype=np.int8)), '```']
    (out / 'REPORT.md').write_text('\n'.join(lines), encoding='utf-8')
    print(f'Results: {out}')


if __name__ == '__main__':
    main()
