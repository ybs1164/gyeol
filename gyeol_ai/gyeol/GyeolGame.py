import numpy as np

from Game import Game
from gyeol import GyeolLogic as L


class GyeolGame(Game):
    """alpha-zero-general 의 Game 인터페이스에 맞춘 결(GYEOL)."""

    def getInitBoard(self):
        return L.initial_board()

    def getBoardSize(self):
        return (L.N, L.N)

    def getActionSize(self):
        return L.ACTION_SIZE

    def getNextState(self, board, player, action):
        return L.apply_move(board, player, action), -player

    def getValidMoves(self, board, player):
        return L.valid_vector(board, player)

    def getGameEnded(self, board, player):
        return L.game_result(board, player)

    def getCanonicalForm(self, board, player):
        return (board * player).astype(np.int8)

    def getSymmetries(self, board, pi):
        return [(L.transform_board(board, s), L.transform_pi(pi, s)) for s in L.SYMMETRIES]

    def stringRepresentation(self, board):
        return board.tobytes()

    @staticmethod
    def display(board):
        print(L.board_to_str(board))
