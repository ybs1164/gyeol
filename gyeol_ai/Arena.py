import logging

from tqdm import tqdm

log = logging.getLogger(__name__)


class Arena():
    """두 플레이어(함수: board -> action)를 대국시킨다."""

    def __init__(self, player1, player2, game, display=None, reset_players=None):
        self.player1 = player1
        self.player2 = player2
        self.game = game
        self.display = display
        self.reset_players = reset_players
        self.game_records = []

    def playGame(self, verbose=False, opening=()):
        if self.reset_players is not None:
            self.reset_players()
        actions = []
        players = [self.player2, None, self.player1]
        curPlayer = 1
        board = self.game.getInitBoard()
        for action in opening:
            if self.game.getGameEnded(board, curPlayer) != 0:
                raise ValueError('Opening must end at a nonterminal position')
            if not self.game.getValidMoves(board, curPlayer)[action]:
                raise ValueError('Illegal opening move')
            board, curPlayer = self.game.getNextState(board, curPlayer, action)
        if self.game.getGameEnded(board, curPlayer) != 0:
            raise ValueError('Opening must end at a nonterminal position')
        it = 0
        while self.game.getGameEnded(board, curPlayer) == 0:
            it += 1
            if verbose:
                assert self.display
                print(f"\nTurn {it}  Player {'초록(G)' if curPlayer == 1 else '갈색(b)'}")
                self.display(board)
            action = players[curPlayer + 1](self.game.getCanonicalForm(board, curPlayer))
            valids = self.game.getValidMoves(self.game.getCanonicalForm(board, curPlayer), 1)
            if valids[action] == 0:
                log.error(f'Action {action} is not valid!')
                assert valids[action] > 0
            actions.append(int(action))
            board, curPlayer = self.game.getNextState(board, curPlayer, action)
        if verbose:
            assert self.display
            print(f"\nGame over: Turn {it}  Result {self.game.getGameEnded(board, 1)}")
            self.display(board)
        result = curPlayer * self.game.getGameEnded(board, curPlayer)
        self.game_records.append({'result': float(result), 'moves': it,
                                  'opening': list(opening), 'actions': actions})
        return result

    def playGames(self, num, verbose=False, openings=None):
        if num <= 0 or num % 2:
            raise ValueError('arena games must be a positive even number')
        self.game_records = []
        num = int(num / 2)
        if openings is None:
            openings = [()] * num
        if len(openings) != num:
            raise ValueError('One opening is required per color-swapped pair')
        oneWon = twoWon = draws = 0
        for opening in tqdm(openings, desc="Arena.playGames (1)"):
            r = self.playGame(verbose=verbose, opening=opening)
            if r == 1:
                oneWon += 1
            elif r == -1:
                twoWon += 1
            else:
                draws += 1

        self.player1, self.player2 = self.player2, self.player1

        for opening in tqdm(openings, desc="Arena.playGames (2)"):
            r = self.playGame(verbose=verbose, opening=opening)
            if r == -1:
                oneWon += 1
            elif r == 1:
                twoWon += 1
            else:
                draws += 1

        self.player1, self.player2 = self.player2, self.player1
        return oneWon, twoWon, draws
