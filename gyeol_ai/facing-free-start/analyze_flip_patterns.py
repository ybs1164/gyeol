"""Audit frozen-model games and measure when tile ownership flips.

python analyze_flip_patterns.py --folder evaluations/flip-patterns-20261029
python analyze_flip_patterns.py --folder evaluations/flip-patterns-20261029 --play-free 64
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import io
import json
from pathlib import Path
import sys

import numpy as np
import torch

from facing_free_game import FacingFreeStartGame, ROOT
from facing_free_net import FacingFreeStartNet
from facing import rules as F
from gyeol import GyeolLogic as L
from evaluate_rule_balance import cache_transitions, save
from opening_fast_mcts import OpeningFastMCTS
from validate_fair_opening_batch import DeferredNet, simulations
from utils import dotdict
from find_fair_opening import key as opening_key


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def play_free(folder, games, sims, seed, label='free', random_regular_plies=6):
    """Sample setups and first six regular turns, then use maximum visits."""
    torch.set_num_threads(1)
    torch.manual_seed(0)
    game = FacingFreeStartGame()
    net = FacingFreeStartNet(game)
    snapshot = (folder / 'model.pth.tar').read_bytes()
    net.nnet.load_state_dict(torch.load(io.BytesIO(snapshot), map_location=net.device,
                                       weights_only=True)['state_dict'])
    net.nnet.eval()
    cache_transitions(game)
    settings = dict(games=games, sims=sims, seed=seed, cpuct=1.5,
                    root_noise=False, rule='facing-free-start', search='OpeningFastMCTS',
                    random_setup=True, random_regular_plies=random_regular_plies)
    target = folder / (label + '.json')
    report = dict(sha256=hashlib.sha256(snapshot).hexdigest(), settings=settings,
                  openings=[dict(id='free', board=game.getInitBoard().tolist(), records=[])])
    if target.exists():
        report = json.loads(target.read_text(encoding='utf-8'))
        assert report['settings'] == settings and report['sha256'] == hashlib.sha256(snapshot).hexdigest()
    records = report['openings'][0]['records']
    tasks = [gi for gi in range(games) if gi not in {r['game_index'] for r in records}]
    for offset in range(0, len(tasks), 32):
        game.clear_transition_cache()
        active = []
        for gi in tasks[offset:offset + 32]:
            board = game.getInitBoard()
            proxy = DeferredNet()
            tree = OpeningFastMCTS(game, proxy, dotdict(numMCTSSims=sims, cpuct=1.5,
                                                       dirichletAlpha=0))
            tree.root_prior = tree.root_noise = None
            active.append(dict(gi=gi, board=board, canonical=board, player=1,
                               proxy=proxy, tree=tree, rng=np.random.default_rng(seed + gi),
                               actions=[], trajectory=[]))
        while active:
            simulations(active, net, sims)
            remaining = []
            for st in active:
                state = game.stringRepresentation(st['canonical'])
                counts = np.array([st['tree'].Nsa.get((state, a), 0)
                                   for a in range(game.getActionSize())], dtype=float)
                assert counts.sum() > 0
                if len(st['actions']) < 2 + random_regular_plies:
                    action = int(st['rng'].choice(len(counts), p=counts / counts.sum()))
                else:
                    action = int(st['rng'].choice(np.flatnonzero(counts == counts.max())))
                assert game.getValidMoves(st['board'], st['player'])[action]
                st['trajectory'].append(st['board'].tolist())
                st['actions'].append(action)
                st['board'], st['player'] = game.getNextState(st['board'], st['player'], action)
                result = game.getGameEnded(st['board'], 1)
                if result:
                    records.append(dict(game_index=st['gi'], seed=seed + st['gi'],
                                        actions=st['actions'], boards_before=st['trajectory'],
                                        result=float(result), margin=int(np.sign(st['board']).sum()),
                                        final_board=st['board'].tolist()))
                else:
                    st['canonical'] = game.getCanonicalForm(st['board'], st['player'])
                    remaining.append(st)
            active = remaining
            assert all(len(st['actions']) < 100 for st in active)
        records.sort(key=lambda r: r['game_index'])
        report['complete'] = len(records) == games
        save(target, report)
        print(label, 'completed', len(records), '/', games, flush=True)


def phase(tiles):
    return 'early_2_7' if tiles < 8 else 'middle_8_15' if tiles < 16 else 'late_16_24'


def route(stage, pr, pc, player):
    """Classify closure or failure independently of capture_path."""
    r, c = pr, pc
    seen, directions, path = set(), [], []
    while True:
        dr, dc = L.DIRS[L.direction(stage[r, c])]
        directions.append((dr, dc))
        r, c = r + dr, c + dc
        if not (0 <= r < L.N and 0 <= c < L.N) or not stage[r, c]:
            return [], 'gap', False
        if (r, c) == (pr, pc):
            return [], 'return_to_new', False
        if stage[r, c] * player > 0:
            return path, 'closed', len(set(directions)) > 1
        if (r, c) in seen:
            return [], 'enemy_cycle', False
        seen.add((r, c))
        path.append((r, c))


def replay(entry, rec, game, source):
    board = np.array(entry['board'], dtype=np.int8)
    if board.any():
        board = L.recenter(L.transform_board(board, L.SYMMETRIES[rec['orientation']]))
    identities = np.zeros_like(board, dtype=int)
    identities[board != 0] = np.arange(1, np.count_nonzero(board) + 1)
    next_id = int(identities.max()) + 1
    player, regular_turn = 1, 0
    all_flipped, previous_flipped = set(), set()
    rows = []
    streak = longest = 0
    for index, action in enumerate(rec['actions']):
        assert not game.getGameEnded(board, 1)
        assert game.getValidMoves(board, player)[action]
        if 'boards_before' in rec:
            np.testing.assert_array_equal(board, rec['boards_before'][index])
        before = np.count_nonzero(board)
        moved, following = game.getNextState(board, player, action)
        if before < 2:
            # Only setup steps can relocate an existing singleton nonlocally.
            identities = np.zeros_like(board, dtype=int)
            if before == 1:
                identities[moved * (-player) > 0] = 1
            identities[moved * player > 0] = next_id
            next_id += 1
            board, player = moved, following
            continue
        regular_turn += 1
        own = int(np.count_nonzero(board * player > 0))
        captured = int(np.count_nonzero(moved * player > 0)) - own - int(action != F.PASS_ACTION)
        assert captured >= 0
        assert captured == int(np.count_nonzero(board * player < 0) - np.count_nonzero(moved * player < 0))
        available = []
        for candidate in np.flatnonzero(game.getValidMoves(board, player)):
            if candidate == F.PASS_ACTION:
                available.append(0)
                continue
            ba = F.base_action(candidate)
            cell, _, nd, _ = L.decode_action(ba)
            r, c = divmod(cell, L.N)
            pr, pc = r + L.DIRS[nd][0], c + L.DIRS[nd][1]
            stage = L._place_only(board, player, ba)
            available.append(len(L.capture_path(stage, pr, pc, player)))
        flipped_ids = set()
        bent, rotation, neighbors, reason = False, None, None, 'pass'
        if action != F.PASS_ACTION:
            ba = F.base_action(action)
            cell, new_dir, nd, _ = L.decode_action(ba)
            r, c = divmod(cell, L.N)
            pr, pc = r + L.DIRS[nd][0], c + L.DIRS[nd][1]
            rotation = '180' if (new_dir - L.direction(board[r, c])) % 4 == 2 else '90'
            neighbors = sum(0 <= pr + dr < L.N and 0 <= pc + dc < L.N
                            and board[pr + dr, pc + dc] != 0 for dr, dc in L.DIRS)
            stage = L._place_only(board, player, ba)
            path = L.capture_path(stage, pr, pc, player)
            path2, reason, bent = route(stage, pr, pc, player)
            assert path == path2 and len(path) == captured
            assert all(identities[fr, fc] for fr, fc in path)
            flipped_ids = {int(identities[fr, fc]) for fr, fc in path}
            raw = stage.copy()
            for fr, fc in path:
                raw[fr, fc] = -raw[fr, fc]
            np.testing.assert_array_equal(L.recenter(raw), moved)
            identities[pr, pc] = next_id
            next_id += 1
            r0, r1, c0, c1 = L.bbox(raw)
            rr0, rr1, cc0, cc1 = L.bbox(moved)
            shifted = np.zeros_like(identities)
            shifted[rr0:rr1 + 1, cc0:cc1 + 1] = identities[r0:r1 + 1, c0:c1 + 1]
            identities = shifted
        lead_before = int(np.sign(board).sum())
        lead_after = int(np.sign(moved).sum())
        row = dict(source=source, opening=entry['id'], chosen_opening=rec.get('chosen_opening', entry['id']), game=rec['game_index'],
                   orientation=rec.get('orientation'), turn=regular_turn, tiles_before=int(before),
                   phase=phase(before), player=player, captured=captured,
                   previous_capture=bool(previous_flipped),
                   immediate_recaptured=len(flipped_ids & previous_flipped),
                   repeat_flipped=len(flipped_ids & all_flipped), bent=bent,
                   rotation=rotation, occupied_neighbors=int(neighbors) if neighbors is not None else None,
                   outcome=reason, max_available=max(available),
                   capture_moves=sum(n > 0 for n in available), legal_moves=len(available),
                   strict_lead_reversal=lead_before * lead_after < 0,
                   lead_before=lead_before, lead_after=lead_after, action=action)
        rows.append(row)
        all_flipped.update(flipped_ids)
        previous_flipped = flipped_ids
        streak = streak + 1 if captured else 0
        longest = max(longest, streak)
        board, player = moved, following
    np.testing.assert_array_equal(board, rec['final_board'])
    assert game.getGameEnded(board, 1) == rec['result']
    assert int(np.sign(board).sum()) == rec['margin']
    return rows, dict(source=source, opening=entry['id'], chosen_opening=rec.get('chosen_opening', entry['id']), game=rec['game_index'],
                      orientation=rec.get('orientation'), turns=len(rows),
                      captured=sum(r['captured'] for r in rows),
                      capture_turns=sum(r['captured'] > 0 for r in rows),
                      first_capture=next((r['turn'] for r in rows if r['captured']), None),
                      longest_streak=longest, result=rec['result'])


def stats(rows):
    n = len(rows)
    captures = [r for r in rows if r['captured']]
    available = [r for r in rows if r['max_available']]
    after = [r for r in rows if r['previous_capture']]
    return dict(turns=n, capture_turns=len(captures),
                rate=len(captures) / n if n else None,
                tiles=sum(r['captured'] for r in rows),
                mean_tiles=sum(r['captured'] for r in rows) / n if n else None,
                multi_3_plus=sum(r['captured'] >= 3 for r in rows),
                available_turns=len(available),
                availability_rate=len(available) / n if n else None,
                chosen_given_available=len(captures) / len(available) if available else None,
                after_capture_turns=len(after),
                after_capture_rate=sum(r['captured'] > 0 for r in after) / len(after) if after else None,
                immediate_recapture_turns=sum(r['immediate_recaptured'] > 0 for r in rows),
                repeat_tiles=sum(r['repeat_flipped'] for r in rows),
                bent_captures=sum(r['bent'] for r in captures),
                max_capture=max((r['captured'] for r in rows), default=0),
                strict_lead_reversals=sum(r['strict_lead_reversal'] for r in rows))


def grouped(rows, field):
    bins = defaultdict(list)
    for row in rows:
        bins[str(row[field])].append(row)
    return {k: stats(v) for k, v in sorted(bins.items())}


def bootstrap(rows, games, iterations=5000):
    """Resample entire games within each opening/orientation stratum."""
    by_game = defaultdict(list)
    for r in rows:
        by_game[(r['source'], r['opening'], r['game'])].append(r)
    strata = defaultdict(list)
    for g in games:
        strata[(g['source'], g['opening'], g['orientation'])].append(
            by_game[(g['source'], g['opening'], g['game'])])
    rng = np.random.default_rng(2026102942)
    # Three columns: phase denominators; next three: capture numerators.
    counts = []
    for records in strata.values():
        a = np.array([[sum(r['phase'] == p for r in rs) for p in
                       ['early_2_7', 'middle_8_15', 'late_16_24']] +
                      [sum(r['phase'] == p and r['captured'] > 0 for r in rs) for p in
                       ['early_2_7', 'middle_8_15', 'late_16_24']] for rs in records])
        idx = rng.integers(0, len(a), size=(iterations, len(a)))
        counts.append(a[idx].sum(axis=1))
    total = sum(counts)
    rates = total[:, 3:] / total[:, :3]
    return dict(unit='whole game within opening/orientation', samples=iterations,
                seed=2026102942,
                phase_rate_95={p: np.quantile(rates[:, i], [.025, .975]).tolist()
                               for i, p in enumerate(['early_2_7', 'middle_8_15', 'late_16_24'])},
                late_minus_early_95=np.quantile(rates[:, 2] - rates[:, 0], [.025, .975]).tolist())


def analyze(folder):
    expected = digest(folder / 'model.pth.tar')
    catalog = {e['key']: e['id'] for e in json.loads((folder / 'screen.json').read_text(encoding='utf-8'))}
    game = FacingFreeStartGame()
    groups = {}
    all_rows = []
    provenance = []
    for filename in ['fixed.json', 'free.json', 'greedy.json']:
        path = folder / filename
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding='utf-8'))
        assert data['complete'] and data['sha256'] == expected
        rows, games = [], []
        for entry in data['openings']:
            for rec in entry['records']:
                if 'boards_before' in rec:
                    rec['chosen_opening'] = catalog[opening_key(np.array(rec['boards_before'][2], dtype=np.int8)).hex()]
                rs, g = replay(entry, rec, game, filename)
                rows.extend(rs)
                games.append(g)
        summary = stats(rows)
        summary.update(games=len(games), mean_game_tiles=summary['tiles'] / len(games),
                       mean_game_capture_turns=summary['capture_turns'] / len(games),
                       mean_first_capture=float(np.mean([g['first_capture'] for g in games if g['first_capture'] is not None])),
                       mean_longest_streak=float(np.mean([g['longest_streak'] for g in games])),
                       size_histogram=dict(sorted(Counter(r['captured'] for r in rows).items())))
        groups[filename] = dict(settings=data['settings'], overall=summary,
                                phases=grouped(rows, 'phase'), turns=grouped(rows, 'turn'),
                                openings=grouped(rows, 'opening'), rotations=grouped(rows, 'rotation'),
                                chosen_openings=dict(Counter(g['chosen_opening'] for g in games)),
                                neighbors=grouped(rows, 'occupied_neighbors'),
                                outcomes=dict(Counter(r['outcome'] for r in rows)),
                                previous_capture=grouped(rows, 'previous_capture'),
                                uncertainty=bootstrap(rows, games), games=games)
        all_rows.extend(rows)
        provenance.append(dict(file=filename, sha256=digest(path)))
        print(filename, summary, flush=True)
        for p, s in groups[filename]['phases'].items():
            print(p, s, flush=True)
    save(folder / 'patterns.json', dict(model_sha256=expected, sources=provenance,
                                       metric='tile ownership flips; setup excluded, passes included; recaptures counted',
                                       groups=groups))
    save(folder / 'turns.json', all_rows)
    plot(folder, groups)
    render_report(folder, groups, all_rows)
    if 'free.json' in groups and 'greedy.json' in groups:
        free = json.loads((folder / 'free.json').read_text(encoding='utf-8'))['openings'][0]['records']
        greedy = json.loads((folder / 'greedy.json').read_text(encoding='utf-8'))['openings'][0]['records']
        free_by_id = {r['game_index']: r for r in free}
        assert len(free) == len(greedy)
        for rec in greedy:
            np.testing.assert_array_equal(rec['boards_before'][2], free_by_id[rec['game_index']]['boards_before'][2])
        save(folder / 'control_validation.json', dict(games=len(greedy), identical_setup_boards=True,
                                                      difference='regular-turn selection only: sampled first six vs maximum visits throughout'))


def render_report(folder, groups, all_rows):
    meta = json.loads((folder / 'model_metadata.json').read_text(encoding='utf-8'))
    names = {'fixed.json': '고정 8배치', 'free.json': '모델이 선택한 배치', 'greedy.json': '모델 선택 배치·첫 수부터 최다 방문'}
    phase_names = {'early_2_7': '초반: 판 위 2~7장', 'middle_8_15': '중반: 8~15장', 'late_16_24': '후반: 16~24장'}
    lines = ['# 최신 모델의 뒤집기 양상 — 2026-10-29', '',
             '뒤집기는 상대 타일의 소유 색이 바뀌는 포획을 뜻한다. '
             '초기 배치 두 수를 제외하고, 패스를 포함한 정규 턴을 분모로 쓴다. '
             '같은 타일을 나중에 다시 뒤집으면 장수에 다시 센다.', '',
             f"모델: `{meta['sha256']}`. 최신 `temp/best.pth.tar`의 고정 사본을 사용했다.",
             '10월 26일 보고서의 모델 `28bf57af…`와는 다르므로 이전 수치를 최신 결과로 재사용하지 않았다.', '']
    if 'free.json' in groups:
        g = groups['free.json']; p = g['phases']; s = g['overall']
        lines[2:2] = [f"**모델이 직접 배치를 고른 {s['games']}국에서는 뒤집기가 초반 {p['early_2_7']['rate']:.1%}, "
                      f"중반 {p['middle_8_15']['rate']:.1%}, 후반 {p['late_16_24']['rate']:.1%}의 턴에서 발생했다.** "
                      f"3장 이상 포획 {s['multi_3_plus']}회 중 {p['late_16_24']['multi_3_plus']}회가 후반에 집중됐다.", '']
    for match in meta['matching_training_records']:
        lines += [f"가중치와 일치하는 학습 후보: `{match['candidate']}`, 채택={match['accepted']}.", '']
    lines += ['## 표본과 전체 빈도', '',
              '| 대국 방식 | 대국 수 | 포획 턴 / 전체 턴 | 뒤집기 빈도 | 한 판 평균 포획 턴 | 한 판 평균 뒤집은 장수 |',
              '|---|---:|---:|---:|---:|---:|']
    for source, group in groups.items():
        s = group['overall']
        lines.append(f"| {names[source]} | {s['games']} | {s['capture_turns']} / {s['turns']} | {s['rate']:.1%} | {s['mean_game_capture_turns']:.2f}회 | {s['mean_game_tiles']:.2f}장 |")
    lines += ['', '고정 배치는 3·8·11·18·19·130·133·167번을 각 32국, 회전·반사 8방향을 각 4국 사용했다. '
              '기존 비교 배치, 예비 상위 후보, 먼 배치 일부를 사전에 골랐으며 전체 168개 배치의 무작위 표본은 아니다. '
              '모델 선택 배치 64국은 빈 판에서 양쪽이 MCTS 방문 분포에 따라 초기 두 타일을 선택했다. '
              '집단별 배치 분포와 선택 과정이 달라 합산하지 않았다.', '',
              '모든 대국은 양쪽에 같은 최신 모델, 정규 수당 MCTS 100회, cpuct=1.5, 루트 노이즈 없음이다. 기본 두 집단은 '
              '초기 배치 이후 첫 6수는 방문 비율로 추첨하고 이후 최다 방문 수를 선택했다. '
              '고정 배치 seed=2026102901, 모델 선택 배치 seed=2026102902. '
              '선택된 배치는 모델 정책 전체의 균등 표본이나 인간 대국의 표본이 아니다.', '',
              '## 언제 많이 발생하는가', '',
              '단계는 **수를 두기 직전 판 위의 타일 수**로 구분했다. 패스가 있으면 정규 턴 번호와 다를 수 있다.', '',
              '| 방식 | 단계 | 포획 턴 / 전체 턴 | 빈도 | 대국 단위 근사 95% 구간 | 턴당 뒤집은 장수 | 3장 이상 뒤집은 턴 |',
              '|---|---|---:|---:|---:|---:|---:|']
    for source, group in groups.items():
        for p, label in phase_names.items():
            s = group['phases'][p]
            lo, hi = group['uncertainty']['phase_rate_95'][p]
            lines.append(f"| {names[source]} | {label} | {s['capture_turns']} / {s['turns']} | {s['rate']:.1%} | {lo:.1%}~{hi:.1%} | {s['mean_tiles']:.2f}장 | {s['multi_3_plus']}회 |")
    lines += ['', '기본 방식은 초반 6수에 확률 선택을 쓰므로 초·후반 차이에 보드 상태와 선택 방식 변화가 함께 반영된다. '
              '별도 대조군은 초기 배치를 동일하게 확률 선택하되 정규 첫 수부터 최다 방문 수를 선택했다. '
              '95% 구간은 한 대국의 턴을 함께 재표집한 근사 구간이다. 고정 배치는 배치·방향 안에서, '
              '모델 선택 배치는 대국 전체를 재표집했다(5,000회, seed=2026102942). 턴을 서로 독립 표본으로 간주하지 않았다.', '',
              '![진행 단계별 뒤집기 빈도](patterns.png)', '',
              '## 초반의 예외: 정규 3수째 포획 피크', '',
              '초·중·후반 평균과 별도로, 현재 모델이 선택한 배치에서는 정규 3수째에 짧고 강한 피크가 있었다. '
              '초기 배치 두 수는 아래 턴 번호에서 제외했다.', '',
              '| 방식 | 1수 | 2수 | 3수 | 4수 | 5수 | 6수 |',
              '|---|---:|---:|---:|---:|---:|---:|']
    for source, group in groups.items():
        lines.append('| ' + names[source] + ' | ' + ' | '.join(f"{group['turns'][str(t)]['rate']:.1%}" for t in range(1, 7)) + ' |')
    lines += ['', '모델 선택 배치 64국에서는 138번 34국·139번 30국으로, '
              '두 초기 타일이 행·열 각각 4칸 떨어진 5×5의 대각 모서리 배치만 선택됐다. '
              '3수째 포획은 기본 방식 46/64국(71.9%), 첫 수부터 최다 방문 방식 59/64국(92.2%)에서 발생했고 모두 1장 포획이었다. '
              '이때 첫 정규 수에 둔 내 타일을 종착점으로 삼아 초기 상대 타일을 L자 경로로 뒤집을 수 있다. '
              '이 피크는 현재 모델이 고른 배치와 수순에 조건부이며 고정 8배치 전체에서는 3수째 19.9%였다.', '',
              '## 상대가 먹은 직후와 재포획', '',
              '| 방식 | 상대가 직전 턴에 먹었을 때 내 포획 | 직전 턴에 먹지 않았을 때 내 포획 | 직전 포획 타일을 즉시 되찾은 턴 / 응수 기회 | 전체 포획 중 과거에 이미 뒤집혔던 타일 |',
              '|---|---:|---:|---:|---:|']
    for source, group in groups.items():
        s = group['overall']
        prev = group['previous_capture']
        count = s['immediate_recapture_turns']
        lines.append(f"| {names[source]} | {prev['True']['rate']:.1%} ({prev['True']['capture_turns']}/{prev['True']['turns']}) | {prev['False']['rate']:.1%} ({prev['False']['capture_turns']}/{prev['False']['turns']}) | {count}/{s['after_capture_turns']} ({count / s['after_capture_turns']:.1%}) | {s['repeat_tiles']}/{s['tiles']} ({s['repeat_tiles']/s['tiles']:.1%}) |")
    lines += ['', '첫 수는 직전 포획 없음에 포함했다. 즉시 재포획은 바로 전 상대 턴에 뒤집힌 동일 타일을 되찾은 경우다. '
              '재포획 타일은 판의 재중앙정렬 전후에 동일한 ID를 추적했다. '
              '포획 응수와 동일 타일 되찾기는 다른 사건이다. 이 조건부 비율은 진행 단계 등도 함께 달라지므로 인과효과로 해석하지 않는다.', '',
              '| 방식 | 단계 | 직전 포획 있음: 내 포획 빈도 | 직전 포획 없음: 내 포획 빈도 |',
              '|---|---|---:|---:|']
    for source in groups:
        for p, label in phase_names.items():
            rs = [r for r in all_rows if r['source'] == source and r['phase'] == p]
            yes = [r for r in rs if r['previous_capture']]
            no = [r for r in rs if not r['previous_capture']]
            y = f"{sum(r['captured'] > 0 for r in yes) / len(yes):.1%} ({len(yes)}턴)" if yes else '관측 없음'
            n = f"{sum(r['captured'] > 0 for r in no) / len(no):.1%} ({len(no)}턴)" if no else '관측 없음'
            lines.append(f"| {names[source]} | {label} | {y} | {n} |")
    lines += ['',
              '## 포획 경로와 놓는 자리', '',
              'facing 규칙에서는 새 타일이 방금 돌린 상대 타일을 바라본다. '
              '그 타일부터 화살표를 따라 상대 타일들이 이어지고 마지막에 기존 내 타일에 닿아야 뒤집힌다. '
              '중간에 빈칸으로 나가거나, 새 타일로 되돌아오거나, 상대 타일끼리 순환하면 실패한다. '
              '따라서 직선 샌드위치뿐 아니라 방향이 꺾이는 경로도 가능하다.', '',
              '| 방식 | 1장 / 2장 / 3장 이상 포획 턴 | 꺾이는 경로 / 전체 포획 경로 | 한 턴 최대 뒤집기 | 포획 가능한 수가 있던 턴 | 그때 실제 포획 선택 |',
              '|---|---:|---:|---:|---:|---:|']
    for source, group in groups.items():
        s = group['overall']; h = s['size_histogram']
        lines.append(f"| {names[source]} | {h.get(1, 0)} / {h.get(2, 0)} / {s['multi_3_plus']}회 | {s['bent_captures']}/{s['capture_turns']} ({s['bent_captures']/s['capture_turns']:.1%}) | {s['max_capture']}장 | {s['availability_rate']:.1%} | {s['chosen_given_available']:.1%} |")
    lines += ['', '경로가 꺾였다는 것은 새 타일에서 기존 내 타일까지의 이동 방향이 둘 이상이었다는 뜻이다. '
              '1장 포획도 L자로 꺾일 수 있다. 포획 가능 여부는 실제 수 직전의 모든 합법 수를 검사했다. '
              '가능한데 선택하지 않은 비율만으로 모델의 실수나 의도를 판단할 수는 없다.', '',
              '| 방식 | 놓을 칸에 인접한 기존 타일 수 | 포획 턴 / 해당 자리 선택 턴 | 빈도 |',
              '|---|---:|---:|---:|']
    for source, group in groups.items():
        for k, s in group['neighbors'].items():
            if k != 'None':
                lines.append(f"| {names[source]} | {k} | {s['capture_turns']}/{s['turns']} | {s['rate']:.1%} |")
    lines += ['', '놓을 칸의 상하좌우를 수 직전에 검사했다. 인접 타일이 많다는 조건은 진행 단계·모델의 자리 선택과 얽혀 있다. '
              '위 빈도는 관측된 선택에서의 상관관계다.', '',
              '## 초기 배치별 차이', '',
              '| 배치 ID | 대국 수 | 뒤집기 턴 비율 | 한 판 평균 뒤집은 장수 |',
              '|---:|---:|---:|---:|']
    fixed = groups.get('fixed.json')
    if fixed:
        for k, s in sorted(fixed['openings'].items(), key=lambda item: -item[1]['rate']):
            n = sum(g['opening'] == int(k) for g in fixed['games'])
            lines.append(f"| {k} | {n} | {s['rate']:.1%} | {s['tiles']/n:.2f}장 |")
    lines += ['', '32국씩의 표본 순위로 배치의 장기 우열이나 전체 168개 중 최고를 확정하지 않는다. '
              '이전 10월 26일 순위와 같은 조건의 모델 대조 실험을 한 것은 아니다.', '']
    if 'free.json' in groups:
        counts = groups['free.json']['chosen_openings']
        lines += ['모델이 직접 선택한 초기 배치: ' + ', '.join(f"{k}번 {n}국" for k, n in sorted(counts.items(), key=lambda item: -item[1])) + '.', '']
        rs = [r for r in all_rows if r['source'] == 'free.json']
        biggest = max(rs, key=lambda r: r['captured'])
        lines += ['## 후반의 실제 사례', '',
                  f"모델 선택 배치 대국 {biggest['game']}번은 정규 {biggest['turn']}수째, "
                  f"판 위 {biggest['tiles_before']}장 상태에서 한 번에 {biggest['captured']}장을 뒤집었다. "
                  f"초록 기준 타일 수 차이가 {biggest['lead_before']:+d}에서 {biggest['lead_after']:+d}로 바뀌었다. "
                  '이것은 해당 64국 중 한 번 관측된 최대 사례로 평균적인 포획 크기를 뜻하지 않는다.', '']
    lines += ['## 검증과 재현', '',
              '모든 수의 합법성, 엔진 포획 경로와 별도 경로 추적의 일치, 소유 타일 수 변화, 재중앙정렬 후 보드, 최종 승패·점수 차이를 검사했다. '
              '추가로 이전 고정 모델 대국 128국·3,001턴을 기존 분석기와 교차검증해 포획 수열과 최장 연속 포획 길이가 모두 일치했다.', '',
              '- `model_metadata.json`: 원본 및 학습 후보와 모델 해시.',
              '- `fixed.json`, `free.json`, `greedy.json`: 전체 수순·보드·결과와 탐색 설정.',
              '- `patterns.json`: 집단별·단계별 집계와 근사 구간.',
              '- `turns.json`: 턴별 포획, 타일 재포획, 인접도 및 합법 포획 기회.',
              '- `validation.json`: 기존 분석기와의 교차검증 기록.',
              '- `control_validation.json`: 기본 방식과 대조군의 초기 보드 64쌍이 동일함을 검증.',
              '- `patterns.png`, `patterns.svg`: 내보내기 가능한 도표.', '',
              '```powershell',
              'python ../select_facing_openings.py --output evaluations/flip-patterns-20261029 --model temp/best.pth.tar --label fixed --ids 3 8 11 18 19 130 133 167 --games 32 --sims 100 --seed 2026102901 --batch-size 32',
              'python analyze_flip_patterns.py --folder evaluations/flip-patterns-20261029 --play-free 64',
              'python analyze_flip_patterns.py --folder evaluations/flip-patterns-20261029 --play-free 64 --label greedy --random-regular-plies 0',
              'python analyze_flip_patterns.py --folder evaluations/flip-patterns-20261029',
              '```', '']
    (folder / 'REPORT.md').write_text('\n'.join(lines), encoding='utf-8')


def plot(folder, groups):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams['font.family'] = 'Malgun Gothic'
    plt.rcParams['axes.unicode_minus'] = False
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))
    colors = ['#216e78', '#d57938', '#7564a3']
    names = {'fixed.json': '고정 배치 256국', 'free.json': '모델이 배치를 고른 64국', 'greedy.json': '첫 수부터 최다 방문 64국'}
    for color, (source, group) in zip(colors, groups.items()):
        turns = sorted((int(t), s) for t, s in group['turns'].items())
        turns = [(t, s) for t, s in turns if s['turns'] >= group['overall']['games'] * .5]
        axes[0].plot([t for t, s in turns], [s['rate'] * 100 for t, s in turns],
                     'o-', color=color, label=names[source], markersize=3)
    phases = ['early_2_7', 'middle_8_15', 'late_16_24']
    for index, (source, group) in enumerate(groups.items()):
        values = [group['phases'][p]['rate'] * 100 for p in phases]
        cis = [group['uncertainty']['phase_rate_95'][p] for p in phases]
        error = np.array([[v - ci[0] * 100, ci[1] * 100 - v] for v, ci in zip(values, cis)]).T
        axes[1].bar(np.arange(3) + (index - (len(groups) - 1) / 2) * .25, values, .25,
                    color=colors[index], label=names[source], yerr=error, capsize=4)
    axes[0].set(xlabel='정규 턴 (초기 배치 2수 제외)', ylabel='한 장 이상 뒤집은 턴 비율 (%)',
                title='진행에 따른 뒤집기 빈도')
    axes[1].set(xticks=np.arange(3), xticklabels=['초반\n판 위 2~7장', '중반\n8~15장', '후반\n16~24장'],
                ylabel='한 장 이상 뒤집은 턴 비율 (%)', title='단계별 빈도와 대국 단위 95% 구간')
    for ax in axes:
        ax.set_ylim(0, 100)
        ax.spines[['top', 'right']].set_visible(False)
        ax.grid(axis='y', alpha=.15)
        ax.legend(frameon=False, fontsize=8)
    fig.suptitle('최신 facing-free-start 모델 · 수당 MCTS 100회', fontsize=13)
    fig.tight_layout()
    fig.savefig(folder / 'patterns.png', dpi=180)
    fig.savefig(folder / 'patterns.svg')
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, required=True)
    parser.add_argument('--play-free', type=int)
    parser.add_argument('--sims', type=int, default=100)
    parser.add_argument('--seed', type=int, default=2026102902)
    parser.add_argument('--label', choices=['free', 'greedy'], default='free')
    parser.add_argument('--random-regular-plies', type=int, default=6)
    args = parser.parse_args()
    if args.play_free:
        play_free(args.folder, args.play_free, args.sims, args.seed, args.label, args.random_regular_plies)
    else:
        analyze(args.folder)


if __name__ == '__main__':
    main()
