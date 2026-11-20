"""Screen every two-tile layout and compare fixed facing openings by self-play."""
import argparse
from datetime import datetime
import hashlib
import io
import json
from pathlib import Path

from facing_free_game import FacingFreeStartGame, ROOT
from facing_free_net import FacingFreeStartNet
from evaluate_rule_balance import cache_transitions, save
from find_fair_opening import key
from gyeol import GyeolLogic as L
from MCTS import MCTS
import numpy as np
import torch
from utils import dotdict
from validate_fair_opening import summary
from validate_fair_opening_batch import DeferredNet, simulations

HERE = Path(__file__).resolve().parent


def layouts(game):
    unique = {}
    for direction in range(4):
        first, player = game.getNextState(game.getInitBoard(), 1, game.placement(0, 0, direction))
        for action in np.flatnonzero(game.getValidMoves(first, player)):
            board, _ = game.getNextState(first, player, int(action))
            unique.setdefault(key(board), board)
    return list(unique.values())


@torch.no_grad()
def screen(game, net):
    boards = sorted(layouts(game), key=key)
    entries = []
    for index, board in enumerate(boards):
        variants = [L.recenter(L.transform_board(board, s)) for s in L.SYMMETRIES]
        _, values = net.nnet(torch.from_numpy(np.stack(variants)).to(net.device))
        values = values.cpu().numpy().reshape(-1).astype(float).tolist()
        entries.append(dict(id=index, board=board.tolist(), key=key(board).hex(),
                            original=key(board) == key(L.initial_board()),
                            value_mean=float(np.mean(values)), value_range=[min(values), max(values)],
                            balance_score=max(abs(v) for v in values), symmetry_values=values))
    return entries


def play_batch(game, net, tasks, sims, seed):
    game.clear_transition_cache()
    active = []
    for entry, gi in tasks:
        board = L.recenter(L.transform_board(np.array(entry['board'], dtype=np.int8), L.SYMMETRIES[gi % 8]))
        proxy = DeferredNet()
        tree = MCTS(game, proxy, dotdict(numMCTSSims=sims, cpuct=1.5, dirichletAlpha=0))
        tree.root_prior = tree.root_noise = None
        active.append(dict(entry=entry, gi=gi, board=board, canonical=board, player=1,
                           proxy=proxy, tree=tree, rng=np.random.default_rng(seed + gi),
                           actions=[], trajectory=[]))
    ply = 0
    while active:
        simulations(active, net, sims)
        remaining = []
        for st in active:
            state = game.stringRepresentation(st['canonical'])
            counts = np.array([st['tree'].Nsa.get((state, a), 0) for a in range(game.getActionSize())], dtype=float)
            assert counts.sum() > 0
            action = int(st['rng'].choice(len(counts), p=counts / counts.sum())) if ply < 6 else int(st['rng'].choice(np.flatnonzero(counts == counts.max())))
            assert game.getValidMoves(st['board'], st['player'])[action]
            st['trajectory'].append(key(st['canonical']).hex())
            st['actions'].append(action)
            st['board'], st['player'] = game.getNextState(st['board'], st['player'], action)
            result = game.getGameEnded(st['board'], 1)
            if result:
                st['entry']['records'].append(dict(game_index=st['gi'], seed=seed + st['gi'],
                    orientation=st['gi'] % 8, actions=st['actions'], trajectory=st['trajectory'],
                    result=float(result), margin=int(np.sign(st['board']).sum()),
                    passes=st['actions'].count(game.regular_action_size - 1),
                    final_board=st['board'].tolist()))
            else:
                st['canonical'] = game.getCanonicalForm(st['board'], st['player'])
                remaining.append(st)
        active = remaining
        ply += 1
        assert ply < 100
        if ply % 8 == 0:
            print('ply', ply, 'active', len(active), flush=True)


