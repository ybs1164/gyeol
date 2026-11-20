"""Train facing with learned initial placements from any working directory."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import logging
from pathlib import Path
import random

from facing_free_game import FacingFreeStartGame, ROOT
from facing_free_net import FacingFreeStartNet
from free_coach import FreeStartCoach
import numpy as np
import torch
from utils import dotdict

HERE = Path(__file__).resolve().parent


def settings(folder):
    spec = importlib.util.spec_from_file_location('facing_free_training_settings', ROOT / 'main.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config = dotdict(module.args.copy())
    config.update(checkpoint=str(folder), load_folder_file=(str(folder), 'best.pth.tar'),
                  tempThreshold=10)
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hours', type=float, default=5)
    parser.add_argument('--iterations', type=int, default=1000)
    parser.add_argument('--games', type=int, default=100)
    parser.add_argument('--sims', type=int, default=100)
    parser.add_argument('--seed', type=int, default=20261024)
    parser.add_argument('--checkpoint', type=Path, default=HERE / 'temp')
    parser.add_argument('--init-from', type=Path, help='Regular facing weights for a new checkpoint folder')
    parser.add_argument('--from-scratch', action='store_true')
    parser.add_argument('--init-only', action='store_true', help='Initialize or validate checkpoint without training')
    opts = parser.parse_args()
    if (not np.isfinite(opts.hours) or opts.hours < 0 or opts.iterations < 1
            or opts.games < 4 or opts.sims < 2):
        parser.error('finite hours >= 0, iterations >= 1, games >= 4, sims >= 2 required')
    if opts.from_scratch and opts.init_from:
        parser.error('--from-scratch and --init-from are mutually exclusive')
    folder = opts.checkpoint.resolve()
    best = folder / 'best.pth.tar'
    if best.exists() and (opts.from_scratch or opts.init_from):
        parser.error('Checkpoint already exists; choose a new --checkpoint folder for initialization')
    source = opts.init_from or ROOT / 'facing/temp/best.pth.tar'
    if not best.exists() and not opts.from_scratch and not source.is_file():
        parser.error(f'Facing checkpoint missing: {source}; use --init-from or --from-scratch')
    random.seed(opts.seed)
    np.random.seed(opts.seed)
    torch.manual_seed(opts.seed)
    game = FacingFreeStartGame()
    net = FacingFreeStartNet(game)
    folder.mkdir(parents=True, exist_ok=True)
    if best.exists():
        net.load_checkpoint(str(folder), best.name)
    else:
        metadata = dict(method='random initialization', setup_trained=False)
        if not opts.from_scratch:
            metadata = net.initialize_from_facing(source)
        metadata.update(created_utc=datetime.now(timezone.utc).isoformat(), rule='facing-free-start',
                        action_size=game.getActionSize(), seed=opts.seed)
        net.save_checkpoint(str(folder), best.name)
        (folder / 'initialization.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    if opts.init_only:
        print(f'Ready: {best} (actions={game.getActionSize()})')
        return
    config = settings(folder)
    config.update(timeLimitHours=opts.hours, numIters=opts.iterations,
                  numEps=opts.games, numMCTSSims=opts.sims, seed=opts.seed)
    config.fixedValGames = min(config.fixedValGames, max(0, opts.games - 4))
    coach = FreeStartCoach(game, net, config)
    coach.loadTrainExamples()
    logging.info('Facing free-start training: %s (actions=%d)', folder, game.getActionSize())
    coach.learn()


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    main()
