"""Enumerate connected balanced four-tile openings; network inference only."""
import csv
import hashlib
import io
import itertools
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

import numpy as np
import torch

from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame
from gyeol.pytorch.NNet import NNetWrapper


SHAPES = {
    'O': [(0, 0), (0, 1), (1, 0), (1, 1)],
    'I': [(0, 0), (0, 1), (0, 2), (0, 3)],
    'T': [(0, 0), (0, 1), (0, 2), (1, 1)],
    'L': [(0, 0), (1, 0), (2, 0), (2, 1)],
    'S': [(0, 0), (0, 1), (1, 1), (1, 2)],
}
ARROWS = {1: '↑', 2: '→', 3: '↓', 4: '←'}


def variants(board):
    return [L.recenter(L.transform_board(board, s)) for s in L.SYMMETRIES]


def layout(board):
    r0, r1, c0, c1 = L.bbox(board)
    return board[r0:r1+1, c0:c1+1].tolist()


def diagram(rows):
    return ' / '.join(' '.join('·' if v == 0 else ('G' if v > 0 else 'B') + ARROWS[abs(v)] for v in row) for row in rows)


def main():
    out = Path('four_tile_network_analysis')
    out.mkdir(exist_ok=True)
    data = Path('temp/best.pth.tar').read_bytes()
    (out / 'model.pth.tar').write_bytes(data)
    game = GyeolGame()
    net = NNetWrapper(game)
    net.nnet.load_state_dict(torch.load(io.BytesIO(data), map_location=net.device)['state_dict'])
    net.nnet.eval()
    torch.set_num_threads(2)
    entries, seen = [], set()
    inputs, indices = [], {}
    for shape, cells in SHAPES.items():
        for green in itertools.combinations(range(4), 2):
            for directions in itertools.product(range(1, 5), repeat=4):
                b = np.zeros((L.N, L.N), dtype=np.int8)
                for i, (r, c) in enumerate(cells):
                    b[r+1, c+1] = directions[i] * (1 if i in green else -1)
                b = L.recenter(b)
                vv = variants(b)
                k = min(x.tobytes() for x in vv)
                if k in seen:
                    continue
                seen.add(k)
                ids = []
                for x in vv:
                    raw = x.tobytes()
                    if raw not in indices:
                        indices[raw] = len(inputs)
                        inputs.append(x)
                    ids.append(indices[raw])
                entries.append(dict(id=f'{shape}-{sum(e["shape"] == shape for e in entries)+1:04d}',
                                    shape=shape, board=b.tolist(), diagram=layout(b), inference_indices=ids))
        print('enumerated', shape, len(entries), flush=True)

    values = []
    with torch.inference_mode():
        for start in range(0, len(inputs), 256):
            batch = torch.from_numpy(np.stack(inputs[start:start+256])).to(net.device)
            _, v = net.nnet(batch)
            values.extend(v.cpu().numpy().reshape(-1).tolist())
            if start % 2048 == 0:
                print('inference', start, '/', len(inputs), flush=True)
    for e in entries:
        vs = [values[i] for i in e.pop('inference_indices')]
        ps = [(v+1)/2 for v in vs]
        e.update(value_mean=float(np.mean(vs)), first_win_probability=float(np.mean(ps)),
                 second_win_probability=1-float(np.mean(ps)),
                 displayed_orientation_first_probability=ps[0],
                 orientation_probability_min=min(ps), orientation_probability_max=max(ps),
                 orientation_probabilities=ps,
                 worst_orientation_deviation=max(abs(p-.5) for p in ps),
                 layout=diagram(e['diagram']))
    ranked = sorted(entries, key=lambda e: abs(e['first_win_probability']-.5))
    for rank, e in enumerate(ranked, 1):
        e['balance_rank'] = rank
    meta = dict(created=datetime.now().astimezone().isoformat(),
                source='temp/best.pth.tar', sha256=hashlib.sha256(data).hexdigest(),
                source_model_unchanged=hashlib.sha256(Path('temp/best.pth.tar').read_bytes()).hexdigest()==hashlib.sha256(data).hexdigest(),
                scope='All edge-connected four-tile shapes, two tiles per color, all four directions. Disconnected layouts excluded.',
                first_player='green (+1)', raw_assignments=5*6*4**4,
                symmetry_classes=len(entries), unique_network_inputs=len(inputs),
                counts_by_shape=dict(Counter(e['shape'] for e in entries)),
                probability_formula='p_first=(mean(v over 8 D4 transforms)+1)/2; p_second=1-p_first',
                caveat='Value-head estimate, not calibrated or empirically measured win probability. Orientation range is not a confidence interval.',
                mcts_simulations=0)
    (out/'results.json').write_text(json.dumps(dict(metadata=meta,positions=ranked), ensure_ascii=False, indent=2),encoding='utf-8')
    fields=['balance_rank','id','shape','layout','first_win_probability','second_win_probability',
            'displayed_orientation_first_probability','orientation_probability_min','orientation_probability_max','worst_orientation_deviation','value_mean']
    with (out/'all_positions.csv').open('w',newline='',encoding='utf-8-sig') as f:
        writer=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore')
        writer.writeheader()
        writer.writerows(ranked)
    def table(rows):
        lines=['| ID | 배치 (G=선공, B=후공, /=다음 행) | 선공 추정 | 후공 추정 | 방향별 선공 범위 |',
               '|---|---|---:|---:|---:|']
        for e in rows:
            lines.append(f"| {e['id']} | {e['layout']} | {e['first_win_probability']:.2%} | {e['second_win_probability']:.2%} | {e['orientation_probability_min']:.2%}–{e['orientation_probability_max']:.2%} |")
        return lines
    report=['# 2장 대 2장 오프닝: 신경망 평가', '',
            f"현재 모델을 고정해 연결된 5가지 모양의 색·화살표 조합 {meta['raw_assignments']:,}개를 조사했다. 회전·반사 중복 제거 후 **{len(entries):,}개 배치**이며 MCTS와 대국은 실행하지 않았다.", '',
            '초록(G)이 선공이다. 값 출력 v를 `(v+1)/2`로 환산하고 회전·반사 8개 변환의 평균을 선공 승률 추정치로 표시한다. 후공 추정치는 1에서 선공 추정치를 뺀 값이다. 학습 목표는 승패 값이므로 이는 승률 형태로 환산한 모델 평가이며, 실제 대국 승률이나 확률 보정이 검증된 값은 아니다. 특히 학습 시작 배치와 다른 4장 배치에서는 오차가 있을 수 있다.', '',
            '방향별 범위는 같은 배치를 회전·반사했을 때의 모델 추정 최솟값~최댓값이며 신뢰구간이 아니다. 평균만 50%여도 각 방향의 평가 차이가 클 수 있다. 떨어져 있는 타일 배치는 제외했다.', '',
            '## 모양별 분포', '',
            '| 모양 | 중복 제거 배치 수 | 선공 추정 최솟값 | 선공 추정 최댓값 | 선공 45~55% 배치 수 |',
            '|---|---:|---:|---:|---:|']
    for shape in SHAPES:
        rows=[e for e in ranked if e['shape']==shape]
        report.append(f"| {shape} | {len(rows)} | {min(e['first_win_probability'] for e in rows):.2%} | {max(e['first_win_probability'] for e in rows):.2%} | {sum(.45<=e['first_win_probability']<=.55 for e in rows)} |")
    report += ['', '## 평균 50%에 가까운 20개', ''] + table(ranked[:20])
    robust=sorted(entries,key=lambda e:e['worst_orientation_deviation'])
    report += ['', '## 모든 방향에서 50%에 가까운 10개', '',
               '각 배치의 방향별 |승률−50%| 중 최댓값이 작은 순서다. 평균값의 상쇄만으로 균형적으로 보이는 배치와 구분하기 위한 보조 정렬이다.', ''] + table(robust[:10])
    for shape in SHAPES:
        rows=[e for e in ranked if e['shape']==shape]
        report += ['', f'## {shape}: 평균 50%에 가까운 10개', ''] + table(rows[:10])
    report += ['', '## 재현', '', f"모델 SHA-256: `{meta['sha256']}`", '',
               '`all_positions.csv`: 모든 배치와 승률, 50% 근접 순 정렬. 확률 열의 0.5는 50%다.',
               '`results.json`: 전체 7×7 보드, 8개 변환별 평가, 모델 메타데이터.',
               '`model.pth.tar`: 평가에 사용한 모델 복사본.', '',
               '```powershell\npython analyze_four_tile_network.py\n```']
    (out/'REPORT.md').write_text('\n'.join(report),encoding='utf-8')
    print(json.dumps(dict(metadata=meta,closest=[{k:e[k] for k in ('id','layout','first_win_probability','orientation_probability_min','orientation_probability_max')} for e in ranked[:8]],
                         robust=[{k:e[k] for k in ('id','layout','first_win_probability','orientation_probability_min','orientation_probability_max')} for e in robust[:5]]),ensure_ascii=True),flush=True)


if __name__ == '__main__':
    main()