def audit(game, entry):
    for rec in entry['records']:
        board = L.recenter(L.transform_board(np.array(entry['board'], dtype=np.int8), L.SYMMETRIES[rec['orientation']]))
        player = 1
        for i, action in enumerate(rec['actions']):
            assert not game.getGameEnded(board, 1)
            assert key(game.getCanonicalForm(board, player)).hex() == rec['trajectory'][i]
            assert game.getValidMoves(board, player)[action]
            board, player = game.getNextState(board, player, action)
        np.testing.assert_array_equal(board, np.array(rec['final_board'], dtype=np.int8))
        assert game.getGameEnded(board, 1) == rec['result']
        assert int(np.sign(board).sum()) == rec['margin']
        assert rec['passes'] == rec['actions'].count(game.regular_action_size - 1)


def render(out, report):
    ranked = sorted(report['screen'], key=lambda e: (e['balance_score'], e['id']))
    lines = ['# Facing free-start 배치 비교', '',
             f"모델 SHA-256: `{report['sha256']}`. 회전·반사 중복을 제외한 두 타일 배치 {len(ranked)}개를 검사했다. 색 교환은 중복으로 제거하지 않는다.", '',
             '신경망 가치는 선공 관점의 -1~+1 평가다. 대칭별 절댓값의 최댓값이 작은 배치를 후보로 고른다. 신경망 선별 순위는 실측 승률이나 공정성의 검증이 아니다. 초기 배치 선택 학습이 충분하지 않은 모델은 비인접 배치 등에서 부정확할 수 있다.', '',
             '## 신경망 기준 후보', '',
             '| 배치 ID | 평균 가치 | 방향별 가치 범위 | 최대 절댓값 |', '|---:|---:|---:|---:|']
    shown = ranked[:10]
    original = next(e for e in ranked if e['original'])
    if original not in shown:
        shown.append(original)
    for entry in report['openings']:
        if all(e['id'] != entry['id'] for e in shown):
            shown.append(entry)
    for e in shown:
        lo, hi = e['value_range']
        label = f"{e['id']} (기존)" if e['original'] else str(e['id'])
        lines.append(f"| {label} | {e['value_mean']:+.4f} | {lo:+.4f}~{hi:+.4f} | {e['balance_score']:.4f} |")
    tested = [e for e in report['openings'] if e['records']]
    if tested:
        lines += ['', '## 동일 가중치 실측', '',
                  '첫 6수는 MCTS 방문 비율로 확률 선택, 이후 최다 방문 수를 선택한다. 양쪽 모델·탐색량 동일, 루트 노이즈 없음, cpuct=1.5. 방향 8개를 균등 사용한다. Wilson 95% 구간은 이 대국 방식의 근사 구간이다.', '',
                  '| 배치 ID | 대국 수 | 선공 / 후공 승 | 선공 승률 | 95% 구간 | 평균 타일 차 |',
                  '|---:|---:|---:|---:|---:|---:|']
        for e in sorted(tested, key=lambda e: abs(e['summary']['first_win_rate'] - .5)):
            s = e['summary']; lo, hi = s['wilson_95']
            lines.append(f"| {e['id']} | {s['games']} | {s['first_wins']} / {s['second_wins']} | {s['first_win_rate']:.1%} | {lo:.1%}~{hi:.1%} | {s['mean_margin']:+.2f} |")
        lines += ['', '여러 배치 중 50%에 가까운 결과를 골랐으므로 독립 seed와 추가 대국으로 재검증해야 한다. 평가 도중 저장된 중간 보고서는 방향 배분이 아직 완료되지 않았을 수 있다. 모든 저장 대국을 재생해 합법성·진행 기록·승패·최종 보드·타일 차이를 검증했다.']
    else:
        lines += ['', '실측 대국은 아직 수행하지 않았다. 아래 후보 ID를 `--ids`로 지정해 비교할 수 있다.']
    for e in shown:
        lines += ['', f"## 배치 {e['id']}", '', '```text', L.board_to_str(np.array(e['board'], dtype=np.int8)), '```']
    (out / 'REPORT.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=HERE / 'temp/best.pth.tar')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--screen-only', action='store_true')
    parser.add_argument('--openings', type=int, default=4, help='Closest network candidates including original control')
    parser.add_argument('--ids', nargs='+', type=int)
    parser.add_argument('--games', type=int, default=16, help='Games per layout, divisible by eight')
    parser.add_argument('--sims', type=int, default=100)
    parser.add_argument('--batch-size', type=int, default=16)
    parser.add_argument('--seed', type=int, default=20261024)
    opts = parser.parse_args()
    if opts.openings < 1 or opts.games < 8 or opts.games % 8 or opts.sims < 2 or opts.batch_size < 1:
        parser.error('openings >= 1, games >= 8 divisible by 8, sims >= 2, batch-size >= 1 required')
    out = opts.output or HERE / 'evaluations' / datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    frozen = out / 'model.pth.tar'
    source = frozen if frozen.exists() else opts.model
    if not source.is_file():
        parser.error(f'Checkpoint missing: {source}; run facing-free-start/main.py --init-only first')
    torch.set_num_threads(1)
    snapshot = source.read_bytes()
    digest = hashlib.sha256(snapshot).hexdigest()
    game = FacingFreeStartGame()
    net = FacingFreeStartNet(game)
    net.nnet.load_state_dict(torch.load(io.BytesIO(snapshot), map_location=net.device, weights_only=True)['state_dict'])
    net.nnet.eval()
    out.mkdir(parents=True, exist_ok=True)
    if not frozen.exists():
        frozen.write_bytes(snapshot)
    screen_path = out / 'screen.json'
    if screen_path.exists():
        screened = json.loads(screen_path.read_text(encoding='utf-8'))
    else:
        screened = screen(game, net)
        save(screen_path, screened)
    if opts.openings > len(screened) or (opts.ids and (len(set(opts.ids)) != len(opts.ids) or any(i < 0 or i >= len(screened) for i in opts.ids))):
        parser.error(f'Use distinct layout IDs in [0, {len(screened)-1}] and openings <= {len(screened)}')
    ranked = sorted(screened, key=lambda e: (e['balance_score'], e['id']))
    selected = opts.ids or [e['id'] for e in ranked[:max(0, opts.openings - 1)]]
    if not opts.ids:
        original = next(e['id'] for e in screened if e['original'])
        if original not in selected:
            selected.append(original)
        if len(selected) < opts.openings:
            selected += [e['id'] for e in ranked if e['id'] not in selected][:opts.openings-len(selected)]
    settings = dict(sims=opts.sims, games=opts.games, seed=opts.seed, ids=selected,
                    random_plies=6, cpuct=1.5, root_noise=False, rule='facing-free-start')
    target = out / 'results.json'
    report = dict(sha256=digest, settings=settings, screen=screened,
                  openings=[dict(**screened[i], records=[]) for i in selected])
    if target.exists():
        old = json.loads(target.read_text(encoding='utf-8'))
        if old['sha256'] != digest or old['settings'] != settings:
            parser.error('Existing output has different settings; choose a new --output folder')
        report = old
    if not opts.screen_only:
        cache_transitions(game)
        tasks = [(entry, gi) for entry in report['openings'] for gi in range(opts.games)
                 if gi not in {r['game_index'] for r in entry['records']}]
        for offset in range(0, len(tasks), opts.batch_size):
            play_batch(game, net, tasks[offset:offset + opts.batch_size], opts.sims, opts.seed)
            for entry in report['openings']:
                if entry['records']:
                    entry['records'].sort(key=lambda r: r['game_index'])
                    entry['summary'] = summary(entry['records'])
                    audit(game, entry)
            save(target, report)
            render(out, report)
            print('completed', offset + len(tasks[offset:offset + opts.batch_size]), '/', len(tasks), flush=True)
    report['complete'] = all(len(e['records']) == opts.games for e in report['openings'])
    if report['complete']:
        for entry in report['openings']:
            audit(game, entry)
            assert {r['game_index'] for r in entry['records']} == set(range(opts.games))
            orientations = np.bincount([r['orientation'] for r in entry['records']], minlength=8)
            assert np.all(orientations == opts.games // 8)
    save(target, report)
    render(out, report)
    print('Results:', out, flush=True)
    print('Closest network candidates:', [(e['id'], round(e['balance_score'], 4)) for e in ranked[:10]])


if __name__ == '__main__':
    main()
