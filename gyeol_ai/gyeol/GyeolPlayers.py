import numpy as np

from gyeol import GyeolLogic as L


class RandomPlayer():
    def __init__(self, game):
        self.game = game

    def play(self, board):
        valids = self.game.getValidMoves(board, 1)
        return int(np.random.choice(np.flatnonzero(valids)))


class GreedyPlayer():
    """한 수 뒤 내 타일 수가 가장 많아지는 수를 고른다(정규형 기준 내 타일 = 양수)."""

    def __init__(self, game):
        self.game = game

    def play(self, board):
        valids = np.flatnonzero(self.game.getValidMoves(board, 1))
        scores = []
        for a in valids:
            nb, _ = self.game.getNextState(board, 1, a)
            scores.append(int(np.sign(nb).sum()))
        scores = np.array(scores)
        return int(np.random.choice(valids[scores == scores.max()]))


class HumanPlayer():
    """
    입력 형식:  r c 새방향  놓을r 놓을c 놓을방향
      예) 3 3 N 3 4 E   → (3,3)의 상대 타일을 북쪽으로 돌리고, (3,4)에 동쪽을 보는 내 타일을 놓기
    방향: N/E/S/W (또는 U/R/D/L)
    """
    DIR_KEYS = {'N': 0, 'U': 0, 'E': 1, 'R': 1, 'S': 2, 'D': 2, 'W': 3, 'L': 3}

    def __init__(self, game):
        self.game = game

    def play(self, board):
        valids = self.game.getValidMoves(board, 1)
        print("\n[내 시점: G = 나, b = 상대]")
        print(L.board_to_str(board))
        if valids[L.PASS_ACTION]:
            input("둘 수 있는 수가 없어 패스합니다. [Enter]")
            return L.PASS_ACTION
        while True:
            try:
                tok = input("수 입력 (r c 새방향 r c 방향): ").split()
                r, c = int(tok[0]), int(tok[1])
                nd = self.DIR_KEYS[tok[2].upper()]
                pr, pc = int(tok[3]), int(tok[4])
                pd = self.DIR_KEYS[tok[5].upper()]
                nb = L.DIRS.index((pr - r, pc - c))
                a = L.encode_action(r * L.N + c, nd, nb, pd)
                if valids[a]:
                    return a
            except (ValueError, IndexError, KeyError):
                pass
            print("올바르지 않은 수입니다. 다시 입력하세요.")
