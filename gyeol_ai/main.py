"""결(GYEOL) AlphaZero 학습.   실행: python main.py

한 번 실행하면 약 5시간(timeLimitHours) 학습하고 종료한다.
다시 실행하면 ./temp/best.pth.tar 와 학습 데이터를 불러오고, 새 자가대국부터 이어서 학습한다.
"""
import logging
import os
import random
import numpy as np
import torch

from Coach import Coach
from gyeol.GyeolGame import GyeolGame as Game
from gyeol.pytorch.NNet import NNetWrapper as nn
from utils import dotdict

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

args = dotdict({
    'seed': 20261016,
    'fixedValGames': 10,
    'validationSuiteGames': 100, # 여러 반복에서 영구 보류한 대국 (자가대국/랜덤 상대)
    'validationAddGames': 3,    # 반복마다 자가대국 3판 + 랜덤 상대 선후공 각 1판
    'arenaOpeningMoves': 8,    # 서로 다른 2~8수 시작 국면에서 선후공 교환
    'timeLimitHours': 5,        # 실행 1회당 학습 시간. 다음 반복이 이 시간을 넘길 것 같으면 시작하지 않고 종료
    'numIters': 1000,           # 상한 (실제로는 시간 제한으로 끝남)
    'numEps': 100,              # 반복당 자가대국 수 (판이 많을수록 가치 헤드가 외우기 어려워진다)
    'valFraction': 0.1,         # 이번 반복 대국 중 검증용으로 떼어 둘 비율
    'tempThreshold': 8,         # 이 수 이전까지는 방문 비율대로 탐험적으로 둔다
    'updateThreshold': 0.55,    # 새 모델이 이 승률 이상이면 교체
    'maxlenOfQueue': 200000,
    'numMCTSSims': 100,         # 한 수당 MCTS 시뮬레이션
    'arenaCompare': 40,
    'cpuct': 1.5,
    'dirichletAlpha': 0.3,      # 자가대국 루트 노이즈 (0 이면 끔)
    'dirichletEps': 0.25,

    'checkpoint': './temp/',
    'load_model': 'auto',       # 'auto' = best.pth.tar 가 있으면 이어서 학습
    'load_folder_file': ('./temp/', 'best.pth.tar'),
    'numItersForTrainExamplesHistory': 10,
})


def main():
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    g = Game()
    nnet = nn(g)

    if args.load_model == 'auto':
        args.load_model = os.path.isfile(os.path.join(*args.load_folder_file))

    if args.load_model:
        log.info('Loading checkpoint "%s/%s"...', *args.load_folder_file)
        nnet.load_checkpoint(args.load_folder_file[0], args.load_folder_file[1])

    c = Coach(g, nnet, args)
    if args.load_model:
        c.loadTrainExamples()

    log.info('Starting the learning process 🎉')
    c.learn()


if __name__ == "__main__":
    main()
