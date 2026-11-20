"""
학습된 모델과 대국 / 모델 평가.
  python pit.py                      # 사람(초록, 선공) vs AI
  python pit.py --human-second       # AI(초록, 선공) vs 사람
  python pit.py --vs random -n 40    # AI vs 랜덤 40판
  python pit.py --vs greedy -n 40    # AI vs 탐욕 40판
"""
import argparse

import numpy as np

from Arena import Arena
from MCTS import MCTS
from gyeol.GyeolGame import GyeolGame
from gyeol.GyeolPlayers import GreedyPlayer, HumanPlayer, RandomPlayer
from gyeol.pytorch.NNet import NNetWrapper
from utils import dotdict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='./temp/best.pth.tar')
    ap.add_argument('--sims', type=int, default=200)
    ap.add_argument('--vs', choices=['human', 'random', 'greedy'], default='human')
    ap.add_argument('--human-second', action='store_true')
    ap.add_argument('-n', type=int, default=2, help='대국 수 (human 제외)')
    opt = ap.parse_args()

    g = GyeolGame()
    net = NNetWrapper(g)
    folder, filename = opt.model.replace('\\', '/').rsplit('/', 1)
    net.load_checkpoint(folder, filename)
    mcts = MCTS(g, net, dotdict({'numMCTSSims': opt.sims, 'cpuct': 1.5, 'dirichletAlpha': 0}))
    ai = lambda x: int(np.argmax(mcts.getActionProb(x, temp=0)))

    if opt.vs == 'human':
        human = HumanPlayer(g).play
        p1, p2 = (ai, human) if opt.human_second else (human, ai)
        arena = Arena(p1, p2, g, display=GyeolGame.display)
        r = arena.playGame(verbose=True)
        print("초록(선공) 승리" if r == 1 else "갈색(후공) 승리" if r == -1 else "무승부")
        return

    other = RandomPlayer(g).play if opt.vs == 'random' else GreedyPlayer(g).play
    arena = Arena(ai, other, g, display=GyeolGame.display)
    ai_w, other_w, d = arena.playGames(opt.n)
    print(f"AI {ai_w}승 / {opt.vs} {other_w}승 / 무 {d}")


if __name__ == '__main__':
    main()
