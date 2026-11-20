"""Independent action space; placement direction is always toward the pivot."""
import numpy as np

from gyeol import GyeolLogic as base
from gyeol.GyeolGame import GyeolGame

PASS_ACTION = base.NUM_CELLS * 16
ACTION_SIZE = PASS_ACTION + 1


def encode_action(cell, new_dir, neighbor_dir):
    return (cell * 4 + new_dir) * 4 + neighbor_dir


def decode_action(action):
    pivot, neighbor_dir = divmod(int(action), 4)
    cell, new_dir = divmod(pivot, 4)
    return cell, new_dir, neighbor_dir


def base_action(action):
    if action == PASS_ACTION:
        return base.PASS_ACTION
    cell, new_dir, neighbor_dir = decode_action(action)
    return base.encode_action(cell, new_dir, neighbor_dir, (neighbor_dir + 2) % 4)


def legal_moves(board, player):
    moves = []
    ok = base.placeable_mask(board)
    for r, c in zip(*np.where(board * player < 0)):
        for nd, (dr, dc) in enumerate(base.DIRS):
            pr, pc = r + dr, c + dc
            if 0 <= pr < base.N and 0 <= pc < base.N and ok[pr, pc]:
                for new_dir in range(4):
                    if new_dir != base.direction(board[r, c]):
                        moves.append(encode_action(r * base.N + c, new_dir, nd))
    return moves


def valid_vector(board, player):
    valid = np.zeros(ACTION_SIZE, dtype=np.uint8)
    valid[legal_moves(board, player) or [PASS_ACTION]] = 1
    return valid


def apply_move(board, player, action):
    action = int(action)
    if not 0 <= action < ACTION_SIZE or not valid_vector(board, player)[action]:
        raise ValueError('Illegal facing-rule action')
    return base.apply_move(board, player, base_action(action))


def symmetry_map(sym):
    cells, directions, _ = sym
    result = np.empty(ACTION_SIZE, dtype=np.int64)
    for action in range(PASS_ACTION):
        cell, new_dir, nd = decode_action(action)
        result[action] = encode_action(cells[cell], directions[new_dir], directions[nd])
    result[PASS_ACTION] = PASS_ACTION
    return result


SYMMETRY_MAPS = [symmetry_map(sym) for sym in base.SYMMETRIES]


class FacingGame(GyeolGame):
    def getActionSize(self):
        return ACTION_SIZE

    def getValidMoves(self, board, player):
        return valid_vector(board, player)

    def getNextState(self, board, player, action):
        return apply_move(board, player, action), -player

    def getSymmetries(self, board, pi):
        result = []
        for sym, mapping in zip(base.SYMMETRIES, SYMMETRY_MAPS):
            transformed = np.zeros(ACTION_SIZE, dtype=np.float64)
            transformed[mapping] = pi
            result.append((base.transform_board(board, sym), transformed))
        return result
