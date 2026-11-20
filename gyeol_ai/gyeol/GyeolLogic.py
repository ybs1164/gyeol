"""
결(GYEOL) 게임 규칙 구현.

보드 표현 (numpy int8, N x N, 기본 7x7)
    0            : 빈 칸
    owner*(d+1)  : 타일. owner = +1(초록, 선공) / -1(갈색), d = 방향(0=북,1=동,2=남,3=서)

판은 고정된 좌표가 없고 떠다니는 형태이므로, 매 수마다 타일 묶음의 외곽 사각형을
보드 중앙으로 다시 옮긴다(recenter). 전체 범위는 최대 5x5 이므로 7x7 보드에서
언제나 바깥쪽으로 한 칸 이상의 여유가 있다.

한 수(action) = (돌릴 상대 타일 칸, 새 방향, 놓을 칸의 방향(돌린 타일 기준 인접 칸), 놓을 타일 방향)
"""
import numpy as np

N = 7            # 내부 보드 크기
LIMIT = 5        # 가로/세로 최대 범위 (5x5)
TOTAL_TILES = 25

# 북, 동, 남, 서
DIRS = [(-1, 0), (0, 1), (1, 0), (0, -1)]
DIR_NAMES = ['N', 'E', 'S', 'W']
ARROWS = ['↑', '→', '↓', '←']

NUM_CELLS = N * N
PASS_ACTION = NUM_CELLS * 4 * 4 * 4
ACTION_SIZE = PASS_ACTION + 1


def encode_action(cell, new_dir, nbr_dir, place_dir):
    return ((cell * 4 + new_dir) * 4 + nbr_dir) * 4 + place_dir


def decode_action(a):
    place_dir = a % 4
    a //= 4
    nbr_dir = a % 4
    a //= 4
    new_dir = a % 4
    cell = a // 4
    return cell, new_dir, nbr_dir, place_dir


def owner(v):
    return 0 if v == 0 else (1 if v > 0 else -1)


def direction(v):
    return abs(int(v)) - 1


def initial_board():
    b = np.zeros((N, N), dtype=np.int8)
    r, c = N // 2, (N - 2) // 2
    b[r, c] = 1 * (1 + 1)       # 초록, 동쪽(→)
    b[r, c + 1] = -1 * (3 + 1)  # 갈색, 서쪽(←)  — 서로 마주보게
    return b


def tile_count(board):
    return int(np.count_nonzero(board))


def bbox(board):
    rows = np.where(board.any(axis=1))[0]
    cols = np.where(board.any(axis=0))[0]
    return rows[0], rows[-1], cols[0], cols[-1]


def recenter(board):
    r0, r1, c0, c1 = bbox(board)
    h, w = r1 - r0 + 1, c1 - c0 + 1
    nr, nc = (N - h) // 2, (N - w) // 2
    if nr == r0 and nc == c0:
        return board
    out = np.zeros_like(board)
    out[nr:nr + h, nc:nc + w] = board[r0:r1 + 1, c0:c1 + 1]
    return out


def placeable_mask(board):
    """빈 칸이면서, 그 칸에 놓아도 전체 범위가 5x5 를 넘지 않는 칸."""
    r0, r1, c0, c1 = bbox(board)
    rows = np.arange(N)
    cols = np.arange(N)
    row_ok = (np.maximum(r1, rows) - np.minimum(r0, rows) + 1) <= LIMIT
    col_ok = (np.maximum(c1, cols) - np.minimum(c0, cols) + 1) <= LIMIT
    return (board == 0) & row_ok[:, None] & col_ok[None, :]


def legal_moves(board, player):
    """player 기준 합법 수 리스트(패스 제외)."""
    moves = []
    ok = placeable_mask(board)
    rs, cs = np.where(board * player < 0)  # 상대 타일
    for r, c in zip(rs, cs):
        cur = direction(board[r, c])
        cell = r * N + c
        for nd, (dr, dc) in enumerate(DIRS):
            pr, pc = r + dr, c + dc
            if 0 <= pr < N and 0 <= pc < N and ok[pr, pc]:
                for new_dir in range(4):
                    if new_dir == cur:
                        continue
                    for pd in range(4):
                        moves.append(encode_action(cell, new_dir, nd, pd))
    return moves


