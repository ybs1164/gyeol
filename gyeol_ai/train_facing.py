"""Train the facing-tile variant independently: python train_facing.py."""
import argparse
import logging
from pathlib import Path
import random

import numpy as np
import torch

from Coach import Coach
from main import args as baseline_args
from facing.rules import FacingGame
from facing.network import FacingNet
from utils import dotdict


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hours', type=float, default=5)
    parser.add_argument('--iterations', type=int, default=1000)
    parser.add_argument('--games', type=int, default=100)
    parser.add_argument('--sims', type=int, default=100)
    parser.add_argument('--seed', type=int, default=20261021)
    opts = parser.parse_args()
    if (not np.isfinite(opts.hours) or opts.hours < 0 or opts.iterations < 1
            or opts.games < 4 or opts.sims < 2):
        parser.error('Require finite hours >= 0, iterations >= 1, games >= 4, sims >= 2')
    folder = Path(__file__).resolve().parent / 'facing' / 'temp'
    args = dotdict(baseline_args.copy())
    args.update(checkpoint=str(folder), load_folder_file=(str(folder), 'best.pth.tar'),
                timeLimitHours=opts.hours, numIters=opts.iterations,
                numEps=opts.games, numMCTSSims=opts.sims, seed=opts.seed)
    args.fixedValGames = min(args.fixedValGames, max(0, opts.games - 4))
    random.seed(opts.seed)
    np.random.seed(opts.seed)
    torch.manual_seed(opts.seed)
    game = FacingGame()
    net = FacingNet(game)
    folder.mkdir(parents=True, exist_ok=True)
    if (folder / 'best.pth.tar').exists():
        net.load_checkpoint(str(folder), 'best.pth.tar')
    else:
        net.save_checkpoint(str(folder), 'best.pth.tar')
    coach = Coach(game, net, args)
    coach.loadTrainExamples()
    logging.info('Facing-rule training: %s (actions=%d)', folder, game.getActionSize())
    coach.learn()


if __name__ == '__main__':
    main()
