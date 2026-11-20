"""Two learned placements, then the original GYEOL rules."""
import numpy as np

from gyeol import GyeolLogic as L
from gyeol.GyeolGame import GyeolGame

RADIUS = L.LIMIT - 1
WIDTH = 2 * RADIUS + 1
SETUP_SIZE = WIDTH * WIDTH * 4
ACTION_SIZE = L.ACTION_SIZE + SETUP_SIZE


def placement(dr, dc, direction, offset=L.ACTION_SIZE):
    if not (-RADIUS <= dr <= RADIUS and -RADIUS <= dc <= RADIUS and 0 <= direction < 4):
        raise ValueError('Placement outside the setup action space')
    return offset + ((dr + RADIUS) * WIDTH + dc + RADIUS) * 4 + direction


def decode_placement(action, offset=L.ACTION_SIZE):
    index, direction = divmod(action - offset, 4)
    row, col = divmod(index, WIDTH)
    return row - RADIUS, col - RADIUS, direction


def setup_symmetry(sym):
    cell_map, dir_map, _ = sym
    center = L.N // 2
    origin = np.array(divmod(int(cell_map[center * L.N + center]), L.N))
    down = np.array(divmod(int(cell_map[(center + 1) * L.N + center]), L.N)) - origin
    right = np.array(divmod(int(cell_map[center * L.N + center + 1]), L.N)) - origin
    mapped = []
    for a in range(L.ACTION_SIZE, ACTION_SIZE):
        dr, dc, d = decode_placement(a)
        rr, cc = dr * down + dc * right
        mapped.append(placement(int(rr), int(cc), int(dir_map[d])))
    return np.array(mapped)


SETUP_MAPS = [setup_symmetry(sym) for sym in L.SYMMETRIES]


class FreeStartGame(GyeolGame):
    regular_action_size = L.ACTION_SIZE
    regular_symmetry_maps = [sym[2] for sym in L.SYMMETRIES]

    @classmethod
    def placement(cls, dr, dc, direction):
        return placement(dr, dc, direction, cls.regular_action_size)

    def getInitBoard(self):
        return np.zeros((L.N, L.N), dtype=np.int8)

    def getActionSize(self):
        return self.regular_action_size + SETUP_SIZE

    def getValidMoves(self, board, player):
        count = L.tile_count(board)
        valid = np.zeros(self.getActionSize(), dtype=np.uint8)
        if count >= 2:
            valid[:self.regular_action_size] = super().getValidMoves(board, player)
        elif count == 0:
            for d in range(4):
                valid[self.placement(0, 0, d)] = 1
        else:
            if np.any(board * player > 0):
                raise ValueError('The second placement belongs to the other player')
            valid[self.regular_action_size:] = 1
            center = self.placement(0, 0, 0)
            valid[center:center + 4] = 0
        return valid

    def getNextState(self, board, player, action):
        action = int(action)
        if L.tile_count(board) >= 2:
            if not 0 <= action < self.regular_action_size:
                raise ValueError('Setup is already complete')
            return super().getNextState(board, player, action)
        if not 0 <= action < self.getActionSize() or not self.getValidMoves(board, player)[action]:
            raise ValueError('Illegal initial placement')
        dr, dc, d = decode_placement(action, self.regular_action_size)
        out = np.zeros_like(board)
        if not board.any():
            out[L.N // 2, L.N // 2] = player * (d + 1)
        else:
            # Center the complete pair, including offsets of +/-4 which do not
            # fit beside a centered singleton on the internal 7x7 board.
            top = (L.N - abs(dr) - 1) // 2
            left = (L.N - abs(dc) - 1) // 2
            r, c = top - min(0, dr), left - min(0, dc)
            out[r, c] = board[board != 0][0]
            out[r + dr, c + dc] = player * (d + 1)
        return out, -player

    def getGameEnded(self, board, player):
        return 0 if L.tile_count(board) < 2 else super().getGameEnded(board, player)

    def getSymmetries(self, board, pi):
        pi = np.asarray(pi)
        result = []
        for sym, regular_map, setup_map in zip(L.SYMMETRIES, self.regular_symmetry_maps, SETUP_MAPS):
            transformed = np.zeros(self.getActionSize(), dtype=np.float64)
            transformed[regular_map] = pi[:self.regular_action_size]
            setup_map = setup_map - L.ACTION_SIZE + self.regular_action_size
            transformed[setup_map] = pi[self.regular_action_size:]
            result.append((L.transform_board(board, sym), transformed))
        return result
