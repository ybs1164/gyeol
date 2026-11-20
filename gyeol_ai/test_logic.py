"""규칙 검증.  실행: python test_logic.py"""
import numpy as np

from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame

N_, E_, S_, W_ = 0, 1, 2, 3


def t(owner, d):
    return owner * (d + 1)


def test_initial():
    b = L.initial_board()
    assert L.tile_count(b) == 2
    (r1, c1), (r2, c2) = zip(*np.nonzero(b))
    assert b[r1, c1] == t(1, E_) and b[r2, c2] == t(-1, W_), "서로 마주봐야 함"


def test_capture_follow():
    # 룰북 7. 먹기: 놓은 G→ 가 b→, b↑, b← 를 따라가 G↑ 에 도착 → 3개 뒤집기
    b = np.zeros((L.N, L.N), dtype=np.int8)
    b[2, 3] = t(1, N_);  b[2, 4] = t(-1, W_)
    b[3, 2] = t(1, E_);  b[3, 3] = t(-1, E_);  b[3, 4] = t(-1, N_)
    assert sorted(L.capture_path(b, 3, 2, 1)) == [(2, 4), (3, 3), (3, 4)]


def test_capture_back_to_start():
    # 룰북 7. 마지막: 경로가 시작한 타일로 돌아오면 먹지 못함
    b = np.zeros((L.N, L.N), dtype=np.int8)
    b[2, 2] = t(-1, S_);  b[2, 3] = t(-1, W_)
    b[3, 2] = t(1, E_);   b[3, 3] = t(-1, N_)
    assert L.capture_path(b, 3, 2, 1) == []


def test_capture_dead_end():
    b = np.zeros((L.N, L.N), dtype=np.int8)
    b[3, 2] = t(1, E_);  b[3, 3] = t(-1, E_)   # 상대 타일이 빈 칸을 바라봄
    assert L.capture_path(b, 3, 2, 1) == []


def test_apply_move_flips_keep_direction():
    b = np.zeros((L.N, L.N), dtype=np.int8)
    b[2, 3] = t(1, N_);  b[2, 4] = t(-1, W_)
    b[3, 3] = t(-1, S_); b[3, 4] = t(-1, N_)
    # (3,3)의 b↓ 를 → 로 돌리고, 그 왼쪽 (3,2)에 G→ 를 놓는다
    a = L.encode_action(3 * L.N + 3, E_, W_, E_)
    assert L.valid_vector(b, 1)[a]
    nb = L.apply_move(b, 1, a)
    assert int((nb > 0).sum()) == 5 and int((nb < 0).sum()) == 0
    dirs = sorted(L.direction(v) for v in nb[nb != 0])
    assert dirs == sorted([N_, N_, E_, E_, W_]), "뒤집혀도 방향은 유지"


def test_rotate_rules():
    b = L.initial_board()
    v = L.valid_vector(b, 1)
    for a in np.flatnonzero(v):
        cell, nd, nb, pd = L.decode_action(a)
        r, c = divmod(cell, L.N)
        assert b[r, c] < 0, "상대 타일만 돌림"
        assert nd != L.direction(b[r, c]), "기존 방향 금지"
    # 갈색 1개 x 새 방향 3 x 빈 이웃 3 x 놓을 방향 4
    assert v.sum() == 3 * 3 * 4


def test_five_limit():
    b = np.zeros((L.N, L.N), dtype=np.int8)
    for c in range(1, 6):
        b[3, c] = t(-1 if c % 2 else 1, N_)
    ok = L.placeable_mask(b)
    assert not ok[3, 0] and not ok[3, 6], "5칸 줄의 양 끝은 금지"
    assert ok[2, 3] and ok[4, 3]


def test_symmetry_consistency(trials=300):
    g = GyeolGame()
    rng = np.random.default_rng(0)
    for _ in range(trials):
        b, p = g.getInitBoard(), 1
        for _ in range(rng.integers(0, 15)):
            b, p = g.getNextState(b, p, rng.choice(np.flatnonzero(g.getValidMoves(b, p))))
        cb = g.getCanonicalForm(b, p)
        valids = g.getValidMoves(cb, 1)
        a = int(rng.choice(np.flatnonzero(valids)))
        for sym in L.SYMMETRIES:
            tb = L.transform_board(cb, sym)
            ta = int(sym[2][a])
            assert np.array_equal(L.transform_pi(valids, sym), g.getValidMoves(tb, 1))
            n1 = L.recenter(L.transform_board(L.apply_move(cb, 1, a), sym))
            n2 = L.apply_move(tb, 1, ta)
            assert np.array_equal(n1, n2)


def test_random_games(n=500):
    g = GyeolGame()
    rng = np.random.default_rng(1)
    early, passes, wins = 0, 0, {1: 0, -1: 0}
    for _ in range(n):
        b, p = g.getInitBoard(), 1
        while g.getGameEnded(b, p) == 0:
            v = g.getValidMoves(b, p)
            if v[L.PASS_ACTION]:
                passes += 1
            b, p = g.getNextState(b, p, int(rng.choice(np.flatnonzero(v))))
        if L.tile_count(b) < 25:
            early += 1
        r = g.getGameEnded(b, 1)
        wins[1 if r > 0 else -1] += 1
        r0, r1, c0, c1 = L.bbox(b)
        assert r1 - r0 < 5 and c1 - c0 < 5
    print(f"  랜덤 {n}판: 패스 {passes}회, 25개 전에 끝난 판 {early}, 초록 {wins[1]}승 / 갈색 {wins[-1]}승")


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
            print(f"OK  {name}")
