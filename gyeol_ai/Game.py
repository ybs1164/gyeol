class Game():
    """
    alpha-zero-general (github.com/suragnair/alpha-zero-general) 의 Game 인터페이스.
    player: 1 또는 -1. 정규형(canonical form)은 항상 player=1 시점이다.
    """

    def getInitBoard(self):
        raise NotImplementedError

    def getBoardSize(self):
        raise NotImplementedError

    def getActionSize(self):
        raise NotImplementedError

    def getNextState(self, board, player, action):
        """(nextBoard, nextPlayer) 반환"""
        raise NotImplementedError

    def getValidMoves(self, board, player):
        """길이 getActionSize() 의 0/1 벡터"""
        raise NotImplementedError

    def getGameEnded(self, board, player):
        """진행 중 0, player 승 1, 패 -1, 무승부는 작은 양수"""
        raise NotImplementedError

    def getCanonicalForm(self, board, player):
        raise NotImplementedError

    def getSymmetries(self, board, pi):
        """[(board, pi)] 대칭 데이터 리스트"""
        raise NotImplementedError

    def stringRepresentation(self, board):
        raise NotImplementedError