def valid_vector(board, player):
    v = np.zeros(ACTION_SIZE, dtype=np.uint8)
    ok = placeable_mask(board)
    rs, cs = np.where(board * player < 0)
    base = np.arange(4)
    for r, c in zip(rs, cs):
        cur = direction(board[r, c])
        cell = r * N + c
        for nd, (dr, dc) in enumerate(DIRS):
            pr, pc = r + dr, c + dc
            if 0 <= pr < N and 0 <= pc < N and ok[pr, pc]:
                for new_dir in range(4):
                    if new_dir != cur:
                        start = encode_action(cell, new_dir, nd, 0)
                        v[start + base] = 1
    if not v.any():
        v[PASS_ACTION] = 1
    return v


def has_move(board, player):
    ok = placeable_mask(board)
    rs, cs = np.where(board * player < 0)
    for r, c in zip(rs, cs):
        for dr, dc in DIRS:
            pr, pc = r + dr, c + dc
            if 0 <= pr < N and 0 <= pc < N and ok[pr, pc]:
                return True
    return False


def capture_path(board, pr, pc, player):
    """(pr,pc)에 막 놓인 player 타일에서 시작하는 먹기 경로. 뒤집을 칸 리스트를 반환."""
    d = direction(board[pr, pc])
    dr, dc = DIRS[d]
    r, c = pr + dr, pc + dc
    path = []
    seen = set()
    while True:
        if not (0 <= r < N and 0 <= c < N) or board[r, c] == 0:
            return []                 # 빈 칸 / 판 밖 → 먹기 실패
        o = owner(board[r, c])
        if o == player:
            if (r, c) == (pr, pc):
                return []             # 시작한 타일로 돌아옴 → 먹기 실패
            return path               # 다른 내 타일에 도착 → 경로의 상대 타일 모두 뒤집기
        if (r, c) in seen:
            return []                 # 상대 타일끼리 순환 → 끝이 없음
        seen.add((r, c))
        path.append((r, c))
        dr, dc = DIRS[direction(board[r, c])]
        r, c = r + dr, c + dc


def apply_move(board, player, action):
    """새 보드를 반환(원본 불변). 패스면 그대로."""
    if action == PASS_ACTION:
        return board.copy()
    return recenter(_apply_raw(board, player, action))


def apply_move_verbose(board, player, action):
    """apply_move + 화면 표시용 정보 (돌린 칸, 놓은 칸, 뒤집힌 칸들 — 모두 중앙 정렬 후 좌표)."""
    if action == PASS_ACTION:
        return board.copy(), {'pass': True}
    cell, new_dir, nd, pd = decode_action(action)
    r, c = divmod(cell, N)
    pr, pc = r + DIRS[nd][0], c + DIRS[nd][1]
    b = _apply_raw(board, player, action)
    flipped = capture_path(_place_only(board, player, action), pr, pc, player)
    r0, _, c0, _ = bbox(b)
    out = recenter(b)
    r1, _, c1, _ = bbox(out)
    dr, dc = r1 - r0, c1 - c0
    info = {
        'rotated': [int(r + dr), int(c + dc)],
        'placed': [int(pr + dr), int(pc + dc)],
        'flipped': [[int(fr + dr), int(fc + dc)] for fr, fc in flipped],
    }
    return out, info


def _place_only(board, player, action):
    cell, new_dir, nd, pd = decode_action(action)
    b = board.copy()
    r, c = divmod(cell, N)
    b[r, c] = -player * (new_dir + 1)
    b[r + DIRS[nd][0], c + DIRS[nd][1]] = player * (pd + 1)
    return b


