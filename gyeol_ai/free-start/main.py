"""Run independent free-start training from any working directory."""
import argparse
import importlib.util
import logging
from pathlib import Path
import random
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

import numpy as np
import torch
from utils import dotdict
from free_game import FreeStartGame
from free_net import FreeStartNet
from free_coach import FreeStartCoach


def settings():
    # Reuse the current baseline's defaults, without calling its main().
    spec = importlib.util.spec_from_file_location('baseline_training_settings', ROOT / 'main.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    args = dotdict(module.args.copy())
    folder = str(HERE / 'temp')
    args.update(checkpoint=folder, load_folder_file=(folder, 'best.pth.tar'),
                tempThreshold=10)  # two setup choices plus seven regular exploratory turns
    return args


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hours', type=float, default=5)
    parser.add_argument('--iterations', type=int, default=1000)
    parser.add_argument('--games', type=int, default=100)
    parser.add_argument('--sims', type=int, default=100)
    parser.add_argument('--seed', type=int, default=20261020)
    opts = parser.parse_args()
    if opts.hours < 0 or opts.iterations < 1 or opts.games < 4 or opts.sims < 2:
        parser.error('hours >= 0, iterations >= 1, games >= 4, sims >= 2 required')
    args = settings()
    args.update(timeLimitHours=opts.hours, numIters=opts.iterations,
                numEps=opts.games, numMCTSSims=opts.sims, seed=opts.seed)
    # Keep enough games for training and within-iteration validation in small runs.
    args.fixedValGames = min(args.fixedValGames, max(0, opts.games - 4))
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    game = FreeStartGame()
    net = FreeStartNet(game)
    folder = Path(args.checkpoint)
    folder.mkdir(parents=True, exist_ok=True)
    best = folder / 'best.pth.tar'
    if best.exists():
        net.load_checkpoint(str(folder), best.name)
    else:
        # Preserve the initial incumbent even if every first-run candidate loses.
        net.save_checkpoint(str(folder), best.name)
    coach = FreeStartCoach(game, net, args)
    coach.loadTrainExamples()
    logging.info('Free-start training: %s', folder)
    coach.learn()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    main()