def _apply_raw(board, player, action):
    """돌리기 → 놓기 → 먹기 (중앙 정렬 전)."""
    cell, new_dir, nd, pd = decode_action(action)
    b = board.copy()
    r, c = divmod(cell, N)
    assert b[r, c] * player < 0, "돌리기는 상대 타일만 가능"
    assert direction(b[r, c]) != new_dir, "원래 방향으로는 돌릴 수 없음"
    b[r, c] = -player * (new_dir + 1)                 # 1) 돌리기
    pr, pc = r + DIRS[nd][0], c + DIRS[nd][1]
    assert b[pr, pc] == 0, "빈 칸에만 놓을 수 있음"
    b[pr, pc] = player * (pd + 1)                     # 2) 놓기
    for fr, fc in capture_path(b, pr, pc, player):    # 3) 먹기 (방향 유지, 색만 뒤집힘)
        b[fr, fc] = -b[fr, fc]
    return b


def game_result(board, player):
    """종료 안 됐으면 0, 끝났으면 player 기준 1 / -1 / 1e-4(무승부)."""
    full = tile_count(board) >= TOTAL_TILES
    if not full and (has_move(board, player) or has_move(board, -player)):
        return 0
    score = int(np.sign(board).sum()) * player
    if score > 0:
        return 1
    if score < 0:
        return -1
    return 1e-4


def action_to_str(action):
    if action == PASS_ACTION:
        return "PASS"
    cell, new_dir, nd, pd = decode_action(action)
    r, c = divmod(cell, N)
    pr, pc = r + DIRS[nd][0], c + DIRS[nd][1]
    return f"rotate ({r},{c})->{ARROWS[new_dir]}  place ({pr},{pc}){ARROWS[pd]}"


def board_to_str(board, green_first=True):
    """터미널 출력. 대문자 G=초록(+1), 소문자 b=갈색(-1)."""
    lines = ["    " + " ".join(f" {c} " for c in range(N))]
    for r in range(N):
        row = []
        for c in range(N):
            v = board[r, c]
            if v == 0:
                row.append(" . ")
            else:
                tag = "G" if v > 0 else "b"
                row.append(f"{tag}{ARROWS[direction(v)]} ")
        lines.append(f" {r}  " + " ".join(row))
    g = int((board > 0).sum())
    br = int((board < 0).sum())
    lines.append(f"  초록(G) {g}  :  갈색(b) {br}   [{tile_count(board)}/25]")
    return "\n".join(lines)


# ---------------- 대칭(8가지: 회전 4 x 좌우반전 2) ----------------
def _build_symmetries():
    syms = []
    for flip in (False, True):
        for k in range(4):
            cell_map = np.zeros(NUM_CELLS, dtype=np.int64)
            for r in range(N):
                for c in range(N):
                    rr, cc = r, c
                    if flip:
                        cc = N - 1 - cc
                    for _ in range(k):          # np.rot90 (반시계): (r,c) -> (N-1-c, r)
                        rr, cc = N - 1 - cc, rr
                    cell_map[r * N + c] = rr * N + cc
            dir_map = np.zeros(4, dtype=np.int64)
            for d, (dr, dc) in enumerate(DIRS):
                vr, vc = dr, dc
                if flip:
                    vc = -vc
                for _ in range(k):              # 벡터 회전: (dr,dc) -> (-dc, dr)
                    vr, vc = -vc, vr
                dir_map[d] = DIRS.index((vr, vc))
            act_map = np.zeros(ACTION_SIZE, dtype=np.int64)
            for a in range(PASS_ACTION):
                cell, nd_, nb, pd = decode_action(a)
                act_map[a] = encode_action(cell_map[cell], dir_map[nd_], dir_map[nb], dir_map[pd])
            act_map[PASS_ACTION] = PASS_ACTION
            syms.append((cell_map, dir_map, act_map))
    return syms


SYMMETRIES = _build_symmetries()


def transform_board(board, sym):
    cell_map, dir_map, _ = sym
    out = np.zeros(NUM_CELLS, dtype=board.dtype)
    flat = board.reshape(-1)
    for i in np.nonzero(flat)[0]:
        v = flat[i]
        out[cell_map[i]] = np.sign(v) * (dir_map[direction(v)] + 1)
    return out.reshape(N, N)


def transform_pi(pi, sym):
    act_map = sym[2]
    out = np.zeros(ACTION_SIZE, dtype=np.float64)
    out[act_map] = np.asarray(pi)
    return out
